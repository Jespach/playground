/* Workout analysis widget. Served from jsDelivr (pinned commit) and driven by window.WK,
   which the fitness-workouts MCP server's get_workout tool embeds in its widget_html. */
(function boot(tries) {
  const root = document.getElementById('wk');
  if (!root || !window.WK || !window.Chart) { if (tries < 200) setTimeout(() => boot(tries + 1), 50); return; }
  const D = window.WK, C = D.c, S = D.s, run = D.run;
  if (C.lr) { C.lap = []; C.lr.forEach(([l, n]) => { for (let i = 0; i < n; i++) C.lap.push(l); }); }
  if (!C.spd && C.pace) C.spd = C.pace.map(p => p ? 60 / p : null);
  const st = document.createElement('style');
  st.textContent = `.wk-k{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:0 0 1rem}
.wk-k div{background:var(--bg-neutral);border-radius:var(--radius);padding:.55rem .75rem}
.wk-k span{display:block;font-size:12px;color:var(--text-secondary)}
.wk-k b{font-size:19px;font-weight:500;font-variant-numeric:tabular-nums}
.wk-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 .5rem;font-size:13px}
.wk-bar button{font-size:12px;padding:3px 10px}
.wk-bar button.on{background:var(--bg-accent);color:var(--text-accent);border-color:var(--border-accent)}
.wk-h{font-size:13px;color:var(--text-secondary);margin:1.25rem 0 .4rem}
.wk-ro{font-size:12px;color:var(--text-secondary);min-height:18px;font-variant-numeric:tabular-nums;margin-bottom:4px}
.wk-z{display:grid;grid-template-columns:86px 1fr 40px;gap:6px;align-items:center;font-size:12px;color:var(--text-secondary);margin:5px 0}`;
  document.head.appendChild(st);
  root.innerHTML = `<div class="wk-k" id="kpi"></div>
<div class="wk-bar"><span style="color:var(--text-secondary)">X axis</span><button id="xd" class="on">Distance</button><button id="xt">Time</button><span style="width:10px"></span><span id="tog" class="wk-bar" style="margin:0"></span></div>
<div class="wk-ro" id="ro">Hover a chart to read values</div><div id="streams"></div>
<div class="wk-h" id="laph">Laps</div>
<div style="position:relative;height:190px"><canvas id="laps" role="img" aria-label="Pace or speed per lap, reps highlighted">Per-lap pace</canvas></div>
<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px">
<div><div class="wk-h">Route, coloured by heart rate</div><svg id="route" viewBox="0 0 300 220" style="width:100%" role="img" aria-label="Route map coloured by heart rate"></svg></div>
<div><div class="wk-h">Time in heart-rate zones</div><div id="zones"></div></div></div>
<div class="wk-h" id="simh"></div>
<div style="position:relative;height:190px"><canvas id="sim" role="img" aria-label="Trend of similar sessions over time">Similar sessions</canvas></div>
<div class="wk-bar" style="margin-top:.75rem"><button id="b1">Compare with last similar session ↗</button><button id="b2">What does this say about my fitness? ↗</button></div>`;
  const $ = id => document.getElementById(id);
  const mode = document.documentElement.dataset.mode;
  const dark = mode ? mode === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const ink = css('--text-muted') || '#898781', grid = dark ? '#2c2c2a' : '#e1e0d9', accent = dark ? '#3987e5' : '#2a78d6';
  const surf = css('--surface-1') || '#fff';
  Chart.defaults.color = ink; Chart.defaults.font.size = 11;
  const fp = v => { if (v == null || !isFinite(v) || v <= 0) return '–'; const s = Math.round(v * 60); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const ft = m => { const s = Math.round(m * 60), h = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60); return (h ? h + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(s % 60).padStart(2, '0'); };
  const spdLbl = v => run ? fp(60 / v) : (Math.round(v * 10) / 10).toString();
  const prompt = t => { if (typeof sendPrompt === 'function') sendPrompt(t); };

  const k = [['Distance', S.km + ' km'], ['Moving time', S.time], [run ? 'Avg pace' : 'Avg speed', S.pace || '–'],
    ['Avg HR', S.hr ? Math.round(S.hr) + '' : '–'], ['Load', S.load ?? '–'], ['Form going in', S.tsb == null ? '–' : (S.tsb > 0 ? '+' : '') + S.tsb.toFixed(1)]];
  if (S.reps) k.splice(3, 0, ['Reps', S.reps + (S.rep_pace ? ' @ ' + S.rep_pace : '')]);
  $('kpi').innerHTML = k.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');

  const M = [
    { k: run ? 'pace' : 'spd', n: run ? 'Pace (min/km)' : 'Speed (km/h)', col: accent, fmt: run ? fp : v => v.toFixed(1), rev: run, robust: true, on: true },
    { k: 'hr', n: 'Heart rate (bpm)', col: dark ? '#e66767' : '#e34948', fmt: v => Math.round(v), on: true },
    { k: 'ele', n: 'Elevation (m)', col: '#888780', fmt: v => Math.round(v), fill: true, on: true },
    { k: 'cad', n: 'Cadence', col: dark ? '#199e70' : '#1baf7a', fmt: v => Math.round(v), on: false },
    { k: 'pwr', n: 'Power (W)', col: dark ? '#9085e9' : '#6250d6', fmt: v => Math.round(v), on: false },
    { k: 'tmp', n: 'Temp (°C)', col: dark ? '#c98500' : '#eda100', fmt: v => Math.round(v), on: false },
  ].filter(m => C[m.k]);
  let xKey = C.km ? 'km' : 't', hov = null; const charts = [];
  const repLaps = new Set(D.laps.filter(l => l[3]).map(l => l[0]));
  const xs = () => C[xKey];
  const pct = (a, q) => { const s = a.filter(v => v != null).sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
  const bands = { id: 'bands', beforeDatasetsDraw(ch) {
    if (!C.lap || !repLaps.size) return; const { ctx, chartArea: a, scales: { x } } = ch, X = xs(); let s = null;
    ctx.save(); ctx.fillStyle = dark ? 'rgba(57,135,229,.16)' : 'rgba(42,120,214,.09)';
    for (let i = 0; i <= X.length; i++) { const r = i < X.length && repLaps.has(C.lap[i]);
      if (r && s === null) s = i;
      if (!r && s !== null) { const x0 = x.getPixelForValue(X[s]), x1 = x.getPixelForValue(X[i - 1]); ctx.fillRect(x0, a.top, Math.max(2, x1 - x0), a.bottom - a.top); s = null; } }
    ctx.restore(); } };
  const cross = { id: 'cross', afterDatasetsDraw(ch) {
    if (hov == null) return; const { ctx, chartArea: a, scales: { x, y } } = ch, px = x.getPixelForValue(xs()[hov]);
    const v = ch.data.datasets[0].data[hov]?.y;
    ctx.save(); ctx.strokeStyle = ink; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
    if (v != null) { ctx.setLineDash([]); ctx.fillStyle = ch.data.datasets[0].borderColor; ctx.strokeStyle = surf; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, y.getPixelForValue(v), 4, 0, 7); ctx.fill(); ctx.stroke(); }
    ctx.restore(); } };
  const nearest = v => { const X = xs(); let b = 0, d = Infinity; X.forEach((x, i) => { if (x != null && Math.abs(x - v) < d) { d = Math.abs(x - v); b = i; } }); return b; };
  let proj = null;
  const routeDot = i => { const d = $('rdot'); if (!d || !proj) return; const p = i == null ? null : proj(i);
    if (!p) { d.style.display = 'none'; return; } d.setAttribute('cx', p[0]); d.setAttribute('cy', p[1]); d.style.display = ''; };
  const readout = i => {
    if (i == null) { $('ro').textContent = 'Hover a chart to read values'; return; }
    const p = []; if (C.km) p.push(C.km[i].toFixed(2) + ' km'); if (C.t) p.push(ft(C.t[i]));
    M.forEach(m => { const v = C[m.k][i]; if (v != null) p.push(m.n.split(' (')[0] + ' ' + m.fmt(v)); });
    if (C.lap) p.push('lap ' + C.lap[i] + (repLaps.has(C.lap[i]) ? ' (rep)' : ''));
    $('ro').textContent = p.join(' · '); };
  const setHover = i => { hov = i; charts.forEach(c => c.draw()); readout(i); routeDot(i); };
  function render() {
    charts.forEach(c => c.destroy()); charts.length = 0; const box = $('streams'); box.innerHTML = '';
    const on = M.filter(m => m.on), X = xs();
    on.forEach((m, j) => {
      const last = j === on.length - 1, d = document.createElement('div');
      d.style.cssText = `position:relative;height:${last ? 150 : 118}px`;
      d.innerHTML = `<canvas role="img" aria-label="${m.n} along the workout"></canvas>`; box.appendChild(d);
      const cv = d.firstChild, y = { reverse: !!m.rev, grid: { color: grid }, border: { display: false }, ticks: { maxTicksLimit: 4, callback: v => m.fmt(v) }, afterFit: s => { s.width = 48; } };
      if (m.robust) { const lo = pct(C[m.k], 0.02), hi = pct(C[m.k], 0.98), pad = (hi - lo) * 0.08; y.min = lo - pad; y.max = hi + pad; }
      const ch = new Chart(cv, { type: 'line',
        data: { datasets: [{ data: X.map((x, i) => ({ x, y: C[m.k][i] })), borderColor: m.col, backgroundColor: m.col + '22', fill: !!m.fill, borderWidth: 1.6, pointRadius: 0, tension: 0.25, spanGaps: true }] },
        options: { animation: false, responsive: true, maintainAspectRatio: false, events: [],
          plugins: { legend: { display: false }, tooltip: { enabled: false }, title: { display: true, text: m.n, align: 'start', color: ink, font: { size: 11, weight: 'normal' }, padding: { top: 0, bottom: 2 } } },
          scales: { x: { type: 'linear', min: X[0], max: X[X.length - 1], grid: { display: false }, border: { color: grid },
            ticks: { display: last, maxTicksLimit: 10, callback: v => xKey === 'km' ? (Math.round(v * 10) / 10) + ' km' : Math.round(v) + ' min' } }, y } },
        plugins: [bands, cross] });
      charts.push(ch);
      cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); setHover(nearest(ch.scales.x.getValueForPixel(e.clientX - r.left))); });
      cv.addEventListener('mouseleave', () => setHover(null));
    }); }
  $('tog').innerHTML = M.map((m, i) => `<button data-i="${i}" class="${m.on ? 'on' : ''}">${m.n.split(' (')[0]}</button>`).join('');
  $('tog').querySelectorAll('button').forEach(b => b.onclick = () => { const m = M[+b.dataset.i]; if (m.on && M.filter(x => x.on).length === 1) return; m.on = !m.on; b.classList.toggle('on', m.on); render(); });
  const setX = key => { if (!C[key]) return; xKey = key; $('xd').classList.toggle('on', key === 'km'); $('xt').classList.toggle('on', key === 't'); render(); };
  $('xd').onclick = () => setX('km'); $('xt').onclick = () => setX('t');
  render();

  $('laph').textContent = repLaps.size ? `Laps: ${repLaps.size} reps in blue, other laps grey` : 'Laps';
  if (D.laps.length) new Chart($('laps'), { type: 'bar',
    data: { labels: D.laps.map(l => l[0]), datasets: [{ data: D.laps.map(l => l[1]), backgroundColor: D.laps.map(l => l[3] ? accent : (dark ? '#5f5e5a' : '#b4b2a9')), borderRadius: 4, maxBarThickness: 24 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
      tooltip: { callbacks: { title: it => 'Lap ' + D.laps[it[0].dataIndex][0] + (D.laps[it[0].dataIndex][3] ? ' (rep)' : ''),
        label: it => { const l = D.laps[it.dataIndex]; return [`${l[4]} km in ${l[5]}`, (run ? 'Pace ' : 'Speed ') + spdLbl(l[1]) + (run ? ' /km' : ' km/h'), 'HR ' + (l[2] ? Math.round(l[2]) : '–')]; } } } },
      scales: { x: { grid: { display: false }, title: { display: true, text: 'Lap' } }, y: { min: Math.max(0, Math.min(...D.laps.map(l => l[1]).filter(Boolean)) * 0.85), grid: { color: grid }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: v => spdLbl(v) }, title: { display: true, text: run ? 'Pace (taller = faster)' : 'Speed (km/h)' } } } } });

  (function route() {
    const svg = $('route');
    if (!C.lat) { svg.innerHTML = `<text x="150" y="110" text-anchor="middle" font-size="12" fill="${ink}">No GPS track (indoor)</text>`; return; }
    const ok = C.lat.map((v, i) => v != null && C.lon[i] != null);
    const la = C.lat.filter((v, i) => ok[i]), lo = C.lon.filter((v, i) => ok[i]);
    const lat0 = (Math.min(...la) + Math.max(...la)) / 2, cx = Math.cos(lat0 * Math.PI / 180);
    const X = lo.map(v => v * cx), Y = la.map(v => -v), x0 = Math.min(...X), y0 = Math.min(...Y);
    const s = Math.min(280 / (Math.max(...X) - x0 || 1), 200 / (Math.max(...Y) - y0 || 1));
    const ox = (300 - (Math.max(...X) - x0) * s) / 2, oy = (220 - (Math.max(...Y) - y0) * s) / 2;
    proj = i => ok[i] ? [ox + (C.lon[i] * cx - x0) * s, oy + (-C.lat[i] - y0) * s] : null;
    const hr = C.hr || [], h0 = pct(hr, 0.05) ?? 0, h1 = pct(hr, 0.95) ?? 1;
    const ramp = ['#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F'];
    let prev = null, out = '';
    C.lat.forEach((v, i) => { const p = proj(i); if (!p) return;
      if (prev) { const t = hr[i] == null ? 0 : Math.max(0, Math.min(0.999, (hr[i] - h0) / (h1 - h0 || 1)));
        out += `<line x1="${prev[0].toFixed(1)}" y1="${prev[1].toFixed(1)}" x2="${p[0].toFixed(1)}" y2="${p[1].toFixed(1)}" stroke="${ramp[Math.floor(t * 5)]}" stroke-width="3" stroke-linecap="round"/>`; }
      prev = p; });
    const first = proj(ok.indexOf(true)), lastp = proj(ok.lastIndexOf(true));
    out += `<circle cx="${first[0]}" cy="${first[1]}" r="4" fill="#1baf7a"/><circle cx="${lastp[0]}" cy="${lastp[1]}" r="4" fill="none" stroke="${ink}" stroke-width="1.5"/><circle id="rdot" r="5" fill="${accent}" stroke="#fff" stroke-width="2" style="display:none"/>`;
    out += `<text x="4" y="216" font-size="11" fill="${ink}">HR ${Math.round(h0)}</text><rect x="44" y="208" width="60" height="6" rx="2" fill="url(#wkg)"/><text x="108" y="216" font-size="11" fill="${ink}">${Math.round(h1)}</text>`;
    svg.innerHTML = `<defs><linearGradient id="wkg">${ramp.map((c, i) => `<stop offset="${i / 4}" stop-color="${c}"/>`).join('')}</linearGradient></defs>` + out;
  })();

  const zc = ['#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C'];
  $('zones').innerHTML = D.zones.length ? D.zones.map((z, i) => `<div class="wk-z"><span title="${z[1]} bpm">${z[0]}</span><div style="background:var(--bg-neutral);border-radius:3px;height:12px"><div style="width:${z[2] || 0}%;height:12px;border-radius:3px;background:${zc[i]}"></div></div><span style="text-align:right">${Math.round(z[2] || 0)}%</span></div>`).join('') + `<div style="font-size:11px;color:${ink};margin-top:6px">${D.zones.map(z => z[0].split(' ')[0] + ' ' + z[1]).join(' · ')} bpm</div>` : `<div style="font-size:12px;color:${ink}">No heart-rate data</div>`;

  const P = D.sim.pts.filter(p => p[1] != null);
  $('simh').textContent = P.length > 1 ? `${D.sim.label} in similar sessions (this one in blue, click a point to analyse it)` : 'No comparable sessions found yet';
  if (P.length > 1) new Chart($('sim'), { type: 'line',
    data: { labels: P.map(p => p[0]), datasets: [{ data: P.map(p => p[1]), borderColor: dark ? '#5f5e5a' : '#b4b2a9', borderWidth: 1.5, tension: 0.2,
      pointRadius: P.map(p => p[4] ? 7 : 4), pointBackgroundColor: P.map(p => p[4] ? accent : '#888780'), pointBorderColor: surf, pointBorderWidth: 2, pointHoverRadius: 8 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: it => { const p = P[it.dataIndex]; return [(run ? 'Pace ' : 'Speed ') + spdLbl(p[1]), 'HR ' + (p[2] ? Math.round(p[2]) : '–')]; } } } },
      onClick: (e, el) => { if (!el.length) return; const p = P[el[0].index]; if (!p[4]) prompt(`Analyse workout ${p[3]} from ${p[0]}`); },
      onHover: (e, el) => { e.native.target.style.cursor = el.length ? 'pointer' : 'default'; },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } }, y: { grid: { color: grid }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: v => spdLbl(v) } } } } });
  else $('sim').parentNode.style.display = 'none';
  const cur = (D.sim.pts.find(p => p[4]) || [])[0] || '9999';
  const prevSim = P.filter(p => !p[4] && p[0] < cur).slice(-1)[0] || P.filter(p => !p[4]).slice(-1)[0];
  if (!prevSim) $('b1').style.display = 'none';
  $('b1').onclick = () => prevSim && prompt(`Compare workout ${D.id} with workout ${prevSim[3]} from ${prevSim[0]}`);
  $('b2').onclick = () => prompt(`What does workout ${D.id} tell me about my fitness and what should I change?`);
})(0);
