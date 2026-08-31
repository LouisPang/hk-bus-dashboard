/**
 * app.js — Core event listeners, UI rendering, main init loop
 */

import {
  PRESET_TEST_LOCATION,
  normalizeProvider,
  normalizeServiceType,
  normalizeDirection,
  getProvider,
  getDistanceKm,
  estimateWalkMinutes,
  escapeHtml,
  formatDataAge,
  getCompanyColours,
  debounce,
  logDebug,
  extractData
} from './config.js';

import {
  savedRoutes,
  allStops,
  loadSavedRoutes,
  addSavedRoute,
  removeSavedRoute,
  isSavedRoute,
  getSavedRouteKey,
  getStopName,
  getStopInfo,
  initStops
} from './db.js';

import {
  fetchWeather,
  fetchKmbStopEta,
  fetchKmbRouteEta,
  fetchCtbStopEta,
  fetchCtbRouteEta,
  normalizeEtaItem,
  normalizeEtaRemark,
  updateLastUpdated,
  cancelQueuedEtaRequests,
  providerLiveStatus
} from './api.js';

const extractDataSafe = extractData;

import {
  initRainMap,
  fitRainMapToHK,
  updateRainUserMarker,
  setRainUserLocation,
  stopRainPlayback,
  fetchAndRenderRain,
  getRainMap,
  refreshRainHeatmap
} from './map.js';

// ── App state ──
let userLocation = null;
let locationSource = 'none';
let activeStopIds = [];
let nearbyStopIds = [];
let latestEtaResults = [];
let latestGeneratedTimestamps = new Set();
let currentTemp = '';
let currentStation = '';
let currentHumidity = '';
let currentPsr = '';
let currentMode = 'nearby';
let etaPollTimer = null;
let etaRefreshGeneration = 0;

// ── Meta / clock ──

function updateMetaText(statusMsg = '', weatherFields = null) {
  if (weatherFields) {
    if (weatherFields.currentStation != null)
      currentStation = weatherFields.currentStation;
    if (weatherFields.currentTemp != null)
      currentTemp = weatherFields.currentTemp;
    if (weatherFields.currentHumidity != null)
      currentHumidity = weatherFields.currentHumidity;
    if (weatherFields.currentPsr != null)
      currentPsr = weatherFields.currentPsr;
  }
  const parts = [];
  if (statusMsg) parts.push(statusMsg);
  if (currentStation) parts.push(currentStation);
  if (currentTemp) parts.push(currentTemp);
  if (currentHumidity) parts.push(currentHumidity);
  if (currentPsr) parts.push(currentPsr);

  const el = document.getElementById('meta-text');
  if (el && parts.length > 0) {
    el.textContent = parts.join(' • ');
  }
}

function applyLocation(lat, lng, sourceLabel) {
  userLocation = { lat, lng };
  locationSource = sourceLabel;
  logDebug(
    `Location updated: ${lat.toFixed(4)}, ${lng.toFixed(4)} (${sourceLabel})`
  );
  setRainUserLocation(userLocation);
}

function usePresetMongKokLocation(reason = '') {
  applyLocation(
    PRESET_TEST_LOCATION.lat,
    PRESET_TEST_LOCATION.lng,
    PRESET_TEST_LOCATION.label
  );
}

function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent =
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
setInterval(updateClock, 1000);
updateClock();

async function refreshWeather() {
  await fetchWeather({
    userLocation,
    currentMode,
    locationSource,
    updateMetaText
  });
}

// ── Mode / UI visibility ──

function updateSearchVisibility() {
  const searchContainer = document.getElementById('toolbar-search');
  const searchInput = document.getElementById('nearby-search');
  if (!searchContainer || !searchInput) return;

  const shouldShow = currentMode === 'nearby';
  searchContainer.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    searchInput.value = '';
  }
}

function updateRainMapVisibility() {
  const rainPanel = document.getElementById('rain-map-panel');
  if (!rainPanel) return;

  document.body.classList.toggle('mode-daily', currentMode === 'daily');

  if (currentMode === 'daily') {
    rainPanel.classList.remove('hidden');
    setTimeout(() => {
      if (!getRainMap()) initRainMap();
      fitRainMapToHK();
      updateRainUserMarker();
      refreshRainHeatmap();
    }, 80);
    setTimeout(() => {
      fitRainMapToHK();
      refreshRainHeatmap();
    }, 280);
  } else {
    rainPanel.classList.add('hidden');
    stopRainPlayback();
  }
}

function updateDebugPanelVisibility() {
  const debugEl = document.getElementById('debug-panel');
  const etaEl = document.getElementById('eta-container');
  if (!debugEl || !etaEl) return;

  if (currentMode === 'debug') {
    debugEl.classList.remove('hidden');
    etaEl.style.display = 'none';
    updateDebugPanel();
  } else {
    debugEl.classList.add('hidden');
    // Clear inline display so CSS controls layout:
    // nearby = flex column, daily = grid via .daily-columns
    etaEl.style.display = '';
  }
}

function updateDebugPanel() {
  const sysEl = document.getElementById('debug-system-info');
  if (sysEl) {
    sysEl.innerHTML = `
        <b>Current Mode:</b> ${currentMode}<br>
        <b>Location:</b> ${userLocation ? `${userLocation.lat}, ${userLocation.lng} (${locationSource})` : 'Not loaded'}<br>
        <b>Total Loaded Stops:</b> ${allStops.length}<br>
        <b>Active Stops:</b> ${activeStopIds.length}<br>
        <b>Nearby Stops:</b> ${nearbyStopIds.length}<br>
        <b>Saved Routes:</b> ${savedRoutes.length}<br>
        <b>KMB Live Status:</b> ${providerLiveStatus.kmb.state} (Err: ${providerLiveStatus.kmb.error || 'None'})<br>
        <b>CTB Live Status:</b> ${providerLiveStatus.ctb.state} (Err: ${providerLiveStatus.ctb.error || 'None'})
      `;
  }

  const etaJsonEl = document.getElementById('debug-eta-json');
  if (etaJsonEl) {
    etaJsonEl.textContent = JSON.stringify(latestEtaResults, null, 2);
  }
}

// Expose for inline onclick in HTML
window.updateDebugPanel = updateDebugPanel;

// ── Mode handlers ──

function attachModeHandlers() {
  document.querySelectorAll('.mode-button').forEach((button) => {
    button.addEventListener('click', async () => {
      const selectedMode = button.dataset.mode;
      if (selectedMode === currentMode) return;

      currentMode = selectedMode;
      document
        .querySelectorAll('.mode-button')
        .forEach((b) =>
          b.classList.toggle('active', b.dataset.mode === currentMode)
        );
      updateSearchVisibility();
      updateRainMapVisibility();
      updateDebugPanelVisibility();

      const etaContainerEl = document.getElementById('eta-container');
      if (etaContainerEl)
        etaContainerEl.classList.toggle(
          'daily-columns',
          currentMode === 'daily'
        );

      if (currentMode === 'daily') {
        if (savedRoutes.length > 0) {
          activeStopIds = [
            ...new Set(
              savedRoutes.map((item) => ({
                stopId: item.stopId,
                provider: item.provider || 'kmb'
              }))
            )
          ];
          updateMetaText('已儲存站點');
          startEtaLoop();
        } else {
          activeStopIds = [];
          stopEtaLoop();
          document.getElementById('eta-container').innerHTML =
            '<div class="status-msg">暫無已儲存路線。</div>';
          updateMetaText('已儲存站點');
        }
      } else if (currentMode === 'nearby') {
        await initNearbyStops();
        renderEtas(latestEtaResults, latestGeneratedTimestamps);
      }
    });
  });

  async function fetchCtbSearchRoute(routeQuery) {
    const q = String(routeQuery || '').trim().toUpperCase();
    if (!q || currentMode !== 'nearby') return;

    const nearbyCtbStops = nearbyStopIds
      .filter((s) => normalizeProvider(s.provider) === 'ctb')
      .slice()
      .sort(
        (a, b) =>
          (a.stopDistance ?? Infinity) - (b.stopDistance ?? Infinity)
      )
      .slice(0, 6);

    if (!nearbyCtbStops.length) return;

    const routeMap = {};
    const generated = new Set();

    const responses = await Promise.all(
      nearbyCtbStops.map(async (stop) => {
        try {
          const json = await fetchCtbRouteEta(stop.stopId, q);
          return {
            stop,
            json,
            items: extractDataSafe(json)
          };
        } catch (error) {
          return { stop, json: null, items: [] };
        }
      })
    );

    responses.forEach(({ stop, json, items }) => {
      if (json?.generated_timestamp) generated.add(json.generated_timestamp);

      if (!items || items.length === 0) {
        ensureStopInMap(routeMap, {
          stopId: stop.stopId,
          provider: 'ctb',
          route: q,
          dest: '預設方向',
          generatedTimestamp: json?.generated_timestamp || ''
        });
        return;
      }

      items.forEach((rawItem) => {
        const item = normalizeEtaItem(rawItem, {
          provider: 'ctb',
          stopId: stop.stopId,
          route: q,
          generatedTimestamp: json?.generated_timestamp || ''
        });

        if (normalizeProvider(item.provider) !== 'ctb') return;
        if (String(item.route || '').toUpperCase() !== q) return;
        addEtaRecord(routeMap, item, new Date());
      });
    });

    const ctbResults = Object.values(routeMap).map((r) => {
      r.etas.sort((a, b) => a.minutes - b.minutes);
      return r;
    });

    if (!ctbResults.length) return;

    const currentQuery = document
      .getElementById('nearby-search')
      ?.value.trim()
      .toUpperCase();
    if (currentMode !== 'nearby' || currentQuery !== q) return;

    const merged = [...latestEtaResults];
    const keys = new Set(
      merged.map(
        (r) =>
          `${normalizeProvider(r.provider)}|${r.stopId}|${r.route}|${r.dest}`
      )
    );

    ctbResults.forEach((r) => {
      const key = `${normalizeProvider(r.provider)}|${r.stopId}|${r.route}|${r.dest}`;
      if (!keys.has(key)) {
        merged.push(r);
        keys.add(key);
      } else {
        const idx = merged.findIndex(
          (x) =>
            `${normalizeProvider(x.provider)}|${x.stopId}|${x.route}|${x.dest}` ===
            key
        );
        if (idx >= 0) merged[idx] = r;
      }
    });

    latestEtaResults = merged;
    generated.forEach((ts) => latestGeneratedTimestamps.add(ts));
    renderEtas(latestEtaResults, latestGeneratedTimestamps);
  }

  const searchInput = document.getElementById('nearby-search');
  if (searchInput) {
    searchInput.addEventListener(
      'input',
      debounce(async (event) => {
        if (currentMode !== 'nearby') return;

        const value = event.target.value.trim().toUpperCase();

        renderEtas(latestEtaResults, latestGeneratedTimestamps);

        if (value) {
          const hasCtbMatch = latestEtaResults.some(
            (r) =>
              normalizeProvider(r.provider) === 'ctb' &&
              String(r.route || '').trim().toUpperCase() === value
          );

          if (!hasCtbMatch) {
            fetchCtbSearchRoute(value);
          }
        }
      }, 80)
    );
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    if (target.dataset.action === 'save-route') {
      addSavedRoute(
        target.dataset.route,
        target.dataset.dest,
        target.dataset.stop,
        target.dataset.provider || 'kmb',
        target.dataset.serviceType || 1,
        target.dataset.dir || ''
      );
      target.dataset.action = 'remove-saved-route';
      target.textContent = '★';
      target.classList.add('saved');
      return;
    }

    if (target.dataset.action === 'remove-saved-route') {
      removeSavedRoute(target.dataset.key);
      if (currentMode === 'daily') {
        activeStopIds = [
          ...new Set(
            savedRoutes.map((item) => ({
              stopId: item.stopId,
              provider: item.provider || 'kmb'
            }))
          )
        ];
        fetchEtas();
      } else {
        target.dataset.action = 'save-route';
        target.textContent = '☆';
        target.classList.remove('saved');
      }
    }
  });
}

// ── Location ──

function requestLocation() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      applyLocation(pos.coords.latitude, pos.coords.longitude, 'device');
      if (activeStopIds.length > 0) fetchEtas();
      refreshWeather();
    },
    (err) => {
      usePresetMongKokLocation(err?.message || 'geolocation failed');
      if (activeStopIds.length > 0) fetchEtas();
      refreshWeather();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function initNearbyStops() {
  if (allStops.length === 0) await initStops();

  if (!('geolocation' in navigator)) {
    usePresetMongKokLocation('browser does not support geolocation');
    onLocationSuccess(
      {
        coords: {
          latitude: PRESET_TEST_LOCATION.lat,
          longitude: PRESET_TEST_LOCATION.lng
        }
      },
      'preset-mong-kok'
    );
    return;
  }

  navigator.geolocation.getCurrentPosition(
    onLocationSuccess,
    onLocationError,
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function onLocationSuccess(position, source = 'device') {
  const userLat = position.coords.latitude;
  const userLong = position.coords.longitude;
  applyLocation(userLat, userLong, source);

  const nearbyStops = allStops.filter((stop) => {
    const lat = parseFloat(stop.lat);
    const lng = parseFloat(stop.long);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    return getDistanceKm(userLat, userLong, lat, lng) <= 0.3;
  });

  nearbyStopIds = nearbyStops.map((stop) => ({
    stopId: stop.stop,
    provider: stop.provider || 'kmb'
  }));
  activeStopIds = nearbyStopIds.slice();

  if (activeStopIds.length === 0) {
    document.getElementById('eta-container').innerHTML =
      '<div class="status-msg">300公尺範圍內沒有巴士站。</div>';
    updateMetaText('沒有附近站點');
    return;
  }

  updateMetaText(
    locationSource === 'preset-mong-kok'
      ? '旺角測試位置 (約300m)'
      : '附近站點 (約300m)'
  );
  startEtaLoop();
}

function onLocationError(error) {
  usePresetMongKokLocation(error?.message || 'location unavailable');
  onLocationSuccess(
    {
      coords: {
        latitude: PRESET_TEST_LOCATION.lat,
        longitude: PRESET_TEST_LOCATION.lng
      }
    },
    'preset-mong-kok'
  );
}

// ── ETA loop ──

function stopEtaLoop() {
  if (etaPollTimer) {
    clearInterval(etaPollTimer);
    etaPollTimer = null;
  }
}

function scheduleNextEtaPoll() {
  stopEtaLoop();
  if (!activeStopIds.length) return;
  etaPollTimer = setTimeout(async () => {
    await fetchEtas();
    scheduleNextEtaPoll();
  }, 20000);
}

async function startEtaLoop() {
  stopEtaLoop();
  const generation = ++etaRefreshGeneration;
  cancelQueuedEtaRequests();
  await fetchEtas(generation);
  if (generation === etaRefreshGeneration) scheduleNextEtaPoll();
}

function buildDailyTasks() {
  const tasks = [];
  const seen = new Set();
  savedRoutes.forEach((savedRoute) => {
    const provider = normalizeProvider(savedRoute.provider);
    const key = [
      provider,
      savedRoute.stopId,
      savedRoute.route,
      savedRoute.dest
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);

    tasks.push({
      mode: 'specific',
      provider,
      stopId: savedRoute.stopId,
      route: savedRoute.route,
      serviceType: normalizeServiceType(savedRoute.serviceType),
      dir: normalizeDirection(savedRoute.dir),
      dest: savedRoute.dest
    });
  });
  return tasks;
}

function ensureStopInMap(routeMap, meta) {
  const stopId = meta.stopId;
  const provider = normalizeProvider(meta.provider);
  const route = meta.route || '---';
  const destination = meta.dest || '站點服務';
  const key = [provider, stopId, route, destination].join('|');

  if (!routeMap[key]) {
    const stopLabel = getStopName(stopId, provider);
    const stopInfo = getStopInfo(stopId, provider);
    const stopDistance =
      userLocation && stopInfo
        ? getDistanceKm(
            userLocation.lat,
            userLocation.lng,
            parseFloat(stopInfo.lat),
            parseFloat(stopInfo.long)
          )
        : Number.POSITIVE_INFINITY;

    routeMap[key] = {
      route: route,
      dest: destination,
      stopId,
      provider,
      serviceType: meta.serviceType || 1,
      dir: meta.dir || '',
      stopName: stopLabel,
      stopDistance,
      generatedTimestamp: meta.generatedTimestamp || '',
      etas: []
    };
  }
  return routeMap[key];
}

function addEtaRecord(routeMap, item, now) {
  if (!item.route || !item.stop) return;

  const stopId = item.stop;
  const provider = normalizeProvider(item.provider);
  const destination = item.destination;

  const record = ensureStopInMap(routeMap, {
    stopId,
    provider,
    route: item.route,
    dest: destination,
    serviceType: item.serviceType,
    dir: item.dir,
    generatedTimestamp: item.generatedTimestamp
  });

  if (item.eta && String(item.eta).trim() !== '') {
    const etaTime = new Date(item.eta);
    const diffMins = Math.round((etaTime - now) / 60000);

    if (diffMins >= 0 && diffMins <= 180) {
      record.etas.push({
        minutes: diffMins,
        timestamp: item.eta,
        etaSeq: item.etaSeq,
        remark: normalizeEtaRemark(item.remark)
      });
    }
  }
}

async function fetchEtas(generation = etaRefreshGeneration) {
  if (!activeStopIds.length) return;

  logDebug(`Fetching ETAs for ${activeStopIds.length} stops...`);
  const routeMap = {};
  const now = new Date();
  const generatedTimestamps = new Set();

  if (currentMode === 'daily' && savedRoutes.length > 0) {
    const tasks = buildDailyTasks();
    const responses = await Promise.all(
      tasks.map(async (task) => {
        try {
          const json =
            normalizeProvider(task.provider) === 'ctb'
              ? await fetchCtbRouteEta(task.stopId, task.route)
              : await fetchKmbRouteEta(
                  task.stopId,
                  task.route,
                  task.serviceType
                );
          return { task, json, items: extractDataSafe(json) };
        } catch (error) {
          return { task, json: null, items: [] };
        }
      })
    );

    responses.forEach(({ task, json, items }) => {
      if (json?.generated_timestamp)
        generatedTimestamps.add(json.generated_timestamp);

      ensureStopInMap(routeMap, {
        stopId: task.stopId,
        provider: task.provider,
        route: task.route,
        dest: task.dest,
        serviceType: task.serviceType,
        dir: task.dir,
        generatedTimestamp: json?.generated_timestamp || ''
      });

      const savedMatches = savedRoutes.filter(
        (saved) =>
          saved.stopId === task.stopId &&
          normalizeProvider(saved.provider) ===
            normalizeProvider(task.provider) &&
          String(saved.route).toUpperCase() ===
            String(task.route).toUpperCase() &&
          normalizeServiceType(saved.serviceType) === task.serviceType
      );

      items.forEach((rawItem) => {
        const item = normalizeEtaItem(rawItem, {
          provider: normalizeProvider(task.provider),
          stopId: task.stopId,
          route: task.route,
          serviceType: task.serviceType,
          dir: task.dir,
          dest: task.dest,
          generatedTimestamp: json?.generated_timestamp || ''
        });

        if (
          normalizeProvider(item.provider) !== normalizeProvider(task.provider)
        )
          return;
        if (item.route.toUpperCase() !== String(task.route).toUpperCase())
          return;
        if (task.dir && item.dir && item.dir !== task.dir) return;

        const savedMatch = savedMatches.find((saved) =>
          normalizeProvider(task.provider) === 'ctb'
            ? true
            : saved.dir
              ? saved.dir === item.dir
              : true
        );
        if (!savedMatch) return;

        addEtaRecord(routeMap, item, now);
      });
    });
  } else {
    const stopTasks = [
      ...new Map(
        activeStopIds.map((item) => [
          `${normalizeProvider(item.provider)}|${item.stopId}`,
          { ...item, normProvider: normalizeProvider(item.provider) }
        ])
      ).values()
    ];

    const responses = await Promise.all(
      stopTasks.map(async (task) => {
        try {
          const json =
            task.normProvider === 'ctb'
              ? await fetchCtbStopEta(task.stopId)
              : await fetchKmbStopEta(task.stopId);

          return { task, json, items: extractDataSafe(json) };
        } catch (error) {
          return { task, json: null, items: [] };
        }
      })
    );

    responses.forEach(({ task, json, items }) => {
      if (json?.generated_timestamp)
        generatedTimestamps.add(json.generated_timestamp);

      ensureStopInMap(routeMap, {
        stopId: task.stopId,
        provider: task.normProvider,
        generatedTimestamp: json?.generated_timestamp || ''
      });

      items.forEach((rawItem) => {
        const item = normalizeEtaItem(rawItem, {
          provider: task.normProvider,
          stopId: task.stopId,
          generatedTimestamp: json?.generated_timestamp || ''
        });

        if (normalizeProvider(item.provider) !== task.normProvider) return;
        addEtaRecord(routeMap, item, now);
      });
    });
  }

  const groupedList = Object.values(routeMap)
    .filter((r) => !(r.route === '---' && r.etas.length === 0))
    .map((r) => {
      r.etas.sort((a, b) => a.minutes - b.minutes);
      return r;
    });

  if (generation !== etaRefreshGeneration) return;

  latestEtaResults = groupedList;
  latestGeneratedTimestamps = new Set(generatedTimestamps);

  logDebug(`ETAs fetched: ${groupedList.length} route records processed.`);
  renderEtas(latestEtaResults, latestGeneratedTimestamps);
  updateLastUpdated([
    ...new Set(groupedList.map((item) => item.provider))
  ]);
  if (currentMode === 'debug') updateDebugPanel();
}

function renderEtas(routes, generatedTimestamps = new Set()) {
  const container = document.getElementById('eta-container');
  const searchInput = document.getElementById('nearby-search');
  const searchQuery =
    currentMode === 'nearby' && searchInput
      ? searchInput.value.trim().toUpperCase()
      : '';

  if (searchQuery) {
    routes = routes.filter(
      (r) => String(r.route || '').trim().toUpperCase() === searchQuery
    );
  }

  if (routes.length === 0) {
    container.innerHTML = `<div class="status-msg">${searchQuery ? '沒有符合搜尋條件的巴士。' : '沒有即將到達的巴士。'}</div>`;
    return;
  }

  const stopsMap = new Map();

  routes.forEach((r) => {
    const stopId = r.stopId || 'unknown';
    const provider = normalizeProvider(r.provider);
    const stopKey = `${provider}|${stopId}`;

    if (!stopsMap.has(stopKey)) {
      stopsMap.set(stopKey, {
        stopId,
        provider,
        stopName: r.stopName || '站點資料未提供',
        stopDistance: r.stopDistance,
        items: []
      });
    }
    stopsMap.get(stopKey).items.push(r);
  });

  const sortedStops = [...stopsMap.values()].sort((a, b) => {
    const distA = Number.isFinite(a.stopDistance) ? a.stopDistance : Infinity;
    const distB = Number.isFinite(b.stopDistance) ? b.stopDistance : Infinity;

    if (distA !== distB) return distA - distB;

    if (currentMode === 'daily') {
      const indexA = savedRoutes.findIndex((item) => item.stopId === a.stopId);
      const indexB = savedRoutes.findIndex((item) => item.stopId === b.stopId);
      return (indexA !== -1 ? indexA : 999) - (indexB !== -1 ? indexB : 999);
    }

    return a.stopName.localeCompare(b.stopName, 'zh-HK');
  });

  container.innerHTML = sortedStops
    .map(({ stopId, stopName, stopDistance, items }) => {
      const walkMins = estimateWalkMinutes(stopDistance);
      const stopDistanceText = Number.isFinite(stopDistance)
        ? walkMins != null
          ? `${Math.round(stopDistance * 1000)}m (約${walkMins}分)`
          : `${Math.round(stopDistance * 1000)}m`
        : '站點';

      items.sort((a, b) => {
        const etaA = a.etas[0]?.minutes ?? 9999;
        const etaB = b.etas[0]?.minutes ?? 9999;
        if (etaA !== etaB) return etaA - etaB;
        return a.route.localeCompare(b.route, undefined, {
          numeric: true,
          sensitivity: 'base'
        });
      });

      const cardMarkup = items
        .map((r) => {
          const firstEta = r.etas[0]?.minutes;

          // First catchable ETA: soonest bus you can still walk to (eta >= walkMins)
          const catchableIndex =
            walkMins != null
              ? r.etas.findIndex((eta) => eta.minutes >= walkMins)
              : -1;

          const primaryEtaRemark = normalizeEtaRemark(r.etas[0]?.remark);
          const secondaryRemarks = r.etas
            .slice(1, 3)
            .map((eta, index) => ({
              label: eta.minutes,
              remark: normalizeEtaRemark(eta.remark),
              ordinal: index + 2
            }))
            .filter((item) => item.remark);

          let timeClass = 'safe';
          let displayTime =
            firstEta != null
              ? `${firstEta}<span class="unit">分</span>`
              : '暫無';
          let walkClass = '';
          let primaryCatchableClass = '';

          if (walkMins != null && firstEta != null) {
            // Both modes: one system — walk vs firstEta for number + card colour
            if (firstEta < walkMins) {
              timeClass = 'walk-miss';
              walkClass = 'walk-miss';
            } else if (firstEta <= walkMins + 2) {
              timeClass = 'walk-tight';
              walkClass = 'walk-tight';
            } else {
              timeClass = 'walk-ok';
              walkClass = 'walk-ok';
            }
            if (firstEta === 0) displayTime = '到站';
            if (catchableIndex === 0) primaryCatchableClass = 'catchable';
          } else if (firstEta == null) {
            timeClass = 'muted';
          } else if (firstEta === 0) {
            timeClass = 'due';
            displayTime = '到站';
          } else if (firstEta <= 3) {
            timeClass = 'urgent';
          } else if (firstEta <= 7) {
            timeClass = 'warning';
          }

          // Secondary ETAs (next 2); underline first catchable if it is among them
          const secondaryEtaParts = r.etas.slice(1, 3).map((eta, i) => {
            const absIndex = i + 1;
            const isCatchable = catchableIndex === absIndex;
            const cls = isCatchable ? 'catchable' : '';
            return `<span class="${cls}">${eta.minutes}分</span>`;
          });
          // Display order: later bus first (same as before), then nearer
          const nextEtasMarkup = secondaryEtaParts.length
            ? secondaryEtaParts.reverse().join(' | ')
            : '';

          const provider = r.provider || 'kmb';
          const isSaved = isSavedRoute(
            r.route,
            r.dest,
            stopId,
            provider,
            r.serviceType,
            r.dir
          );

          const action = isSaved ? 'remove-saved-route' : 'save-route';
          const starIcon = isSaved ? '★' : '☆';
          const savedClass = isSaved ? 'saved' : '';
          const key = getSavedRouteKey(
            r.route,
            r.dest,
            stopId,
            provider,
            r.serviceType,
            r.dir
          );

          const remarkMarkup = primaryEtaRemark
            ? `<div class="eta-remark" title="${escapeHtml(primaryEtaRemark)}">${escapeHtml(primaryEtaRemark)}</div>`
            : '';

          const secondaryRemarkMarkup = secondaryRemarks.length
            ? `<div class="eta-secondary-remark" title="${escapeHtml(secondaryRemarks.map((x) => `${x.label}分：${x.remark}`).join('；'))}">${escapeHtml(secondaryRemarks.map((x) => `${x.label}分：${x.remark}`).join('；'))}</div>`
            : '';

          return `
          <div class="eta-card ${walkClass}">
            <div class="route-info">
              <div class="route-badge" style="background:${getCompanyColours(provider)};" title="${escapeHtml(getProvider(provider).label)}">
                ${escapeHtml(r.route)}
              </div>
              <div class="destination-wrap">
                <div class="destination">${escapeHtml(r.dest)}</div>
              </div>
            </div>

            <div class="eta-times">
              <div class="eta-time-stack">
                ${nextEtasMarkup ? `<div class="eta-secondary">${nextEtasMarkup}</div>` : ''}
                <div class="eta-primary ${timeClass} ${primaryCatchableClass}">${displayTime}</div>
                ${secondaryRemarkMarkup}
              </div>
              <button
                class="save-route-btn ${savedClass}"
                data-action="${action}"
                data-key="${escapeHtml(key)}"
                data-route="${escapeHtml(r.route)}"
                data-dest="${escapeHtml(r.dest)}"
                data-stop="${escapeHtml(stopId)}"
                data-provider="${escapeHtml(provider)}"
                data-service-type="${escapeHtml(r.serviceType)}"
                data-dir="${escapeHtml(r.dir)}"
                title="${isSaved ? '取消儲存' : '儲存路線'}">
                ${starIcon}
              </button>
            </div>
            ${remarkMarkup}
          </div>
        `;
        })
        .join('');

      const timestampText = [...generatedTimestamps][0]
        ? `${formatDataAge([...generatedTimestamps][0])}`
        : '';

      const distanceTitle = walkMins != null
        ? '直線距離 + 城市步行節奏 (55m/分) + 升降機緩衝 2 分'
        : '';

      return `
        <div class="stop-group">
          <div class="stop-header">
            <div class="stop-header-title">${escapeHtml(stopName)}</div>
            <div class="stop-header-distance" title="${escapeHtml(distanceTitle)}">
              ${escapeHtml(stopDistanceText)}
              ${timestampText ? ` · ${escapeHtml(timestampText)}` : ''}
            </div>
          </div>
          <div class="stop-card-list">${cardMarkup}</div>
        </div>
      `;
    })
    .join('');
}

// ── Init ──

async function initDashboard() {
  loadSavedRoutes();
  attachModeHandlers();

  const etaContainerEl = document.getElementById('eta-container');
  if (etaContainerEl)
    etaContainerEl.classList.toggle('daily-columns', currentMode === 'daily');

  await initStops();
  requestLocation();

  if (currentMode === 'daily') {
    if (savedRoutes.length > 0) {
      activeStopIds = [
        ...new Set(
          savedRoutes.map((item) => ({
            stopId: item.stopId,
            provider: item.provider || 'kmb'
          }))
        )
      ];
      updateMetaText('已儲存站點');
      refreshWeather();
      startEtaLoop();
      return;
    }
    activeStopIds = [];
    document.getElementById('eta-container').innerHTML =
      '<div class="status-msg">暫無已儲存路線。</div>';
    updateMetaText('已儲存站點');
    return;
  }

  await initNearbyStops();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopEtaLoop();
  else if (activeStopIds.length) startEtaLoop();
});

updateSearchVisibility();
updateRainMapVisibility();
initDashboard();

refreshWeather();
setInterval(refreshWeather, 600000);

setTimeout(() => {
  initRainMap();
  fetchAndRenderRain();
}, 800);
setInterval(fetchAndRenderRain, 12 * 60 * 1000);
