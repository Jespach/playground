'use strict';

/* ==========================================================================
   Constants
   ========================================================================== */

const DEFAULT_LOCATION = { lat: 51.5072, lng: -0.1276, label: 'London, United Kingdom' };
// Archive datasets lag real time by several days; ending a week ago avoids empty tails.
const DEFAULT_END_LAG_DAYS = 7;
const DEFAULT_RANGE_DAYS = 365;
const AUTO_LOAD_DELAY_MS = 600;
const REVERSE_GEOCODE_DELAY_MS = 1000;
// Nominatim usage policy: at most one request per second.
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const RAIN_DAY_THRESHOLD_MM = 1;
const ROLLING_WINDOW_DAYS = 7;
const OPEN_METEO_MIN_DATE = '1940-01-01';
const SAVED_PLACE_ZOOM = 11;

const SAVED_PLACES = [
  { name: 'Grootkoppe', lat: -26.9428, lng: 27.2109 },
  { name: 'Patrysvlei', lat: -33.9516, lng: 18.8403 },
  { name: 'Hermanus', lat: -34.4108, lng: 19.2598 },
];

const dateFormat = {
  day: new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
  month: new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }),
  monthName: new Intl.DateTimeFormat(undefined, { month: 'short' }),
};

const GROUPS = {
  day: {
    adjective: 'Daily',
    column: 'Date',
    periodStart: (d) => d,
    label: (d) => dateFormat.day.format(d),
  },
  week: {
    adjective: 'Weekly',
    column: 'Week starting',
    periodStart: startOfWeek,
    label: (d) => dateFormat.day.format(d),
  },
  month: {
    adjective: 'Monthly',
    column: 'Month',
    periodStart: (d) => new Date(d.getFullYear(), d.getMonth(), 1),
    label: (d) => dateFormat.month.format(d),
  },
  quarter: {
    adjective: 'Quarterly',
    column: 'Quarter',
    periodStart: (d) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1),
    label: (d) => `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`,
  },
  year: {
    adjective: 'Yearly',
    column: 'Year',
    periodStart: (d) => new Date(d.getFullYear(), 0, 1),
    label: (d) => String(d.getFullYear()),
  },
};

/* ==========================================================================
   DOM references and state
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const ui = {
  searchForm: $('searchForm'),
  searchInput: $('locationSearch'),
  searchBtn: $('searchBtn'),
  savedPlaces: $('savedPlaces'),
  selectionInfo: $('selectionInfo'),
  startDate: $('startDate'),
  endDate: $('endDate'),
  loadBtn: $('loadBtn'),
  mapCenterBtn: $('mapCenterBtn'),
  status: $('status'),
  groupBy: $('groupBySelect'),
  chartView: $('chartViewSelect'),
  totalRainfall: $('totalRainfall'),
  avgRainfall: $('avgRainfall'),
  rainDays: $('rainDays'),
  dataCoverage: $('dataCoverage'),
  wettestDay: $('wettestDay'),
  contentPanel: $('contentPanel'),
  chartGrid: $('chartGrid'),
  mainChartTitle: $('mainChartTitle'),
  comparisonTitle: $('comparisonTitle'),
  comparisonCanvas: $('comparisonChart'),
  comparisonEmpty: $('comparisonEmpty'),
  heatmap: $('rainHeatmap'),
  heatmapLegend: $('heatmapLegend'),
  tableTitle: $('tableTitle'),
  tableHead: $('rainTableHead'),
  tableBody: $('rainTableBody'),
  downloadBtn: $('downloadBtn'),
};

const panels = {
  daily: $('dailyChartPanel'),
  cumulative: $('cumulativePanel'),
  rolling: $('rollingPanel'),
  comparison: $('comparisonPanel'),
  heatmap: $('heatmapPanel'),
};

const state = {
  lat: DEFAULT_LOCATION.lat,
  lng: DEFAULT_LOCATION.lng,
  label: DEFAULT_LOCATION.label,
  rows: [], // one entry per calendar day: { date, rainfall: number|null, temperature: number|null }
  loadedRequest: null,
};

const chartsAvailable = typeof Chart !== 'undefined';
const charts = {};

let leafletMap = null;
let marker = null;
let activeLoad = null;
let autoLoadTimer = null;
let reverseTimer = null;
let reverseController = null;
let lastNominatimRequest = 0;

/* ==========================================================================
   Date helpers (local calendar dates; never round-trip through UTC)
   ========================================================================== */

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toIsoDate(parseIsoDate(value)) === value;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfWeek(date) {
  const offset = (date.getDay() + 6) % 7; // Monday = 0
  return addDays(date, -offset);
}

const formatDay = (iso) => dateFormat.day.format(parseIsoDate(iso));

/* ==========================================================================
   Formatting helpers
   ========================================================================== */

function formatMm(value, digits = 1) {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)} mm`;
}

function formatTemp(value) {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)} °C`;
}

function toNumberOrNull(value, fillValue) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (fillValue !== undefined && n === fillValue) return null;
  return n;
}

function createEl(tag, { className, text, attrs } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

/* ==========================================================================
   Network helpers
   ========================================================================== */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

async function fetchJson(url, { signal, sourceName }) {
  let response;
  try {
    response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`Could not reach ${sourceName}. Check your connection and try again.`);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body; handled below.
  }

  if (!response.ok) {
    const detail = body && (body.reason || body.message);
    throw new Error(`${sourceName} request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
  }

  if (body === null) {
    throw new Error(`${sourceName} returned an unreadable response.`);
  }
  return body;
}

async function nominatimFetch(path, params, signal) {
  const wait = lastNominatimRequest + NOMINATIM_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastNominatimRequest = Date.now();

  const url = new URL(path, NOMINATIM_BASE);
  url.search = new URLSearchParams({ format: 'jsonv2', ...params }).toString();
  return fetchJson(url, { signal, sourceName: 'Place search' });
}

/* ==========================================================================
   Open-Meteo — returns rows of { date: 'YYYY-MM-DD', rainfall (mm), temperature (°C) }
   ========================================================================== */

async function fetchOpenMeteoRows({ lat, lng, start, end, signal }) {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.search = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    start_date: start,
    end_date: end,
    daily: 'precipitation_sum,temperature_2m_mean',
    timezone: 'auto',
  }).toString();

  const data = await fetchJson(url, { signal, sourceName: 'Open-Meteo' });
  const daily = data.daily;
  if (!daily || !Array.isArray(daily.time)) {
    throw new Error('Open-Meteo returned no daily values for this location and date range.');
  }

  return daily.time.map((date, i) => ({
    date,
    rainfall: toNumberOrNull(daily.precipitation_sum?.[i]),
    temperature: toNumberOrNull(daily.temperature_2m_mean?.[i]),
  }));
}

/* ==========================================================================
   Data shaping
   ========================================================================== */

// Expand to one row per calendar day so missing days are explicit nulls, not zeros.
function fillCalendar(rows, start, end) {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const filled = [];
  const last = parseIsoDate(end);

  for (let d = parseIsoDate(start); d <= last; d = addDays(d, 1)) {
    const date = toIsoDate(d);
    const row = byDate.get(date);
    const rainfall = row && row.rainfall !== null && row.rainfall >= 0 ? row.rainfall : null;
    filled.push({ date, rainfall, temperature: row ? row.temperature : null });
  }
  return filled;
}

function aggregateRows(rows, groupBy) {
  const group = GROUPS[groupBy] || GROUPS.day;
  const buckets = new Map();

  for (const row of rows) {
    const periodStart = group.periodStart(parseIsoDate(row.date));
    const key = toIsoDate(periodStart);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label: group.label(periodStart), rainSum: 0, rainDays: 0, tempSum: 0, tempDays: 0, days: 0 };
      buckets.set(key, bucket);
    }
    bucket.days += 1;
    if (row.rainfall !== null) {
      bucket.rainSum += row.rainfall;
      bucket.rainDays += 1;
    }
    if (row.temperature !== null) {
      bucket.tempSum += row.temperature;
      bucket.tempDays += 1;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((b) => ({
      key: b.key,
      label: b.label,
      rainfall: b.rainDays ? b.rainSum : null,
      temperature: b.tempDays ? b.tempSum / b.tempDays : null,
      days: b.days,
      validDays: b.rainDays,
    }));
}

function rollingTotals(rows, windowDays) {
  const totals = [];
  let sum = 0;
  let count = 0;

  rows.forEach((row, i) => {
    if (row.rainfall !== null) {
      sum += row.rainfall;
      count += 1;
    }
    if (i >= windowDays) {
      const dropped = rows[i - windowDays];
      if (dropped.rainfall !== null) {
        sum -= dropped.rainfall;
        count -= 1;
      }
    }
    totals.push(count ? Math.max(0, sum) : null);
  });
  return totals;
}

function summarize(rows) {
  const valid = rows.filter((row) => row.rainfall !== null);
  if (!valid.length) return null;

  const total = valid.reduce((sum, row) => sum + row.rainfall, 0);
  const wettest = valid.reduce((max, row) => (row.rainfall > max.rainfall ? row : max), valid[0]);
  return {
    total,
    average: total / valid.length,
    wettest,
    rainDays: valid.filter((row) => row.rainfall >= RAIN_DAY_THRESHOLD_MM).length,
    validDays: valid.length,
    totalDays: rows.length,
  };
}

/* ==========================================================================
   Rendering
   ========================================================================== */

function readTheme() {
  const styles = getComputedStyle(document.documentElement);
  const v = (name) => styles.getPropertyValue(name).trim();
  return {
    text: v('--text'),
    muted: v('--muted'),
    grid: v('--border'),
    rain: v('--chart-rain'),
    dry: v('--chart-dry'),
    cumulative: v('--chart-cumulative'),
    rolling: v('--chart-rolling'),
    temperature: v('--chart-temp'),
  };
}

function withAlpha(hex, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function baseChartOptions(theme, { yTitle, legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, labels: { color: theme.text } },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            ctx.parsed.y === null ? `${ctx.dataset.label}: no data` : `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: theme.muted, maxTicksLimit: 10, autoSkip: true, maxRotation: 0 },
        grid: { color: theme.grid },
      },
      y: {
        beginAtZero: true,
        title: { display: Boolean(yTitle), text: yTitle, color: theme.muted },
        ticks: { color: theme.muted },
        grid: { color: theme.grid },
      },
    },
  };
}

function drawChart(canvasId, config) {
  charts[canvasId]?.destroy();
  charts[canvasId] = new Chart($(canvasId), config);
}

function renderMainChart(groups, group, theme) {
  const values = groups.map((g) => g.rainfall);
  drawChart('rainChart', {
    type: 'bar',
    data: {
      labels: groups.map((g) => g.label),
      datasets: [
        {
          label: `${group.adjective} rainfall (mm)`,
          data: values,
          backgroundColor: values.map((v) => (v > 0 ? withAlpha(theme.rain, 0.85) : withAlpha(theme.dry, 0.6))),
          borderRadius: 4,
        },
      ],
    },
    options: baseChartOptions(theme, { yTitle: 'mm' }),
  });
}

function renderCumulativeChart(groups, theme) {
  let runningTotal = 0;
  const values = groups.map((g) => {
    runningTotal += g.rainfall ?? 0;
    return runningTotal;
  });

  drawChart('cumulativeChart', {
    type: 'line',
    data: {
      labels: groups.map((g) => g.label),
      datasets: [
        {
          label: 'Cumulative rainfall (mm)',
          data: values,
          borderColor: theme.cumulative,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
        },
      ],
    },
    options: baseChartOptions(theme, { yTitle: 'mm' }),
  });
}

function renderRollingChart(rows, theme) {
  drawChart('rollingChart', {
    type: 'line',
    data: {
      labels: rows.map((row) => formatDay(row.date)),
      datasets: [
        {
          label: `${ROLLING_WINDOW_DAYS}-day total (mm)`,
          data: rollingTotals(rows, ROLLING_WINDOW_DAYS),
          borderColor: theme.rolling,
          backgroundColor: withAlpha(theme.rolling, 0.18),
          fill: true,
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: baseChartOptions(theme, { yTitle: 'mm' }),
  });
}

function renderComparisonChart(groups, group, theme, hasTemperature) {
  ui.comparisonCanvas.hidden = !hasTemperature;
  ui.comparisonEmpty.hidden = hasTemperature || groups.length === 0;

  if (!hasTemperature) {
    charts.comparisonChart?.destroy();
    delete charts.comparisonChart;
    return;
  }

  const options = baseChartOptions(theme, { legend: true });
  const { x } = options.scales;
  options.scales = {
    x,
    rain: {
      position: 'left',
      beginAtZero: true,
      title: { display: true, text: 'Rainfall (mm)', color: theme.muted },
      ticks: { color: theme.muted },
      grid: { color: theme.grid },
    },
    temp: {
      position: 'right',
      title: { display: true, text: 'Temperature (°C)', color: theme.muted },
      ticks: { color: theme.muted },
      grid: { drawOnChartArea: false },
    },
  };

  drawChart('comparisonChart', {
    data: {
      labels: groups.map((g) => g.label),
      datasets: [
        {
          type: 'bar',
          label: `${group.adjective} rainfall (mm)`,
          data: groups.map((g) => g.rainfall),
          yAxisID: 'rain',
          backgroundColor: withAlpha(theme.rain, 0.55),
          borderRadius: 3,
          order: 2,
        },
        {
          type: 'line',
          label: 'Mean temperature (°C)',
          data: groups.map((g) => g.temperature),
          yAxisID: 'temp',
          borderColor: theme.temperature,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          order: 1,
        },
      ],
    },
    options,
  });
}

function renderHeatmap(rows) {
  ui.heatmap.replaceChildren();
  ui.heatmapLegend.textContent = '';

  const months = aggregateRows(rows, 'month');
  if (!months.some((m) => m.rainfall !== null)) {
    ui.heatmap.append(createEl('p', { className: 'empty-note', text: 'No rainfall data to show yet.' }));
    return;
  }

  const byMonth = new Map(months.map((m) => [m.key.slice(0, 7), m]));
  const max = Math.max(...months.map((m) => m.rainfall ?? 0), 1);
  const firstYear = Number(rows[0].date.slice(0, 4));
  const lastYear = Number(rows[rows.length - 1].date.slice(0, 4));

  const table = createEl('table', { className: 'heatmap-table' });
  table.append(createEl('caption', { className: 'visually-hidden', text: 'Monthly rainfall totals by year' }));

  const headRow = createEl('tr');
  headRow.append(createEl('th', { attrs: { scope: 'col' }, text: '' }));
  for (let m = 0; m < 12; m += 1) {
    headRow.append(createEl('th', { attrs: { scope: 'col' }, text: dateFormat.monthName.format(new Date(2000, m, 1)) }));
  }
  const thead = createEl('thead');
  thead.append(headRow);
  table.append(thead);

  const body = createEl('tbody');
  for (let year = firstYear; year <= lastYear; year += 1) {
    const tr = createEl('tr');
    tr.append(createEl('th', { attrs: { scope: 'row' }, text: String(year) }));

    for (let m = 0; m < 12; m += 1) {
      const entry = byMonth.get(`${year}-${String(m + 1).padStart(2, '0')}`);
      const td = createEl('td');

      if (!entry) {
        td.setAttribute('aria-label', 'Outside selected range');
      } else if (entry.rainfall === null) {
        td.className = 'heat-none';
        td.title = `${entry.label}: no data`;
        td.setAttribute('aria-label', td.title);
      } else {
        const pct = Math.round((entry.rainfall / max) * 100);
        td.style.background = `color-mix(in srgb, var(--chart-rain) ${Math.max(pct, 6)}%, var(--panel-alt))`;
        if (pct > 55) td.className = 'heat-high';
        td.textContent = entry.rainfall >= 10 ? entry.rainfall.toFixed(0) : entry.rainfall.toFixed(1);
        td.title = `${entry.label}: ${formatMm(entry.rainfall)} (${entry.validDays} of ${entry.days} days with data)`;
        td.setAttribute('aria-label', td.title);
      }
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  ui.heatmap.append(table);
  ui.heatmapLegend.textContent = `Monthly totals in mm · darkest = ${formatMm(max, 0)}`;
}

function renderSummary(rows) {
  const summary = summarize(rows);
  if (!summary) {
    ui.totalRainfall.textContent = '--';
    ui.avgRainfall.textContent = '--';
    ui.rainDays.textContent = '--';
    ui.dataCoverage.textContent = rows.length ? `0 / ${rows.length}` : '--';
    ui.wettestDay.textContent = '--';
    return;
  }

  ui.totalRainfall.textContent = formatMm(summary.total);
  ui.avgRainfall.textContent = formatMm(summary.average, 2);
  ui.rainDays.textContent = String(summary.rainDays);
  ui.dataCoverage.textContent = `${summary.validDays} / ${summary.totalDays}`;
  ui.wettestDay.textContent = `${formatDay(summary.wettest.date)}: ${formatMm(summary.wettest.rainfall)}`;
}

function renderTable(groups, group, { hasTemperature, showCoverage }) {
  const headers = [group.column, 'Rainfall'];
  if (hasTemperature) headers.push('Mean temp');
  if (showCoverage) headers.push('Days with data');
  ui.tableHead.replaceChildren(...headers.map((h) => createEl('th', { attrs: { scope: 'col' }, text: h })));

  if (!groups.length) {
    const td = createEl('td', { text: 'No rainfall data loaded for this date range.', attrs: { colspan: headers.length } });
    ui.tableBody.replaceChildren(createEl('tr'));
    ui.tableBody.firstChild.append(td);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    const tr = createEl('tr');
    tr.append(createEl('td', { text: g.label }));
    tr.append(createEl('td', { text: formatMm(g.rainfall), className: g.rainfall === null ? 'missing' : '' }));
    if (hasTemperature) {
      tr.append(createEl('td', { text: formatTemp(g.temperature), className: g.temperature === null ? 'missing' : '' }));
    }
    if (showCoverage) tr.append(createEl('td', { text: `${g.validDays} / ${g.days}` }));
    fragment.append(tr);
  }
  ui.tableBody.replaceChildren(fragment);
}

function render() {
  const groupBy = ui.groupBy.value in GROUPS ? ui.groupBy.value : 'day';
  const group = GROUPS[groupBy];
  const rows = state.rows;
  const groups = aggregateRows(rows, groupBy);
  const hasTemperature = rows.some((row) => row.temperature !== null);

  ui.mainChartTitle.textContent = `${group.adjective} rainfall`;
  ui.comparisonTitle.textContent = `${group.adjective} rainfall vs temperature`;
  ui.tableTitle.textContent = `${group.adjective} rainfall`;

  renderSummary(rows);
  renderTable(groups, group, { hasTemperature, showCoverage: groupBy !== 'day' });
  renderHeatmap(rows);

  if (chartsAvailable) {
    const theme = readTheme();
    renderMainChart(groups, group, theme);
    renderCumulativeChart(groups, theme);
    renderRollingChart(rows, theme);
    renderComparisonChart(groups, group, theme, hasTemperature);
  }

  ui.downloadBtn.disabled = rows.length === 0;
}

function updateChartView() {
  const view = ui.chartView.value;
  for (const [key, panel] of Object.entries(panels)) {
    panel.hidden = !(view === 'all' || view === key);
  }
  ui.chartGrid.hidden = view === 'daily';
}

function showChartsUnavailable() {
  document.querySelectorAll('.chart-box').forEach((box) => {
    box.replaceChildren(createEl('p', { className: 'empty-note', text: 'Charts could not be loaded. Check your connection and reload the page.' }));
  });
}

/* ==========================================================================
   Status and loading
   ========================================================================== */

function setStatus(message, tone = 'info') {
  ui.status.textContent = message || '';
  ui.status.dataset.tone = tone;
  ui.status.hidden = !message;
}

function setLoading(isLoading) {
  ui.loadBtn.disabled = isLoading;
  ui.loadBtn.textContent = isLoading ? 'Loading…' : 'Load rainfall';
  ui.contentPanel.setAttribute('aria-busy', String(isLoading));
}

function readRequest() {
  const start = ui.startDate.value;
  const end = ui.endDate.value;

  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return { error: 'Choose both a start and end date.' };
  }
  if (start > end) {
    return { error: 'The start date must be on or before the end date.' };
  }
  if (end > toIsoDate(today())) {
    return { error: 'The end date cannot be in the future.' };
  }
  if (start < OPEN_METEO_MIN_DATE) {
    return { error: `Open-Meteo data starts on ${formatDay(OPEN_METEO_MIN_DATE)}. Choose a later start date.` };
  }

  return { start, end, lat: state.lat, lng: state.lng };
}

function scheduleLoad() {
  clearTimeout(autoLoadTimer);
  autoLoadTimer = setTimeout(loadRainfall, AUTO_LOAD_DELAY_MS);
}

async function loadRainfall() {
  clearTimeout(autoLoadTimer);

  const request = readRequest();
  if (request.error) {
    setStatus(request.error, 'error');
    return;
  }

  activeLoad?.abort();
  const controller = new AbortController();
  activeLoad = controller;

  setLoading(true);
  setStatus('Loading Open-Meteo data…', 'info');

  try {
    const rows = await fetchOpenMeteoRows({ ...request, signal: controller.signal });
    if (controller !== activeLoad) return;

    state.rows = fillCalendar(rows, request.start, request.end);
    state.loadedRequest = request;
    render();
    writeUrlState();

    const missing = state.rows.filter((row) => row.rainfall === null).length;
    if (missing === state.rows.length) {
      setStatus('Open-Meteo has no rainfall values for this range yet. Try an earlier end date.', 'warn');
    } else if (missing > 0) {
      setStatus(
        `Loaded ${state.rows.length} days. ${missing} day${missing === 1 ? '' : 's'} had no data and ${missing === 1 ? 'is' : 'are'} shown as gaps.`,
        'warn'
      );
    } else {
      setStatus(`Loaded ${state.rows.length} days.`, 'info');
    }
  } catch (error) {
    if (error.name === 'AbortError' || controller !== activeLoad) return;
    console.error(error);
    state.rows = [];
    state.loadedRequest = null;
    render();
    setStatus(error.message || 'Unable to load rainfall data for this location.', 'error');
  } finally {
    if (controller === activeLoad) {
      activeLoad = null;
      setLoading(false);
    }
  }
}

/* ==========================================================================
   Location, map and geocoding
   ========================================================================== */

function updateSelectionInfo() {
  const coords = `${state.lat.toFixed(4)}, ${state.lng.toFixed(4)}`;
  const children = [];
  if (state.label) children.push(createEl('span', { className: 'selection-name', text: state.label }));
  children.push(createEl('span', { className: 'selection-coords', text: `Lat, lng: ${coords}` }));
  ui.selectionInfo.replaceChildren(...children);

  for (const button of ui.savedPlaces.querySelectorAll('button')) {
    const place = SAVED_PLACES[Number(button.dataset.index)];
    const isActive = Math.abs(place.lat - state.lat) < 1e-4 && Math.abs(place.lng - state.lng) < 1e-4;
    button.setAttribute('aria-pressed', String(isActive));
  }
}

function renderSavedPlaces() {
  ui.savedPlaces.replaceChildren(
    ...SAVED_PLACES.map((place, index) =>
      createEl('button', {
        text: place.name,
        attrs: { type: 'button', 'data-index': index, 'aria-pressed': 'false', title: `${place.lat}, ${place.lng}` },
      })
    )
  );
}

function goToSavedPlace(place) {
  leafletMap?.setView([place.lat, place.lng], SAVED_PLACE_ZOOM);
  setLocation(place.lat, place.lng, { label: place.name });
}

function cancelReverseGeocode() {
  clearTimeout(reverseTimer);
  reverseController?.abort();
  reverseController = null;
}

function scheduleReverseGeocode(delay = REVERSE_GEOCODE_DELAY_MS) {
  cancelReverseGeocode();
  reverseTimer = setTimeout(async () => {
    const controller = new AbortController();
    reverseController = controller;
    const { lat, lng } = state;
    try {
      const result = await nominatimFetch('/reverse', { lat: lat.toFixed(5), lon: lng.toFixed(5), zoom: '10' }, controller.signal);
      if (controller === reverseController && state.lat === lat && state.lng === lng && result?.display_name) {
        state.label = result.display_name;
        updateSelectionInfo();
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.warn('Reverse geocoding failed:', error);
    }
  }, delay);
}

function setLocation(lat, lng, { label = null } = {}) {
  cancelReverseGeocode();
  state.lat = lat;
  state.lng = lng;
  state.label = label;
  marker?.setLatLng([lat, lng]);
  updateSelectionInfo();

  if (!label) scheduleReverseGeocode();
  scheduleLoad();
}

function buildMap() {
  if (typeof L === 'undefined') {
    $('map').replaceChildren(createEl('p', { className: 'empty-note', text: 'The map could not be loaded. You can still search for a place.' }));
    return;
  }

  leafletMap = L.map('map', { worldCopyJump: true, zoomSnap: 0.25 }).setView([state.lat, state.lng], 5);

  const standard = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics' }
  );

  standard.addTo(leafletMap);
  L.control.layers({ Standard: standard, Satellite: satellite }, null, { position: 'topright' }).addTo(leafletMap);
  leafletMap.attributionControl.addAttribution('Search: <a href="https://nominatim.org/">Nominatim</a>');

  marker = L.marker([state.lat, state.lng]).addTo(leafletMap);

  leafletMap.on('click', (event) => {
    const { lat, lng } = event.latlng.wrap(); // keep longitude within ±180 across world copies
    setLocation(lat, lng);
  });
}

async function handleSearch(event) {
  event.preventDefault();
  const query = ui.searchInput.value.trim();
  if (!query) {
    setStatus('Enter a place name to search.', 'error');
    ui.searchInput.focus();
    return;
  }

  ui.searchBtn.disabled = true;
  try {
    const results = await nominatimFetch('/search', { q: query, limit: '1' });
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(`No place found for "${query}".`);
    }
    const match = results[0];
    const lat = Number(match.lat);
    const lng = Number(match.lon);
    leafletMap?.setView([lat, lng], 8);
    setLocation(lat, lng, { label: match.display_name });
  } catch (error) {
    setStatus(error.message || 'Unable to find that place.', 'error');
  } finally {
    ui.searchBtn.disabled = false;
  }
}

/* ==========================================================================
   URL state and CSV export
   ========================================================================== */

function selectHasOption(select, value) {
  return [...select.options].some((option) => option.value === value);
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const result = {};

  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (params.has('lat') && params.has('lng') && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    result.location = { lat, lng };
  }
  if (isValidIsoDate(params.get('start'))) result.start = params.get('start');
  if (isValidIsoDate(params.get('end'))) result.end = params.get('end');
  if (selectHasOption(ui.groupBy, params.get('group'))) result.group = params.get('group');
  if (selectHasOption(ui.chartView, params.get('view'))) result.view = params.get('view');
  return result;
}

function writeUrlState() {
  const params = new URLSearchParams({
    lat: state.lat.toFixed(4),
    lng: state.lng.toFixed(4),
    start: ui.startDate.value,
    end: ui.endDate.value,
    group: ui.groupBy.value,
    view: ui.chartView.value,
  });
  history.replaceState(null, '', `${window.location.pathname}?${params}`);
}

function downloadCsv() {
  const request = state.loadedRequest;
  if (!request || !state.rows.length) return;

  const round = (v) => (v === null ? '' : String(Math.round(v * 100) / 100));
  const lines = ['date,rainfall_mm,temperature_c', ...state.rows.map((r) => `${r.date},${round(r.rainfall)},${round(r.temperature)}`)];
  const place = `${request.lat.toFixed(3)}_${request.lng.toFixed(3)}`;

  const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }));
  const link = createEl('a', { attrs: { href: url, download: `rainfall_${place}_${request.start}_${request.end}.csv` } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ==========================================================================
   Wiring
   ========================================================================== */

function bindEvents() {
  ui.searchForm.addEventListener('submit', handleSearch);
  ui.savedPlaces.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-index]');
    if (button) goToSavedPlace(SAVED_PLACES[Number(button.dataset.index)]);
  });
  ui.loadBtn.addEventListener('click', loadRainfall);
  ui.downloadBtn.addEventListener('click', downloadCsv);

  ui.mapCenterBtn.addEventListener('click', () => {
    if (!leafletMap) return;
    const { lat, lng } = leafletMap.getCenter().wrap();
    setLocation(lat, lng);
  });

  ui.startDate.addEventListener('change', scheduleLoad);
  ui.endDate.addEventListener('change', scheduleLoad);

  ui.groupBy.addEventListener('change', () => {
    render();
    writeUrlState();
  });

  ui.chartView.addEventListener('change', () => {
    updateChartView();
    writeUrlState();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
}

function init() {
  const fromUrl = readUrlState();
  const todayIso = toIsoDate(today());
  const defaultEnd = addDays(today(), -DEFAULT_END_LAG_DAYS);

  ui.startDate.min = OPEN_METEO_MIN_DATE;
  ui.endDate.min = OPEN_METEO_MIN_DATE;
  ui.startDate.max = todayIso;
  ui.endDate.max = todayIso;
  ui.startDate.value = fromUrl.start ?? toIsoDate(addDays(defaultEnd, -(DEFAULT_RANGE_DAYS - 1)));
  ui.endDate.value = fromUrl.end ?? toIsoDate(defaultEnd);
  ui.groupBy.value = fromUrl.group ?? 'day';
  ui.chartView.value = fromUrl.view ?? 'all';

  let needsReverseGeocode = false;
  if (fromUrl.location) {
    const { lat, lng } = fromUrl.location;
    const saved = SAVED_PLACES.find((p) => Math.abs(p.lat - lat) < 1e-4 && Math.abs(p.lng - lng) < 1e-4);
    state.lat = lat;
    state.lng = lng;
    state.label = saved ? saved.name : null;
    needsReverseGeocode = !saved;
  }

  renderSavedPlaces();
  updateChartView();
  if (!chartsAvailable) showChartsUnavailable();
  buildMap();
  updateSelectionInfo();
  bindEvents();

  if (needsReverseGeocode) scheduleReverseGeocode(0);
  render();
  loadRainfall();
}

init();
