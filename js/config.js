/**
 * config.js — Constants, storage keys, provider definitions
 */

export const STORAGE_KEY = 'hk-bus-dashboard.saved-routes';
export const ROUTE_DB_KEY = 'hk-bus-dashboard.route-db.v5';
export const ROUTE_DB_TTL = 86400000;
export const ETA_CACHE_TTL = 15000;
export const REQUEST_CONCURRENCY = 6;

export const CTB_ROUTE_STOP_DB_TTL = 24 * 60 * 60 * 1000;
export const CTB_STOP_CACHE_TTL = 24 * 60 * 60 * 1000;

export const STATIC_DB_NAME = 'hk-bus-dashboard-static';
export const STATIC_DB_VERSION = 1;
export const STATIC_DB_STORE = 'snapshots';
export const STATIC_SNAPSHOT_KEY = 'all-providers-v2';
export const STATIC_SNAPSHOT_TTL = 24 * 60 * 60 * 1000;

export const PRESET_TEST_LOCATION = {
  lat: 22.2193,
  lng: 114.3694,
  label: '旺角（測試位置）'
};

export const HK_BOUNDS = {
  minLat: 22.15,
  maxLat: 22.58,
  minLng: 113.83,
  maxLng: 114.44
};

export const HKO_RAINFALL_CSV_URL =
  'https://tight-meadow-e6e3.pangshuntak12493.workers.dev/rainfall';

export const PROVIDERS = {
  kmb: {
    id: 'kmb',
    code: 'KMB',
    label: 'KMB',
    api: 'https://data.etabus.gov.hk/v1/transport/kmb'
  },
  lwb: {
    id: 'lwb',
    code: 'LWB',
    label: 'LWB',
    api: 'https://data.etabus.gov.hk/v1/transport/kmb'
  },
  ctb: {
    id: 'ctb',
    code: 'CTB',
    label: 'CTB',
    api: 'https://rt.data.gov.hk/v2/transport/citybus'
  }
};

export function getProvider(providerId = 'kmb') {
  return PROVIDERS[providerId] || PROVIDERS.kmb;
}

export function normalizeProvider(value) {
  const code = String(value || '').toUpperCase();
  if (code === 'LWB') return 'lwb';
  if (code === 'CTB') return 'ctb';
  return 'kmb';
}

export function getProviderApiBase(providerId = 'kmb') {
  return getProvider(providerId).api;
}

export function normalizeServiceType(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 1;
}

export function normalizeDirection(value) {
  return String(value || '').toUpperCase();
}

export function getStopKey(stopId, provider = 'kmb') {
  return `${normalizeProvider(provider)}|${String(stopId).padStart(6, '0')}`;
}

export function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatDataAge(timestamp) {
  if (!timestamp) return '';
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  return `${Math.round(seconds / 60)}分鐘前`;
}

export function formatClockTime(timestamp, withSeconds = false) {
  if (!timestamp) return '--:--' + (withSeconds ? ':--' : '');
  const d = new Date(timestamp);
  if (!Number.isFinite(d.getTime())) return '--:--' + (withSeconds ? ':--' : '');
  return withSeconds
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatProviderTime(ts) {
  if (!ts) return '--:--';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('zh-HK', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

export function debounce(func, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => func(...args), delay);
  };
}

export function extractData(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  return Array.isArray(json.data) ? json.data : [];
}

export function getCompanyColours(providerIds) {
  const companyMap = { kmb: '#E31E25', lwb: '#2A8F9C', ctb: '#0055B8' };
  const list = Array.isArray(providerIds) ? providerIds : [providerIds || 'kmb'];
  const normalized = list
    .filter(Boolean)
    .map((id) => companyMap[normalizeProvider(id)] || companyMap.kmb);
  if (normalized.length === 1) return normalized[0];
  if (normalized.length >= 2)
    return `linear-gradient(90deg, ${normalized[0]} 0 50%, ${normalized[1]} 50% 100%)`;
  return companyMap.kmb;
}

// ── Debug log buffer ──
const debugLogs = [];

export function logDebug(msg) {
  const timestamp = new Date().toLocaleTimeString();
  debugLogs.unshift(`[${timestamp}] ${msg}`);
  if (debugLogs.length > 50) debugLogs.pop();
  const logEl = document.getElementById('debug-log-console');
  if (logEl) logEl.textContent = debugLogs.join('\n');
}

export function getDebugLogs() {
  return debugLogs;
}

