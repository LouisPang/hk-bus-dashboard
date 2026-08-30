/**
 * api.js — HKO Weather, KMB, CTB API fetchers & request queue
 */

import {
  ETA_CACHE_TTL,
  REQUEST_CONCURRENCY,
  getProviderApiBase,
  normalizeProvider,
  normalizeServiceType,
  normalizeDirection,
  getProvider,
  getDistanceKm,
  formatProviderTime,
  formatClockTime,
  extractData,
  logDebug
} from './config.js';

// ── Request queue & cache ──
const etaCache = new Map();
const requestQueue = [];
let activeRequests = 0;

export const providerRefreshTimestamps = { kmb: null, lwb: null, ctb: null };

export const providerLiveStatus = {
  kmb: { state: 'idle', lastSuccess: null, lastAttempt: null, error: '' },
  ctb: { state: 'idle', lastSuccess: null, lastAttempt: null, error: '' }
};

let cachedHkoStations = null;

export function enqueueRequest(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    pumpRequestQueue();
  });
}

function pumpRequestQueue() {
  while (activeRequests < REQUEST_CONCURRENCY && requestQueue.length) {
    const item = requestQueue.shift();
    activeRequests++;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeRequests--;
        pumpRequestQueue();
      });
  }
}

export function cancelQueuedEtaRequests() {
  const pending = requestQueue.splice(0);
  pending.forEach((item) => {
    try {
      item.reject(new Error('ETA refresh superseded'));
    } catch (e) {}
  });
}

export async function fetchWithCache(url) {
  const cached = etaCache.get(url);
  if (cached && Date.now() - cached.timestamp < ETA_CACHE_TTL) return cached.json;
  const json = await enqueueRequest(() => fetchJson(url));
  etaCache.set(url, { timestamp: Date.now(), json });
  return json;
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ── Provider live status UI ──

export function setProviderLiveStatus(provider, state, extra = {}) {
  const key = provider === 'CTB' ? 'ctb' : 'kmb';
  Object.assign(providerLiveStatus[key], { state, ...extra });

  const el = document.getElementById(key === 'ctb' ? 'ctbStatus' : 'kmbStatus');
  if (!el) return;

  el.className =
    state === 'success'
      ? 'ok'
      : state === 'error'
        ? 'err'
        : state === 'loading'
          ? 'loading'
          : 'muted';
  if (state === 'success') {
    el.textContent = `${key === 'ctb' ? 'CTB' : 'KMB/LWB'} 更新 ${formatProviderTime(providerLiveStatus[key].lastSuccess)}`;
  } else if (state === 'error') {
    el.textContent = `${key === 'ctb' ? 'CTB' : 'KMB/LWB'} ✕ ${providerLiveStatus[key].error || 'API failed'}`;
    el.title = providerLiveStatus[key].error || '';
  } else if (state === 'loading') {
    el.textContent = `${key === 'ctb' ? 'CTB' : 'KMB/LWB'} 更新中…`;
  } else {
    el.textContent = `${key === 'ctb' ? 'CTB' : 'KMB/LWB'} 更新 --:--`;
  }
}

export function markProviderAttempt(provider) {
  setProviderLiveStatus(provider, 'loading', {
    lastAttempt: new Date(),
    error: ''
  });
}

export function markProviderSuccess(provider) {
  setProviderLiveStatus(provider, 'success', {
    lastSuccess: new Date(),
    error: ''
  });
}

export function markProviderError(provider, error) {
  const msg =
    error instanceof Error ? error.message : String(error || 'API failed');
  setProviderLiveStatus(provider, 'error', { error: msg.slice(0, 80) });
  logDebug(`[ERROR] ${provider} API failed: ${msg}`);
}

export async function fetchProviderJson(url, provider) {
  markProviderAttempt(provider);
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status} / invalid JSON`);
    }
    markProviderSuccess(provider);
    return json;
  } catch (err) {
    markProviderError(provider, err);
    throw err;
  }
}

export function markProviderRefresh(providerId) {
  const id = normalizeProvider(providerId);
  providerRefreshTimestamps[id] = Date.now();
  const ctbEl = document.getElementById('ctb-updated');
  if (ctbEl)
    ctbEl.textContent = `CTB 更新 ${formatClockTime(providerRefreshTimestamps.ctb, true)}`;
  const lastEl = document.getElementById('last-updated');
  if (lastEl) {
    const kmb = providerRefreshTimestamps.kmb;
    const lwb = providerRefreshTimestamps.lwb;
    const parts = [];
    if (kmb) parts.push(`KMB ${formatClockTime(kmb)}`);
    if (lwb) parts.push(`LWB ${formatClockTime(lwb)}`);
    lastEl.textContent = parts.length
      ? parts.join(' · ')
      : 'KMB/LWB 更新 --:--';
  }
}

export function updateLastUpdated(providerIds = ['kmb']) {
  const ids = Array.isArray(providerIds) ? providerIds : [providerIds];
  ids.forEach((id) => markProviderRefresh(id));
}

// ── KMB / CTB ETA endpoints ──

export async function fetchKmbStopEta(stopId) {
  const url = `${getProviderApiBase('kmb')}/stop-eta/${encodeURIComponent(stopId)}`;
  try {
    const json = await fetchWithCache(url);
    markProviderSuccess('KMB');
    return json;
  } catch (error) {
    markProviderError('KMB', error);
    return { data: [] };
  }
}

export async function fetchKmbRouteEta(stopId, route, serviceType = 1) {
  const safeRoute = encodeURIComponent(route);
  const safeServiceType = encodeURIComponent(normalizeServiceType(serviceType));
  const url = `${getProviderApiBase('kmb')}/eta/${encodeURIComponent(stopId)}/${safeRoute}/${safeServiceType}`;
  try {
    const json = await fetchWithCache(url);
    markProviderSuccess('KMB');
    return json;
  } catch (error) {
    markProviderError('KMB', error);
    return { data: [] };
  }
}

export async function fetchCtbStopEta(stopId) {
  const safeStop = encodeURIComponent(String(stopId).padStart(6, '0'));
  const url = `https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/${safeStop}?lang=zh-hant`;
  try {
    const json = await fetchProviderJson(url, 'CTB');
    markProviderRefresh('ctb');
    return json;
  } catch (error) {
    return { data: [] };
  }
}

export async function fetchCtbRouteEta(stopId, route) {
  const safeStop = encodeURIComponent(String(stopId).padStart(6, '0'));
  const safeRoute = encodeURIComponent(String(route).toUpperCase());
  const url = `https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${safeStop}/${safeRoute}`;
  try {
    const json = await fetchProviderJson(url, 'CTB');
    markProviderRefresh('ctb');
    return json;
  } catch (error) {
    return { data: [] };
  }
}

// ── ETA item helpers ──

export function normalizeEtaRemark(remark) {
  const text = String(remark || '').trim();
  return text.includes('慢') ? text : '';
}

export function normalizeEtaItem(item, fallback = {}) {
  return {
    co: item?.co || fallback.co || getProvider(fallback.provider).code,
    route: String(item?.route ?? fallback.route ?? ''),
    dir: normalizeDirection(item?.dir ?? fallback.dir),
    serviceType: normalizeServiceType(
      item?.service_type ?? fallback.serviceType
    ),
    seq: parseInt(item?.seq ?? fallback.seq, 10) || 0,
    stop: item?.stop || fallback.stopId,
    destination:
      item?.dest_tc || item?.dest_en || item?.dest || fallback.dest || '未知',
    eta: item?.eta || '',
    etaSeq: item?.eta_seq ?? null,
    remark: item?.rmk_tc || item?.rmk || item?.rmk_en || '',
    generatedTimestamp: fallback.generatedTimestamp || '',
    provider: normalizeProvider(item?.co || fallback.provider)
  };
}

// ── HKO Weather ──

async function getHkoStationCoordinates() {
  if (cachedHkoStations) return cachedHkoStations;
  try {
    const res = await fetch(
      'https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=CLIMSTAT&lang=tc'
    );
    const json = await res.json();

    if (Array.isArray(json)) {
      cachedHkoStations = json
        .map((stn) => ({
          name: stn.stationNameTC || stn.stationName || stn.name,
          lat: parseFloat(stn.latitude || stn.lat),
          lng: parseFloat(stn.longitude || stn.lng || stn.lon)
        }))
        .filter(
          (s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng)
        );
      return cachedHkoStations;
    }
  } catch (e) {
    console.warn(
      'Failed to dynamically fetch station list, using live payload matching fallback'
    );
  }
  return [];
}

function findClosestStationName(userLat, userLng, stationList) {
  if (!stationList || !stationList.length) return null;
  let closest = null;
  let minDistance = Infinity;

  stationList.forEach((stn) => {
    const dist = getDistanceKm(userLat, userLng, stn.lat, stn.lng);
    if (dist < minDistance) {
      minDistance = dist;
      closest = stn.name;
    }
  });

  return closest;
}

/**
 * Fetch weather and update DOM elements + return summary fields.
 * Caller supplies currentMode, locationSource, userLocation, and updateMetaText.
 */
export async function fetchWeather({
  userLocation,
  currentMode,
  locationSource,
  updateMetaText
}) {
  let currentTemp = '';
  let currentStation = '';
  let currentHumidity = '';
  let currentPsr = '';

  try {
    const base = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php';

    const [rhr, flw, warnsum, fnd] = await Promise.all([
      fetchJson(`${base}?dataType=rhrread&lang=tc`),
      fetchJson(`${base}?dataType=flw&lang=tc`),
      fetchJson(`${base}?dataType=warnsum&lang=tc`),
      fetchJson(`${base}?dataType=fnd&lang=tc`)
    ]);

    const tempDataList = rhr?.temperature?.data || [];
    let matchedTemp = null;
    currentStation = '';

    if (userLocation && tempDataList.length > 0) {
      const dynamicStations = await getHkoStationCoordinates();

      if (dynamicStations.length > 0) {
        const nearest = findClosestStationName(
          userLocation.lat,
          userLocation.lng,
          dynamicStations
        );
        const stnData = tempDataList.find((s) => s.place === nearest);
        if (stnData) {
          currentStation = stnData.place;
          matchedTemp = stnData.value;
        }
      }

      if (!matchedTemp) {
        currentStation = tempDataList[0]?.place || '';
        matchedTemp = tempDataList[0]?.value;
      }
    } else if (tempDataList.length > 0) {
      currentStation = tempDataList[0]?.place || '';
      matchedTemp = tempDataList[0]?.value;
    }

    currentTemp = Number.isFinite(Number(matchedTemp))
      ? `${matchedTemp}°C`
      : '';

    const humidityVal = rhr?.humidity?.data?.[0]?.value;
    currentHumidity = humidityVal ? ` ${humidityVal}%` : '';

    const todayForecast = fnd?.weatherForecast?.[0];
    currentPsr = todayForecast?.PSR
      ? `降雨概率 ${todayForecast.PSR}`
      : '';

    const locationLabel =
      currentMode === 'daily'
        ? '已儲存站點'
        : locationSource === 'preset-mong-kok'
          ? '旺角測試位置 (約300m)'
          : '附近站點 (約300m)';

    if (typeof updateMetaText === 'function') {
      updateMetaText(locationLabel, {
        currentStation,
        currentTemp,
        currentHumidity,
        currentPsr
      });
    }

    let warningNames = [];
    if (warnsum && typeof warnsum === 'object') {
      warningNames = Object.values(warnsum)
        .map((w) => w.name || w.code)
        .filter(Boolean);
    }

    const summaryEl = document.getElementById('weather-summary');
    const adviceEl = document.getElementById('weather-advice');
    const commuteContainer = document.getElementById('weather-commute');

    if (warningNames.length > 0) {
      if (summaryEl)
        summaryEl.textContent = `⚠️ 生效警告：${warningNames.join('、')}`;
      if (adviceEl)
        adviceEl.textContent =
          flw?.generalSituation ||
          '天氣變化不穩定，建議帶備雨具並留意交通狀況。';
      if (commuteContainer) commuteContainer.className = 'weather-commute alert';
    } else {
      const forecastDesc = flw?.forecastDesc || '天氣大致良好';
      if (summaryEl)
        summaryEl.textContent = `🌤️ ${forecastDesc.slice(0, 30)}...`;
      if (adviceEl) adviceEl.textContent = flw?.outlook || '適合出行';
      if (commuteContainer) commuteContainer.className = 'weather-commute good';
    }
  } catch (e) {
    console.error('Weather load error:', e);
    const summaryEl = document.getElementById('weather-summary');
    if (summaryEl) summaryEl.textContent = '☁️ 天氣資料暫時未能取得';
  }

  return { currentTemp, currentStation, currentHumidity, currentPsr };
}
