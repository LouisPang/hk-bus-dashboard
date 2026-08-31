/**
 * map.js — Leaflet rain map, heatmap, playback controls
 */

import {
  HKO_RAINFALL_CSV_URL,
  getDistanceKm,
  logDebug
} from './config.js';

let rainMap = null;
let rainHeatLayer = null;
let rainUserMarker = null;
let rainParsedDataset = [];
let rainTimeColumns = [];
let selectedTimeIdx = 0;
let playbackTimer = null;
let isPlaying = false;
let rainUpdateTimestamp = '';

/** Optional: set by app when location changes */
let userLocationRef = null;

const HK_VIEW_BOUNDS = [
  [22.15, 113.82],
  [22.56, 114.42]
];

/** Full HKO nowcast grid (PRD + south waters) */
const RAIN_GRID_BOUNDS = [
  [21.32, 112.95],
  [23.49, 115.30]
];

export function setRainUserLocation(loc) {
  userLocationRef = loc;
  updateRainUserMarker();
}

export function initRainMap() {
  if (rainMap || typeof L === 'undefined') return;
  const el = document.getElementById('rain-map');
  if (!el) return;

  const hkBounds = L.latLngBounds(HK_VIEW_BOUNDS);
  const gridBounds = L.latLngBounds(RAIN_GRID_BOUNDS);

  rainMap = L.map('rain-map', {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true,
    maxBounds: gridBounds.pad(0.08),
    maxBoundsViscosity: 0.6,
    minZoom: 8,
    maxZoom: 14
  });

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2gm9_1_9b68fea67e86e6b53ba39bcd',
    {
      attribution: '&copy; OSM &copy; CARTO | Data: HKO',
      subdomains: 'abcd',
      maxZoom: 18
    }
  ).addTo(rainMap);

  rainMap.fitBounds(hkBounds, { padding: [8, 8], maxZoom: 12 });
  setTimeout(() => {
    rainMap.invalidateSize();
    rainMap.fitBounds(hkBounds, { padding: [8, 8], maxZoom: 12 });
  }, 150);

  setupPlaybackControls();
}

export function fitRainMapToHK() {
  if (!rainMap) return;
  rainMap.invalidateSize();
  rainMap.fitBounds(L.latLngBounds(HK_VIEW_BOUNDS), {
    padding: [8, 8],
    maxZoom: 12
  });
}

export function updateRainUserMarker() {
  if (!rainMap || !userLocationRef) return;
  const ll = [userLocationRef.lat, userLocationRef.lng];
  if (rainUserMarker) {
    rainUserMarker.setLatLng(ll);
  } else {
    rainUserMarker = L.circleMarker(ll, {
      radius: 7,
      color: '#FFCC00',
      weight: 2,
      fillColor: '#FFCC00',
      fillOpacity: 0.9,
      pane: 'markerPane'
    })
      .addTo(rainMap)
      .bindTooltip('你的位置');
  }
  updateLocalRainBadge();
}

function parseCSV(text) {
  const lines = [];
  let curLine = [];
  let curToken = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        curToken += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      curLine.push(curToken.trim());
      curToken = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      curLine.push(curToken.trim());
      if (curLine.some((cell) => cell.length > 0)) lines.push(curLine);
      curLine = [];
      curToken = '';
    } else {
      curToken += char;
    }
  }
  if (curToken || curLine.length) {
    curLine.push(curToken.trim());
    if (curLine.some((cell) => cell.length > 0)) lines.push(curLine);
  }
  return lines;
}

function parseHKOTimeString(str) {
  if (!str) return '';
  const match = String(str).match(/(\d{4})(\d{2})(\d{2})[-_]?(\d{2})(\d{2})/);
  if (match) return `${match[4]}:${match[5]}`;
  return String(str).slice(-5);
}

function formatTimeRangeLabel(endRaw, prevEndRaw) {
  const end = parseHKOTimeString(endRaw);
  if (!prevEndRaw) return end ? `至 ${end}` : endRaw;
  const start = parseHKOTimeString(prevEndRaw);
  if (start && end) return `${start}–${end}`;
  return end || endRaw;
}

function rainIntensityClass(mm) {
  if (mm >= 20) return 'extreme';
  if (mm >= 10) return 'heavy';
  if (mm >= 5) return 'moderate';
  if (mm >= 0.5) return 'light';
  return 'dry';
}

/**
 * Map rainfall (mm) → heat intensity (0–1), aligned with legend bands:
 * ≥0.5 green · ≥2.5 gold · ≥5 orange · ≥10 red · ≥20 purple
 */
function rainToIntensity(mm) {
  if (mm < 0.5) return 0;
  if (mm >= 20) return 1;
  if (mm >= 10) return 0.82 + 0.18 * Math.min(1, (mm - 10) / 10);
  if (mm >= 5) return 0.64 + 0.18 * ((mm - 5) / 5);
  if (mm >= 2.5) return 0.46 + 0.18 * ((mm - 2.5) / 2.5);
  return 0.28 + 0.18 * ((mm - 0.5) / 2);
}

let RainHeatOverlay = null;

function getRainHeatOverlayClass() {
  if (RainHeatOverlay) return RainHeatOverlay;
  RainHeatOverlay = L.Layer.extend({
    initialize(points) {
      this._points = points || [];
    },
    setLatLngs(points) {
      this._points = points || [];
      this._redraw();
      return this;
    },
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create(
        'canvas',
        'leaflet-layer leaflet-zoom-hide'
      );
      this._canvas.style.pointerEvents = 'none';
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
      this._gradient = this._makeGradient();
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('moveend zoomend resize viewreset', this._redraw, this);
      this._redraw();
    },
    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off('moveend zoomend resize viewreset', this._redraw, this);
    },
    _makeGradient() {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 256;
      const g = c.getContext('2d').createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0.0, 'rgba(124,255,124,0)');
      g.addColorStop(0.22, '#7CFF7C');
      g.addColorStop(0.42, '#FFD700');
      g.addColorStop(0.6, '#FFA500');
      g.addColorStop(0.78, '#FF4500');
      g.addColorStop(1.0, '#C084FC');
      const ctx = c.getContext('2d');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 1, 256);
      return ctx.getImageData(0, 0, 1, 256).data;
    },
    _redraw() {
      const map = this._map;
      if (!map || !this._canvas) return;
      const size = map.getSize();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._canvas.width = Math.max(1, Math.round(size.x * dpr));
      this._canvas.height = Math.max(1, Math.round(size.y * dpr));
      this._canvas.style.width = `${size.x}px`;
      this._canvas.style.height = `${size.y}px`;
      L.DomUtil.setPosition(
        this._canvas,
        map.containerPointToLayerPoint([0, 0])
      );

      const ctx = this._ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      if (!this._points.length) return;

      const zoom = map.getZoom();
      const lat = map.getCenter().lat;
      const metersPerPx =
        (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
      // HKO grid ~2 km; radius covers a cell and blends with neighbours
      const radius = Math.max(18, Math.min(64, (2000 / metersPerPx) * 0.9));

      const bounds = map.getBounds().pad(0.2);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this._points.length; i++) {
        const p = this._points[i];
        if (!bounds.contains([p[0], p[1]])) continue;
        const pt = map.latLngToContainerPoint([p[0], p[1]]);
        const a = Math.max(0.15, Math.min(1, p[2]));
        const grd = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, radius);
        grd.addColorStop(0, `rgba(255,255,255,${a})`);
        grd.addColorStop(0.45, `rgba(255,255,255,${a * 0.45})`);
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(pt.x - radius, pt.y - radius, radius * 2, radius * 2);
      }

      const img = ctx.getImageData(0, 0, this._canvas.width, this._canvas.height);
      const pix = img.data;
      const grad = this._gradient;
      for (let i = 0; i < pix.length; i += 4) {
        const alpha = pix[i + 3];
        if (!alpha) continue;
        const gi = alpha * 4;
        pix[i] = grad[gi];
        pix[i + 1] = grad[gi + 1];
        pix[i + 2] = grad[gi + 2];
        pix[i + 3] = Math.min(210, Math.round(alpha * 0.95 + 30));
      }
      ctx.putImageData(img, 0, 0);
    }
  });
  return RainHeatOverlay;
}

function renderHeatmapForColumn(colIndex) {
  if (!rainMap || !rainParsedDataset.length) return;

  const heatPoints = [];
  rainParsedDataset.forEach((row) => {
    const val = row.values[colIndex] || 0;
    const intensity = rainToIntensity(val);
    if (intensity > 0) {
      heatPoints.push([row.lat, row.lng, intensity]);
    }
  });

  if (rainHeatLayer) {
    rainHeatLayer.setLatLngs(heatPoints);
  } else if (heatPoints.length > 0) {
    const Overlay = getRainHeatOverlayClass();
    rainHeatLayer = new Overlay(heatPoints).addTo(rainMap);
  }

  if (rainUserMarker) rainUserMarker.bringToFront();

  logDebug(
    `Rain heat: slot ${colIndex} → ${heatPoints.length} cells ≥0.5 mm`
  );

  if (heatPoints.length > 0) {
    const rainBounds = L.latLngBounds(
      heatPoints.map((p) => [p[0], p[1]])
    );
    const view = rainMap.getBounds();
    if (!view.intersects(rainBounds)) {
      const hk = L.latLngBounds(HK_VIEW_BOUNDS);
      rainMap.fitBounds(hk.extend(rainBounds), {
        padding: [16, 16],
        maxZoom: 10
      });
    }
  }

  updatePlaybackUI();
  updateLocalRainBadge();
}

function findNearestRainValue(colIndex) {
  if (!userLocationRef || !rainParsedDataset.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const pt of rainParsedDataset) {
    const d = getDistanceKm(
      userLocationRef.lat,
      userLocationRef.lng,
      pt.lat,
      pt.lng
    );
    if (d < bestDist) {
      bestDist = d;
      best = pt;
    }
  }
  if (!best) return null;
  return {
    mm: best.values[colIndex] || 0,
    distKm: bestDist,
    lat: best.lat,
    lng: best.lng
  };
}

function updateLocalRainBadge() {
  const badge = document.getElementById('rain-local-badge');
  if (!badge) return;

  const info = findNearestRainValue(selectedTimeIdx);
  if (!info) {
    badge.textContent = '附近 -- mm';
    badge.className = 'local-rain dry';
    badge.title = '尚未有位置或降雨資料';
    return;
  }

  const mm = info.mm;
  const cls = rainIntensityClass(mm);
  const mmText =
    mm < 0.05 ? '0' : mm < 10 ? mm.toFixed(1) : Math.round(mm).toString();
  badge.textContent = `附近 ${mmText} mm`;
  badge.className = `local-rain ${cls}`;
  badge.title = `最近網格約 ${Math.round(info.distKm * 1000)} m · 半小時累計雨量 ${mm.toFixed(2)} mm`;
}

function setupPlaybackControls() {
  const toggleBtn = document.getElementById('play-toggle-btn');
  const prevBtn = document.getElementById('play-prev-btn');
  const nextBtn = document.getElementById('play-next-btn');
  const slider = document.getElementById('playback-slider');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (isPlaying) stopRainPlayback();
      else startRainPlayback();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      stopRainPlayback();
      if (rainTimeColumns.length > 0) {
        selectedTimeIdx =
          (selectedTimeIdx - 1 + rainTimeColumns.length) %
          rainTimeColumns.length;
        renderHeatmapForColumn(selectedTimeIdx);
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      stopRainPlayback();
      if (rainTimeColumns.length > 0) {
        selectedTimeIdx = (selectedTimeIdx + 1) % rainTimeColumns.length;
        renderHeatmapForColumn(selectedTimeIdx);
      }
    });
  }

  if (slider) {
    slider.addEventListener('input', (e) => {
      stopRainPlayback();
      selectedTimeIdx = parseInt(e.target.value, 10) || 0;
      renderHeatmapForColumn(selectedTimeIdx);
    });
  }
}

function startRainPlayback() {
  if (rainTimeColumns.length <= 1) return;
  isPlaying = true;
  const toggleBtn = document.getElementById('play-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = '⏸';

  playbackTimer = setInterval(() => {
    selectedTimeIdx = (selectedTimeIdx + 1) % rainTimeColumns.length;
    renderHeatmapForColumn(selectedTimeIdx);
  }, 1400);
}

export function stopRainPlayback() {
  isPlaying = false;
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }
  const toggleBtn = document.getElementById('play-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = '▶';
}

function updatePlaybackUI() {
  const timeDisplay = document.getElementById('playback-time-display');
  const slider = document.getElementById('playback-slider');

  if (rainTimeColumns[selectedTimeIdx]) {
    if (timeDisplay)
      timeDisplay.textContent = rainTimeColumns[selectedTimeIdx].label;
  }
  if (slider) {
    slider.max = Math.max(0, rainTimeColumns.length - 1);
    slider.value = selectedTimeIdx;
  }
}

export async function fetchAndRenderRain() {
  const uEl = document.getElementById('rain-updated');
  logDebug('Fetching rain CSV forecast...');

  try {
    if (!rainMap) initRainMap();

    const response = await fetch(HKO_RAINFALL_CSV_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const csvText = await response.text();
    const rows = parseCSV(csvText);
    if (rows.length < 2) throw new Error('Empty or invalid CSV structure');

    let headerIdx = 0;
    const first = rows[0] || [];
    const looksLikeHeader =
      first.some((c) => /lat/i.test(c)) &&
      first.some((c) => /lon|lng/i.test(c));

    if (looksLikeHeader) headerIdx = 0;
    else {
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        if (rows[i].some((c) => /lat/i.test(c))) {
          headerIdx = i;
          break;
        }
      }
    }

    const headerRow = rows[headerIdx] || [];
    let latIdx = headerRow.findIndex((c) => /lat/i.test(c));
    let lngIdx = headerRow.findIndex((c) => /lon|lng/i.test(c));
    let endingTimeIdx = headerRow.findIndex((c) => /ending|結束/i.test(c));
    let rainfallValIdx = headerRow.findIndex((c) =>
      /rainfall|降雨|rain/i.test(c)
    );
    let updatedIdx = headerRow.findIndex((c) => /updated|更新/i.test(c));

    if (latIdx < 0 || lngIdx < 0) {
      latIdx = 2;
      lngIdx = 3;
      endingTimeIdx = 1;
      rainfallValIdx = 4;
      updatedIdx = 0;
    }
    if (rainfallValIdx < 0) rainfallValIdx = 4;
    if (endingTimeIdx < 0) endingTimeIdx = 1;

    const dataRows = rows.slice(headerIdx + 1);

    const endingOrder = [];
    const endingSeen = new Set();
    let updateTimeStr = '';

    if (dataRows[0] && dataRows[0][updatedIdx >= 0 ? updatedIdx : 0]) {
      updateTimeStr = dataRows[0][updatedIdx >= 0 ? updatedIdx : 0];
    }

    for (const row of dataRows) {
      if (row.length <= Math.max(latIdx, lngIdx, rainfallValIdx)) continue;
      const endingRaw = row[endingTimeIdx] || '';
      if (endingRaw && !endingSeen.has(endingRaw)) {
        endingSeen.add(endingRaw);
        endingOrder.push(endingRaw);
      }
    }

const pointMap = new Map();
    for (const row of dataRows) {
      if (row.length <= Math.max(latIdx, lngIdx, rainfallValIdx)) continue;
      const lat = parseFloat(row[latIdx]);
      const lng = parseFloat(row[lngIdx]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const endingRaw = row[endingTimeIdx] || '';
      const tIdx = endingOrder.indexOf(endingRaw);
      if (tIdx < 0) continue;

      const rainfallValue = parseFloat(row[rainfallValIdx]) || 0;
      const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      
      if (!pointMap.has(key)) {
        pointMap.set(key, {
          lat,
          lng,
          sums: new Array(endingOrder.length).fill(0),
          counts: new Array(endingOrder.length).fill(0)
        });
      }
      
      const point = pointMap.get(key);
      point.sums[tIdx] += rainfallValue;
      point.counts[tIdx] += 1;
    }

    // Convert accumulated sums and counts to average values per grid point
    rainParsedDataset = Array.from(pointMap.values()).map((pt) => ({
      lat: pt.lat,
      lng: pt.lng,
      values: pt.sums.map((sum, idx) => (pt.counts[idx] > 0 ? sum / pt.counts[idx] : 0))
    }));
      }
      pointMap.get(key).values[tIdx] = rainfallValue;
    }

    rainParsedDataset = Array.from(pointMap.values());

    rainTimeColumns = endingOrder.map((endRaw, idx) => {
      const prev = idx > 0 ? endingOrder[idx - 1] : null;
      let label;
      if (prev) {
        label = formatTimeRangeLabel(endRaw, prev);
      } else {
        const end = parseHKOTimeString(endRaw);
        const m = String(endRaw).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
        if (m) {
          const d = new Date(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4]),
            Number(m[5])
          );
          d.setMinutes(d.getMinutes() - 30);
          const start = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          label = `${start}–${end}`;
        } else {
          label = end ? `至 ${end}` : endRaw;
        }
      }
      return { indexInValList: idx, label, endRaw };
    });

    if (selectedTimeIdx < 0 || selectedTimeIdx >= rainTimeColumns.length) {
      selectedTimeIdx = 0;
    }

    rainUpdateTimestamp = updateTimeStr;
    if (uEl) {
      if (updateTimeStr) {
        uEl.textContent = `更新 ${parseHKOTimeString(updateTimeStr)}`;
      } else {
        const n = new Date();
        uEl.textContent = `更新 ${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
      }
    }

    const allVals = rainParsedDataset.flatMap((p) => p.values);
    const dataMax = allVals.length ? Math.max(...allVals) : 0;
    const dataMin = allVals.length ? Math.min(...allVals) : 0;
    logDebug(
      `Rain CSV OK: ${dataRows.length} rows → ${rainParsedDataset.length} grid points, ${rainTimeColumns.length} slots, max ${dataMax.toFixed(1)} mm`
    );

    const debugRainEl = document.getElementById('debug-rain-info');
    if (debugRainEl) {
      debugRainEl.innerHTML = `
          <b>Status:</b> Success<br>
          <b>CSV Raw Rows:</b> ${rows.length}<br>
          <b>Grid Points:</b> ${rainParsedDataset.length}<br>
          <b>Rainfall Col:</b> ${rainfallValIdx}<br>
          <b>Rainfall Range:</b> ${dataMin.toFixed(2)} – ${dataMax.toFixed(2)} mm<br>
          <b>Time slots:</b> ${rainTimeColumns.map((t) => t.label).join(', ')}
        `;
    }

    renderHeatmapForColumn(selectedTimeIdx);
    updateRainUserMarker();
  } catch (e) {
    console.warn('Rain CSV parse error:', e);
    logDebug(`[ERROR] Rain CSV Error: ${e.message}`);
    if (uEl) uEl.textContent = '載入失敗';
    const badge = document.getElementById('rain-local-badge');
    if (badge) {
      badge.textContent = '附近 -- mm';
      badge.className = 'local-rain dry';
    }
    const debugRainEl = document.getElementById('debug-rain-info');
    if (debugRainEl)
      debugRainEl.innerHTML = `<span style="color:#ef4444">Error loading CSV: ${e.message}</span>`;
  }
}

export function getRainMap() {
  return rainMap;
}

/** Re-draw heatmap for current time slot (e.g. after panel becomes visible). */
export function refreshRainHeatmap() {
  if (!rainMap || !rainParsedDataset.length) return;
  renderHeatmapForColumn(selectedTimeIdx);
}
