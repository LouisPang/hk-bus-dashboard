/**
 * db.js — IndexedDB & LocalStorage helpers
 */

import {
  STORAGE_KEY,
  ROUTE_DB_KEY,
  ROUTE_DB_TTL,
  STATIC_DB_NAME,
  STATIC_DB_VERSION,
  STATIC_DB_STORE,
  STATIC_SNAPSHOT_KEY,
  STATIC_SNAPSHOT_TTL,
  CTB_ROUTE_STOP_DB_TTL,
  normalizeProvider,
  normalizeServiceType,
  normalizeDirection,
  getProvider,
  getProviderApiBase,
  getStopKey,
  extractData,
  logDebug
} from './config.js';

import { fetchJson, fetchWithCache } from './api.js';

// ── Shared mutable state ──
export let savedRoutes = [];
export let routeDb = null;
export let allStops = [];
export let stopMetaMap = {};
export let ctbRouteStopLastLoadedAt = 0;
export let ctbStopInventoryCache = null;
export let ctbStopInventoryFetchedAt = 0;

let ctbRouteStopLoadPromise = null;
let ctbStopLoadPromise = null;
let staticDataLoadPromise = null;

export { logDebug };

// ── Saved routes (localStorage) ──

export function loadSavedRoutes() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    savedRoutes = data ? JSON.parse(data) : [];
    logDebug(`Loaded ${savedRoutes.length} saved routes.`);
  } catch (e) {
    savedRoutes = [];
  }
  return savedRoutes;
}

export function saveSavedRoutes() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedRoutes));
  } catch (e) {}
}

export function getSavedRouteKey(
  route,
  dest,
  stopId,
  provider = 'kmb',
  serviceType = 1,
  dir = ''
) {
  return [
    normalizeProvider(provider),
    stopId,
    String(route).toUpperCase(),
    dest,
    serviceType,
    dir
  ].join('|');
}

export function isSavedRoute(
  route,
  dest,
  stopId,
  provider = 'kmb',
  serviceType = 1,
  dir = ''
) {
  const key = getSavedRouteKey(route, dest, stopId, provider, serviceType, dir);
  return savedRoutes.some(
    (r) =>
      getSavedRouteKey(
        r.route,
        r.dest,
        r.stopId,
        r.provider,
        r.serviceType,
        r.dir
      ) === key
  );
}

export function addSavedRoute(
  route,
  dest,
  stopId,
  provider = 'kmb',
  serviceType = 1,
  dir = ''
) {
  if (!isSavedRoute(route, dest, stopId, provider, serviceType, dir)) {
    savedRoutes.push({
      route: String(route).toUpperCase(),
      dest,
      stopId,
      provider: normalizeProvider(provider),
      serviceType: normalizeServiceType(serviceType),
      dir: normalizeDirection(dir)
    });
    saveSavedRoutes();
  }
}

export function removeSavedRoute(key) {
  savedRoutes = savedRoutes.filter(
    (r) =>
      getSavedRouteKey(
        r.route,
        r.dest,
        r.stopId,
        r.provider,
        r.serviceType,
        r.dir
      ) !== key
  );
  saveSavedRoutes();
}

// ── Stop metadata ──

export function buildStopMetaMap() {
  stopMetaMap = {};
  allStops.forEach((stop) => {
    const id = stop.stop || stop.stop_id;
    if (!id) return;
    const key = getStopKey(id, stop.provider || stop.co);
    stopMetaMap[key] = {
      name: stop.name_tc || stop.name_en || stop.stop_name || '巴士站',
      lat: parseFloat(stop.lat),
      long: parseFloat(stop.long || stop.lng)
    };
  });
}

export function getStopName(stopId, provider = 'kmb') {
  const key = getStopKey(stopId, provider);
  return stopMetaMap[key]?.name || `站點 ${stopId}`;
}

export function getStopInfo(stopId, provider = 'kmb') {
  const key = getStopKey(stopId, provider);
  return stopMetaMap[key] || null;
}

// ── Route DB (localStorage cache) ──

export async function getOrFetchRouteDB() {
  if (routeDb) return routeDb;
  try {
    const cached = localStorage.getItem(ROUTE_DB_KEY);
    if (cached) {
      const { timestamp, data } = JSON.parse(cached);
      if (Date.now() - timestamp < ROUTE_DB_TTL && data) {
        routeDb = {
          kmb: data.kmb || {},
          lwb: data.lwb || {},
          ctb: data.ctb || {}
        };
        return routeDb;
      }
    }
  } catch (e) {}

  const db = { kmb: {}, lwb: {}, ctb: {} };
  try {
    const kmbJson = await fetchJson(`${getProviderApiBase('kmb')}/route-stop`);
    extractData(kmbJson).forEach((item) => {
      if (!item?.route || !item?.stop) return;
      const provider = normalizeProvider(item.co);
      const route = String(item.route).toUpperCase();
      if (!db[provider][route]) db[provider][route] = [];
      db[provider][route].push({
        route,
        stopId: String(item.stop),
        seq: parseInt(item.seq, 10) || 0,
        dir: normalizeDirection(item.dir || item.bound),
        serviceType: normalizeServiceType(item.service_type),
        provider,
        providerCode: getProvider(provider).code
      });
    });
  } catch (e) {}

  routeDb = db;
  try {
    localStorage.setItem(
      ROUTE_DB_KEY,
      JSON.stringify({ timestamp: Date.now(), data: db })
    );
  } catch (e) {}
  return routeDb;
}

export async function fetchCtbRouteStops(route) {
  const routeKey = String(route || '').trim().toUpperCase();
  if (!routeKey) return [];

  await getOrFetchRouteDB();
  if (routeDb.ctb[routeKey]?.length) return routeDb.ctb[routeKey];

  const results = [];
  for (const direction of ['inbound', 'outbound']) {
    try {
      const url = `https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/${encodeURIComponent(routeKey)}/${direction}`;
      const json = await fetchWithCache(url);
      extractData(json).forEach((item) => {
        if (!item?.route || !item?.stop) return;
        results.push({
          route: String(item.route).toUpperCase(),
          stopId: String(item.stop).padStart(6, '0'),
          seq: parseInt(item.seq, 10) || 0,
          dir: normalizeDirection(item.dir),
          serviceType: 1,
          provider: 'ctb',
          providerCode: 'CTB'
        });
      });
    } catch (e) {}
  }

  routeDb.ctb[routeKey] = results;
  try {
    localStorage.setItem(
      ROUTE_DB_KEY,
      JSON.stringify({ timestamp: Date.now(), data: routeDb })
    );
  } catch (e) {}
  return results;
}

export async function loadCtbRouteStopDatabase(force = false) {
  if (!force && ctbRouteStopLoadPromise) return ctbRouteStopLoadPromise;

  ctbRouteStopLoadPromise = (async () => {
    await getOrFetchRouteDB();
    if (
      !force &&
      ctbRouteStopLastLoadedAt &&
      Date.now() - ctbRouteStopLastLoadedAt < CTB_ROUTE_STOP_DB_TTL
    ) {
      return routeDb.ctb;
    }

    try {
      const cached = JSON.parse(localStorage.getItem(ROUTE_DB_KEY) || 'null');
      if (
        !force &&
        cached?.timestamp &&
        Date.now() - cached.timestamp < CTB_ROUTE_STOP_DB_TTL &&
        cached.data?.ctb &&
        Object.keys(cached.data.ctb).length
      ) {
        routeDb.ctb = cached.data.ctb;
        ctbRouteStopLastLoadedAt = cached.timestamp;
        return routeDb.ctb;
      }
    } catch (e) {}

    const routeJson = await fetchWithCache(
      'https://rt.data.gov.hk/v2/transport/citybus/route/CTB'
    );
    const routeRows = extractData(routeJson);
    const routes = [
      ...new Set(
        routeRows
          .map((x) => String(x.route || '').trim().toUpperCase())
          .filter(Boolean)
      )
    ];

    const nextIndex = { value: 0 };
    const worker = async () => {
      while (true) {
        const i = nextIndex.value++;
        if (i >= routes.length) return;
        await fetchCtbRouteStops(routes[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(6, routes.length) }, worker)
    );

    ctbRouteStopLastLoadedAt = Date.now();
    try {
      localStorage.setItem(
        ROUTE_DB_KEY,
        JSON.stringify({
          timestamp: ctbRouteStopLastLoadedAt,
          data: routeDb
        })
      );
    } catch (e) {}
    return routeDb.ctb;
  })();

  try {
    return await ctbRouteStopLoadPromise;
  } finally {
    ctbRouteStopLoadPromise = null;
  }
}

// ── Stop inventory fetchers ──

export async function fetchKmbStops() {
  try {
    const json = await fetchJson(`${getProviderApiBase('kmb')}/stop`);
    return extractData(json).map((stop) => ({
      ...stop,
      provider: normalizeProvider(stop.co)
    }));
  } catch (error) {
    return [];
  }
}

export async function fetchCtbStops(force = false) {
  if (
    !force &&
    ctbStopInventoryCache &&
    Date.now() - ctbStopInventoryFetchedAt < 24 * 60 * 60 * 1000
  ) {
    return ctbStopInventoryCache;
  }
  if (!force && ctbStopLoadPromise) return ctbStopLoadPromise;

  ctbStopLoadPromise = (async () => {
    try {
      await getOrFetchRouteDB();
      const ctbDb = routeDb?.ctb || {};
      const uniqueStopIds = [
        ...new Set(
          Object.values(ctbDb)
            .flat()
            .map((row) => String(row?.stopId || '').padStart(6, '0'))
            .filter(Boolean)
        )
      ];
      if (!uniqueStopIds.length) throw new Error('CTB Route-Stop cache empty');

      const results = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= uniqueStopIds.length) return;
          const stopId = uniqueStopIds[index];
          try {
            const json = await fetchJson(
              `https://rt.data.gov.hk/v2/transport/citybus/stop/${encodeURIComponent(stopId)}`
            );
            const item =
              json?.data && !Array.isArray(json.data)
                ? json.data
                : extractData(json)[0] || null;
            if (item?.stop)
              results.push({
                ...item,
                stop: String(item.stop).padStart(6, '0'),
                provider: 'ctb',
                co: 'CTB'
              });
          } catch (error) {}
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(8, uniqueStopIds.length) }, worker)
      );
      const byStop = new Map(
        results.map((stop) => [String(stop.stop).padStart(6, '0'), stop])
      );
      ctbStopInventoryCache = [...byStop.values()];
      ctbStopInventoryFetchedAt = Date.now();
      return ctbStopInventoryCache;
    } catch (error) {
      return [];
    }
  })();

  try {
    return await ctbStopLoadPromise;
  } finally {
    ctbStopLoadPromise = null;
  }
}

// ── IndexedDB static snapshot ──

function openStaticDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window))
      return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(STATIC_DB_NAME, STATIC_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STATIC_DB_STORE))
        db.createObjectStore(STATIC_DB_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error || new Error('IndexedDB open failed'));
  });
}

async function readStaticSnapshot() {
  try {
    const db = await openStaticDb();
    const snapshot = await new Promise((resolve, reject) => {
      const tx = db.transaction(STATIC_DB_STORE, 'readonly');
      const req = tx.objectStore(STATIC_DB_STORE).get(STATIC_SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (
      snapshot?.fetchedAt &&
      Date.now() - snapshot.fetchedAt < STATIC_SNAPSHOT_TTL
    )
      return snapshot;
  } catch (e) {}
  return null;
}

async function writeStaticSnapshot(snapshot) {
  try {
    const db = await openStaticDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STATIC_DB_STORE, 'readwrite');
      tx.objectStore(STATIC_DB_STORE).put(snapshot);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch (e) {
    return false;
  }
}

export function applyStaticSnapshot(snapshot) {
  if (!snapshot?.routeDb) return false;
  allStops = Array.isArray(snapshot.allStops) ? snapshot.allStops : [];
  routeDb = snapshot.routeDb || { kmb: {}, lwb: {}, ctb: {} };
  buildStopMetaMap();
  ctbRouteStopLastLoadedAt = snapshot.fetchedAt || Date.now();
  logDebug(`Applied static snapshot with ${allStops.length} stops.`);
  return true;
}

export async function loadUnifiedStaticData(force = false) {
  if (!force && staticDataLoadPromise) return staticDataLoadPromise;

  staticDataLoadPromise = (async () => {
    if (!force) {
      const cached = await readStaticSnapshot();
      if (cached && applyStaticSnapshot(cached)) return true;
    }

    try {
      allStops = await fetchKmbStops();
      routeDb = { kmb: {}, lwb: {}, ctb: {} };
      try {
        const json = await fetchJson(
          `${getProviderApiBase('kmb')}/route-stop`
        );
        extractData(json).forEach((item) => {
          if (!item?.route || !item?.stop) return;
          const provider = normalizeProvider(item.co);
          const route = String(item.route).toUpperCase();
          if (!routeDb[provider][route]) routeDb[provider][route] = [];
          routeDb[provider][route].push({
            route,
            stopId: String(item.stop),
            seq: parseInt(item.seq, 10) || 0,
            dir: normalizeDirection(item.dir || item.bound),
            serviceType: normalizeServiceType(item.service_type),
            provider,
            providerCode: getProvider(provider).code
          });
        });
      } catch (e) {}

      await loadCtbRouteStopDatabase(true);
      const ctbStops = await fetchCtbStops(true);

      if (ctbStops.length) {
        const seen = new Set(
          allStops.map((stop) => getStopKey(stop.stop, stop.provider))
        );
        ctbStops.forEach((stop) => {
          const key = getStopKey(stop.stop, stop.provider);
          if (!seen.has(key)) {
            allStops.push(stop);
            seen.add(key);
          }
        });
      }

      buildStopMetaMap();
      const fetchedAt = Date.now();
      await writeStaticSnapshot({
        key: STATIC_SNAPSHOT_KEY,
        fetchedAt,
        allStops,
        routeDb
      });
      try {
        localStorage.setItem(
          ROUTE_DB_KEY,
          JSON.stringify({ timestamp: fetchedAt, data: routeDb })
        );
      } catch (e) {}
      ctbRouteStopLastLoadedAt = fetchedAt;
      return true;
    } catch (error) {
      return false;
    }
  })();

  try {
    return await staticDataLoadPromise;
  } finally {
    staticDataLoadPromise = null;
  }
}

export async function initStops() {
  const loaded = await loadUnifiedStaticData(false);
  if (!loaded && allStops.length === 0) {
    const [kmbStops, ctbStops] = await Promise.all([
      fetchKmbStops(),
      fetchCtbStops(false)
    ]);
    allStops = [...kmbStops, ...ctbStops];
  }
  buildStopMetaMap();
}
