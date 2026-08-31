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
//
// CLIMSTAT is not a valid HKO open-data dataType (API rejects it).
// Station coords are fixed public HKO positions; names match rhrread
// temperature.place strings (Traditional Chinese).

const HKO_TEMP_STATIONS = [
  { name: '京士柏', lat: 22.3119, lng: 114.1728 },
  { name: '香港天文台', lat: 22.3019, lng: 114.1742 },
  { name: '黃竹坑', lat: 22.2478, lng: 114.1736 },
  { name: '打鼓嶺', lat: 22.5286, lng: 114.1567 },
  { name: '流浮山', lat: 22.4689, lng: 113.9836 },
  { name: '大埔', lat: 22.4461, lng: 114.1789 },
  { name: '沙田', lat: 22.4025, lng: 114.2097 },
  { name: '屯門', lat: 22.3906, lng: 113.9769 },
  { name: '將軍澳', lat: 22.3158, lng: 114.2558 },
  { name: '西貢', lat: 22.3756, lng: 114.2742 },
  { name: '長洲', lat: 22.2011, lng: 114.0267 },
  { name: '赤鱲角', lat: 22.3094, lng: 113.9219 },
  { name: '青衣', lat: 22.3478, lng: 114.1092 },
  { name: '石崗', lat: 22.4361, lng: 114.0847 },
  { name: '荃灣可觀', lat: 22.3839, lng: 114.1078 },
  { name: '荃灣城門谷', lat: 22.3758, lng: 114.1242 },
  { name: '香港公園', lat: 22.2778, lng: 114.1619 },
  { name: '筲箕灣', lat: 22.2817, lng: 114.2361 },
  { name: '九龍城', lat: 22.3350, lng: 114.1850 },
  { name: '跑馬地', lat: 22.2708, lng: 114.1836 },
  { name: '黃大仙', lat: 22.3422, lng: 114.1950 },
  { name: '赤柱', lat: 22.2139, lng: 114.2186 },
  { name: '觀塘', lat: 22.3186, lng: 114.2250 },
  { name: '深水埗', lat: 22.3358, lng: 114.1369 },
  { name: '啟德跑道公園', lat: 22.3097, lng: 114.2131 },
  { name: '元朗公園', lat: 22.4417, lng: 114.0222 },
  { name: '大美督', lat: 22.4750, lng: 114.2378 }
];

/**
 * Pick the temperature station nearest to the user.
 * Only considers stations that appear in the live rhrread payload.
 */
function findNearestTempReading(userLat, userLng, tempDataList) {
  if (!tempDataList?.length) return null;

  const liveByPlace = new Map(
    tempDataList.map((row) => [row.place, row])
  );

  let best = null;
  let bestDist = Infinity;

  for (const stn of HKO_TEMP_STATIONS) {
    const live = liveByPlace.get(stn.name);
    if (!live) continue;
    const dist = getDistanceKm(userLat, userLng, stn.lat, stn.lng);
    if (dist < bestDist) {
      bestDist = dist;
      best = { place: stn.name, value: live.value, distKm: bestDist };
    }
  }

  // Fallback: if names drifted, still return first live reading
  if (!best && tempDataList[0]) {
    return {
      place: tempDataList[0].place,
      value: tempDataList[0].value,
      distKm: null
    };
  }
  return best;
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
      const nearest = findNearestTempReading(
        userLocation.lat,
        userLocation.lng,
        tempDataList
      );
      if (nearest) {
        currentStation = nearest.place;
        matchedTemp = nearest.value;
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
      if (summaryEl) summaryEl.textContent = `🌤️ ${forecastDesc}`;
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
