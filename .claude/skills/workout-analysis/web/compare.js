/* Workout comparison widget. Served from jsDelivr (pinned commit) and driven by window.WKC,
   which the fitness-workouts MCP server's compare_workouts tool embeds in its widget_html. */
(function boot(tries) {
  const root = document.getElementById('wkc');
  if (!root || !window.WKC || !window.Chart) { if (tries < 200) setTimeout(() => boot(tries + 1), 50); return; }
  const W = window.WKC.workouts;
  const st = document.createElement('style');
  st.textContent = `.cp-l{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text-secondary);margin:0 0 .75rem}
.cp-l span{display:flex;align-items:center;gap:5px}.cp-l i{width:14px;height:0;border-top:2px solid;display:inline-block}
.cp-h{font-size:13px;color:var(--text-secondary);margin:1.1rem 0 .3rem}
.cp-ro{font-size:12px;color:var(--text-secondary);min-height:18px;font-variant-numeric:tabular-nums}`;
  document.head.appendChild(st);
  root.innerHTML = `<div class="cp-l" id="leg"></div><div class="cp-ro" id="ro">Hover a chart to compare at the same distance</div><div id="charts"></div>
<div class="cp-h">Per-km splits</div><div style="position:relative;height:200px"><canvas id="splits" role="img" aria-label="Per-kilometre split times for each workout">Splits</canvas></div>`;
  const $ = id => document.getElementById(id);
  const mode = document.documentElement.dataset.mode;
  const dark = mode ? mode === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#898781', grid = dark ? '#2c2c2a' : '#e1e0d9';
  Chart.defaults.color = ink; Chart.defaults.font.size = 11;
  const PAL = dark ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  const DASH = [[], [6, 3], [2, 2], [8, 3, 2, 3], [1, 3]];
  const fp = v => { if (v == null || !isFinite(v) || v <= 0) return '–'; const s = Math.round(v * 60); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const name = w => w.date + ' · ' + (w.name.length > 34 ? w.name.slice(0, 33) + '…' : w.name);
  $('leg').innerHTML = W.map((w, i) => `<span><i style="border-color:${PAL[i]};border-top-style:${i ? 'dashed' : 'solid'}"></i>${name(w)}: ${w.km} km, ${w.pace || '–'}/km, HR ${w.avg_hr ? Math.round(w.avg_hr) : '–'}</span>`).join('');
  const pct = (a, q) => { const s = a.filter(v => v != null).sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
  const allPace = W.flatMap(w => w.stream.pace || []);
  const M = [{ k: 'pace', n: 'Pace (min/km)', fmt: fp, rev: true, min: pct(allPace, 0.02), max: pct(allPace, 0.98) },
    { k: 'hr', n: 'Heart rate (bpm)', fmt: v => Math.round(v) }, { k: 'ele', n: 'Elevation (m)', fmt: v => Math.round(v) }]
    .filter(m => W.some(w => (w.stream[m.k] || []).some(v => v != null)));
  const xmax = Math.max(...W.map(w => Math.max(...w.stream.km.filter(v => v != null))));
  let hx = null; const charts = [];
  const cross = { id: 'cross', afterDatasetsDraw(ch) { if (hx == null) return; const { ctx, chartArea: a, scales: { x } } = ch, px = x.getPixelForValue(hx);
    ctx.save(); ctx.strokeStyle = ink; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.restore(); } };
  const at = (w, k, x) => { let b = null, d = Infinity; w.stream.km.forEach((v, i) => { if (v != null && Math.abs(v - x) < d) { d = Math.abs(v - x); b = i; } }); return b == null || d > 0.3 ? null : (w.stream[k] || [])[b]; };
  const hover = x => { hx = x; charts.forEach(c => c.draw());
    $('ro').textContent = x == null ? 'Hover a chart to compare at the same distance' : x.toFixed(2) + ' km · ' + W.map((w, i) => `#${i + 1} ${fp(at(w, 'pace', x))} /km, HR ${at(w, 'hr', x) ? Math.round(at(w, 'hr', x)) : '–'}`).join(' · '); };
  M.forEach((m, j) => {
    const last = j === M.length - 1, d = document.createElement('div');
    d.style.cssText = `position:relative;height:${last ? 150 : 125}px`; d.innerHTML = `<canvas role="img" aria-label="${m.n} by distance for each workout"></canvas>`; $('charts').appendChild(d);
    const cv = d.firstChild, y = { reverse: !!m.rev, grid: { color: grid }, border: { display: false }, ticks: { maxTicksLimit: 4, callback: v => m.fmt(v) }, afterFit: s => { s.width = 48; } };
    if (m.min != null) { const p = (m.max - m.min) * 0.08; y.min = m.min - p; y.max = m.max + p; }
    const ch = new Chart(cv, { type: 'line', data: { datasets: W.map((w, i) => ({ data: w.stream.km.map((x, k) => ({ x, y: (w.stream[m.k] || [])[k] })), borderColor: PAL[i], borderDash: DASH[i], borderWidth: 1.6, pointRadius: 0, tension: 0.25, spanGaps: true })) },
      options: { animation: false, responsive: true, maintainAspectRatio: false, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false }, title: { display: true, text: m.n, align: 'start', color: ink, font: { size: 11, weight: 'normal' }, padding: { top: 0, bottom: 2 } } },
        scales: { x: { type: 'linear', min: 0, max: xmax, grid: { display: false }, border: { color: grid }, ticks: { display: last, maxTicksLimit: 10, callback: v => (Math.round(v * 10) / 10) + ' km' } }, y } }, plugins: [cross] });
    charts.push(ch);
    cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); hover(ch.scales.x.getValueForPixel(e.clientX - r.left)); });
    cv.addEventListener('mouseleave', () => hover(null)); });
  const n = Math.max(...W.map(w => w.km_splits_min.length));
  new Chart($('splits'), { type: 'bar', data: { labels: Array.from({ length: n }, (_, i) => 'km ' + (i + 1)),
    datasets: W.map((w, i) => ({ label: name(w), data: w.km_splits_min, backgroundColor: PAL[i], borderRadius: 3, maxBarThickness: 14 })) },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: it => `#${it.datasetIndex + 1} ${fp(it.raw)} /km` } } },
      scales: { x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 0 } }, y: { min: Math.max(0, Math.min(...W.flatMap(w => w.km_splits_min).filter(Boolean)) - 0.4), grid: { color: grid }, border: { display: false }, ticks: { maxTicksLimit: 5, callback: v => fp(v) }, title: { display: true, text: 'Split (lower = faster)' } } } } });
})(0);
