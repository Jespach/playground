const mapState = {
  lat: 51.5072,
  lng: -0.1276,
  marker: null,
};

const dateDefaults = {
  start: (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })(),
  end: new Date().toISOString().slice(0, 10),
};

const selectionInfo = document.getElementById('selectionInfo');
const startDateInput = document.getElementById('startDate');
const endDateInput = document.getElementById('endDate');
const searchInput = document.getElementById('locationSearch');
const totalRainfallEl = document.getElementById('totalRainfall');
const avgRainfallEl = document.getElementById('avgRainfall');
const wettestDayEl = document.getElementById('wettestDay');
const rainTableBody = document.getElementById('rainTableBody');
const chartCanvas = document.getElementById('rainChart');

let rainChart = null;

function setDefaultDates() {
  startDateInput.value = dateDefaults.start;
  endDateInput.value = dateDefaults.end;
}

function updateSelectionText() {
  selectionInfo.textContent = `Latitude ${mapState.lat.toFixed(4)}, Longitude ${mapState.lng.toFixed(4)}`;
}

function setMarker(lat, lng) {
  if (!mapState.marker) {
    mapState.marker = L.marker([lat, lng]).addTo(window.map);
  } else {
    mapState.marker.setLatLng([lat, lng]);
  }
  mapState.lat = lat;
  mapState.lng = lng;
  updateSelectionText();
}

function buildMap() {
  const leafletMap = L.map('map', {
    worldCopyJump: true,
    zoomSnap: 0.25,
  }).setView([20, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(leafletMap);

  window.map = leafletMap;

  leafletMap.on('click', (event) => {
    setMarker(event.latlng.lat, event.latlng.lng);
  });

  setMarker(mapState.lat, mapState.lng);
  return leafletMap;
}

async function geocodePlace(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    format: 'jsonv2',
    q: query,
    limit: '1',
  }).toString();

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Could not look up that location.');
  }

  const results = await response.json();

  if (!results || results.length === 0) {
    throw new Error('No matching place was found.');
  }

  const match = results[0];
  return {
    lat: Number(match.lat),
    lng: Number(match.lon),
    label: match.display_name,
  };
}

function formatRain(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '0.00 mm';
  }
  return `${value.toFixed(2)} mm`;
}

function renderTable(rows) {
  if (!rows || rows.length === 0) {
    rainTableBody.innerHTML = `
      <tr>
        <td colspan="2">No rainfall data available for this date range.</td>
      </tr>
    `;
    return;
  }

  rainTableBody.innerHTML = rows
    .slice()
    .reverse()
    .map(([date, value]) => `
      <tr>
        <td>${date}</td>
        <td>${formatRain(value)}</td>
      </tr>
    `)
    .join('');
}

function renderChart(rows) {
  const labels = rows.map(([date]) => date);
  const values = rows.map(([, value]) => value);

  if (rainChart) {
    rainChart.destroy();
  }

  rainChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Daily rainfall (mm)',
          data: values,
          borderColor: '#155dfc',
          backgroundColor: 'rgba(21, 93, 252, 0.16)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: false,
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 12,
            autoSkip: true,
          },
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: 'mm',
          },
        },
      },
    },
  });
}

function renderSummary(rows) {
  if (!rows.length) {
    totalRainfallEl.textContent = '--';
    avgRainfallEl.textContent = '--';
    wettestDayEl.textContent = '--';
    return;
  }

  const total = rows.reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
  const average = total / rows.length;
  const wettest = rows.reduce((max, [date, value]) => {
    if (Number(value) > Number(max.value)) {
      return { date, value };
    }
    return max;
  }, { date: rows[0][0], value: rows[0][1] });

  totalRainfallEl.textContent = `${total.toFixed(2)} mm`;
  avgRainfallEl.textContent = `${average.toFixed(2)} mm`;
  wettestDayEl.textContent = `${wettest.date}: ${Number(wettest.value).toFixed(2)} mm`;
}

async function loadRainfall() {
  const startDate = startDateInput.value;
  const endDate = endDateInput.value;

  if (!startDate || !endDate) {
    alert('Please choose both a start and end date.');
    return;
  }

  if (new Date(startDate) > new Date(endDate)) {
    alert('The start date must be before the end date.');
    return;
  }

  const url = new URL('https://archive-api.open-meteo.com/v1/archive');
  url.search = new URLSearchParams({
    latitude: String(mapState.lat),
    longitude: String(mapState.lng),
    start_date: startDate,
    end_date: endDate,
    daily: 'precipitation_sum',
    timezone: 'auto',
  }).toString();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Open-Meteo request failed.');
    }

    const data = await response.json();

    if (!data.daily || !data.daily.time || !data.daily.precipitation_sum) {
      throw new Error('No rainfall values were returned for this location and date range.');
    }

    const rows = data.daily.time.map((date, index) => [date, Number(data.daily.precipitation_sum[index]) || 0]);

    renderChart(rows);
    renderSummary(rows);
    renderTable(rows);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Unable to load rainfall data for this area.');
    renderChart([]);
    renderSummary([]);
    renderTable([]);
  }
}

document.getElementById('searchBtn').addEventListener('click', async () => {
  const query = searchInput.value.trim();
  if (!query) {
    alert('Please enter a place name to search.');
    return;
  }

  try {
    const result = await geocodePlace(query);
    window.map.setView([result.lat, result.lng], 8);
    setMarker(result.lat, result.lng);
    selectionInfo.textContent = `${result.label}`;
  } catch (error) {
    alert(error.message || 'Unable to find that location.');
  }
});

document.getElementById('mapCenterBtn').addEventListener('click', () => {
  const center = window.map.getCenter();
  setMarker(center.lat, center.lng);
});

document.getElementById('loadBtn').addEventListener('click', loadRainfall);

setDefaultDates();
updateSelectionText();
const map = buildMap();
window.map = map;
loadRainfall();
