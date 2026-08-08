/* app.js - UI, modes/knobs, and bootstrap */
var MODES = [
  'Air temp (low)', 'Surface temp', 'Sea-level pressure', 'Humidity',
  'Wind speed', 'Ocean current', 'Rain', 'Salinity', 'Deep ocean temp', 'Air temp (high)',
];

var KNOBS = [
  { key: 'dt', label: 'Timestep dt', min: 300, max: 3600, step: 60, fmt: function (v) { return v + ' s'; } },
  { key: 'substeps', label: 'Substeps / frame', min: 1, max: 8, step: 1 },
  { key: 'omega', label: 'Rotation Ω', min: 0, max: 3.6e-4, step: 1e-6, fmt: function (v) { return (v / 7.292e-5).toFixed(2) + '× Earth'; } },
  { key: 'solar', label: 'Solar constant', min: 800, max: 2000, step: 10, fmt: function (v) { return v + ' W/m²'; } },
  { key: 'greenhouse', label: 'Greenhouse', min: 0, max: 1, step: 0.01 },
  { key: 'nuVelAir', label: 'Air viscosity ν', min: 0, max: 6e5, step: 1e4, fmt: function (v) { return v.toExponential(1); } },
  { key: 'nuTAir', label: 'Air heat diffusion', min: 0, max: 6e5, step: 1e4, fmt: function (v) { return v.toExponential(1); } },
  { key: 'fricAirLow', label: 'Surface friction', min: 0, max: 8e-5, step: 1e-6, fmt: function (v) { return v.toExponential(1); } },
  { key: 'conv', label: 'Convection gain', min: 0, max: 3e-5, step: 5e-7, fmt: function (v) { return v.toExponential(1); } },
  { key: 'kRad', label: 'Radiative exchange', min: 0, max: 8, step: 0.1 },
  { key: 'lapse', label: 'Reference lapse ΔT', min: 20, max: 70, step: 1, fmt: function (v) { return v + ' K'; } },
  { key: 'evap', label: 'Evaporation k', min: 0, max: 0.02, step: 0.0005, fmt: function (v) { return v.toFixed(4); } },
  { key: 'kSurf', label: 'Sensible heat k', min: 0, max: 60, step: 1, fmt: function (v) { return v + ' W/m²K'; } },
  { key: 'windStress', label: 'Wind stress', min: 0, max: 3e-7, step: 5e-9, fmt: function (v) { return v.toExponential(1); } },
  { key: 'thermo', label: 'Thermohaline mixing', min: 0, max: 2e-6, step: 2e-8, fmt: function (v) { return v.toExponential(1); } },
  { key: 'nuVelOcean', label: 'Ocean viscosity', min: 0, max: 4e4, step: 1e3, fmt: function (v) { return v.toExponential(1); } },
  { key: 'cloudK', label: 'Cloud sensitivity', min: 0, max: 4, step: 0.05 },
  { key: 'noise', label: 'Symmetry-break noise', min: 0, max: 0.2, step: 0.005 },
];

var ui = {
  planet: null,
  panel: true,
  tuning: false,
  level: 5,
  stats: { fps: 0, days: 0, cells: 0, level: 5 },
  err: null,
  // element refs
  runBtn: null,
  modeBtns: [],
  levelBtns: [],
  knobVals: {},
  checks: {},
  fpsEls: {},
  tuningSection: null,
  panelEl: null,
  tuningToggleBtn: null,
  panelToggleBtn: null,
  projBtn: null,
};

function el(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

function setParam(k, v) {
  if (ui.planet) ui.planet.params[k] = v;
  refreshDynamic();
}
function rebuild(l) {
  ui.level = l;
  var p = ui.planet;
  if (!p) return;
  var keep = {};
  Object.keys(p.params).forEach(function (key) { keep[key] = p.params[key]; });
  p.build(l);
  Object.keys(keep).forEach(function (key) { p.params[key] = keep[key]; });
  refreshDynamic();
}

function refreshDynamic() {
  var P = ui.planet ? ui.planet.params : defaultParams();
  if (ui.runBtn) {
    ui.runBtn.textContent = P.running ? '❚❚ pause' : '▶ run';
    ui.runBtn.className = 'btn flex1 ' + (P.running ? 'run on' : 'run off');
    ui.runBtn.style.flex = '1';
  }
  if (ui.projBtn) {
    ui.projBtn.textContent = (P.equirect > 0.5 ? '🗺 map' : '🌐 globe');
  }
  ui.modeBtns.forEach(function (b, i) {
    b.className = 'mbtn' + (P.mode === i ? ' on' : '');
  });
  ui.levelBtns.forEach(function (b, i) {
    var l = 4 + i;
    b.className = 'mbtn' + (ui.level === l ? ' on' : '');
  });
  Object.keys(ui.checks).forEach(function (k) {
    ui.checks[k].checked = P[k] > 0.5;
  });
  Object.keys(ui.knobVals).forEach(function (key) {
    var k = KNOBS.find(function (x) { return x.key === key; });
    var v = P[key];
    ui.knobVals[key].textContent = k.fmt ? k.fmt(v) : String(v);
  });
}

function buildUI() {
  var app = document.getElementById('app');

  // header
  var hdr = el('div', 'hdr');
  var box = el('div', 'box');
  box.appendChild(el('div', 'title', 'GEODESIC PLANET · GPU CLIMATE ENGINE'));
  var sub = el('div', 'sub');
  sub.textContent = 'icosahedral dual-hex grid · ';
  var cellSpan = el('span');
  cellSpan.textContent = '0';
  sub.appendChild(cellSpan);
  sub.appendChild(document.createTextNode(' cells (L'));
  var lvlSpan = el('span'); lvlSpan.textContent = '5';
  sub.appendChild(lvlSpan);
  sub.appendChild(document.createTextNode(') · 4 stacked fluid layers · all state on the GPU'));
  box.appendChild(sub);
  var mono = el('div', 'mono');
  var fpsEl = el('span', 'g', '0 fps');
  var dayEl = el('span', 'a', 'day 0.0');
  var yrEl = el('span', 's', '0.00 yr');
  mono.appendChild(fpsEl); mono.appendChild(dayEl); mono.appendChild(yrEl);
  box.appendChild(mono);
  ui.fpsEls = { cellSpan: cellSpan, lvlSpan: lvlSpan, fps: fpsEl, day: dayEl, yr: yrEl };

  hdr.appendChild(box);
  var projBtn = el('button', 'btn', '🌐 globe');
  projBtn.title = 'Toggle sphere / equirectangular (hover or press)';
  var projOver = false;
  function toggleProj() {
    setParam('equirect', ui.planet.params.equirect > 0.5 ? 0 : 1);
  }
  projBtn.addEventListener('pointerenter', function () { projOver = true; toggleProj(); });
  projBtn.addEventListener('pointerleave', function () { projOver = false; });
  projBtn.addEventListener('pointerdown', function (e) { if (!projOver) toggleProj(); });
  ui.projBtn = projBtn;
  hdr.appendChild(projBtn);
  var panelToggle = el('button', 'btn', 'hide panel');
  panelToggle.onclick = function () {
    ui.panel = !ui.panel;
    panelToggle.textContent = ui.panel ? 'hide panel' : 'show panel';
    ui.panelEl.style.display = ui.panel ? '' : 'none';
  };
  ui.panelToggleBtn = panelToggle;
  hdr.appendChild(panelToggle);
  app.appendChild(hdr);

  // panel
  var panel = el('div', 'panel');
  ui.panelEl = panel;

  // run / reset
  var row = el('div', 'row');
  var runBtn = el('button', 'btn', '❚❚ pause');
  runBtn.style.flex = '1';
  runBtn.onclick = function () { setParam('running', !ui.planet.params.running); };
  var resetBtn = el('button', 'btn', '↻ reset');
  resetBtn.style.flex = '1';
  resetBtn.onclick = function () { ui.planet.reset(); };
  row.appendChild(runBtn); row.appendChild(resetBtn);
  ui.runBtn = runBtn;
  panel.appendChild(row);

  // layer view
  panel.appendChild(el('div', 'lab', 'Layer view'));
  var grid2 = el('div', 'grid2');
  MODES.forEach(function (m, i) {
    var b = el('button', 'mbtn', m);
    b.onclick = function () { setParam('mode', i); };
    ui.modeBtns.push(b);
    grid2.appendChild(b);
  });
  panel.appendChild(grid2);
  var bar = el('div', 'bar');
  panel.appendChild(bar);
  var barlab = el('div', 'barlab');
  barlab.appendChild(el('span', null, 'low'));
  barlab.appendChild(el('span', null, 'high'));
  panel.appendChild(barlab);

  // checkboxes
  var chkDefs = [
    ['showClouds', 'Clouds & rain overlay'],
    ['showParticles', 'Wind streamlines'],
    ['particleOcean', 'Streamlines follow ocean'],
    ['dayNight', 'Day / night cycle'],
    ['nightShading', 'Night shading'],
    ['showLand', 'Show continents'],
  ];
  chkDefs.forEach(function (d) {
    var lab = el('label', 'chk');
    lab.appendChild(el('span', null, d[1]));
    var inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.className = 'accent-cyan-400';
    inp.onchange = function () { setParam(d[0], inp.checked ? 1 : 0); };
    ui.checks[d[0]] = inp;
    lab.appendChild(inp);
    panel.appendChild(lab);
  });

  // subdivision level
  panel.appendChild(el('div', 'lab', 'Subdivision level'));
  var lvlRow = el('div', 'row');
  [4, 5, 6, 7].forEach(function (l, idx) {
    var b = el('button', 'mbtn', 'L' + l);
    var sub2 = el('div');
    sub2.style.fontSize = '9px';
    sub2.style.opacity = '0.6';
    sub2.textContent = (10 * Math.pow(4, l) + 2).toLocaleString();
    b.appendChild(sub2);
    b.style.flex = '1';
    b.onclick = function () { rebuild(l); };
    ui.levelBtns.push(b);
    lvlRow.appendChild(b);
  });
  panel.appendChild(lvlRow);

  // tuning
  var tuningToggle = el('button', 'togbtn', '▸ physics tuning knobs');
  ui.tuningToggleBtn = tuningToggle;
  tuningToggle.onclick = function () {
    ui.tuning = !ui.tuning;
    tuningToggle.textContent = (ui.tuning ? '▾' : '▸') + ' physics tuning knobs';
    tuningSection.style.display = ui.tuning ? '' : 'none';
  };
  panel.appendChild(tuningToggle);
  var tuningSection = el('div');
  tuningSection.style.display = 'none';
  tuningSection.style.marginTop = '8px';
  KNOBS.forEach(function (k) {
    var wrap = el('div');
    wrap.style.marginBottom = '10px';
    var kv = el('div', 'kv');
    kv.appendChild(el('span', null, k.label));
    var val = el('span', 'v', '');
    kv.appendChild(val);
    ui.knobVals[k.key] = val;
    wrap.appendChild(kv);
    var inp = document.createElement('input');
    inp.type = 'range';
    inp.min = k.min; inp.max = k.max; inp.step = k.step;
    inp.value = defaultParams()[k.key];
    inp.oninput = function () { setParam(k.key, parseFloat(inp.value)); };
    wrap.appendChild(inp);
    tuningSection.appendChild(wrap);
  });
  var restore = el('button', 'togbtn', 'restore defaults');
  restore.onclick = function () {
    var def = defaultParams();
    Object.keys(def).forEach(function (key) { ui.planet.params[key] = def[key]; });
    // sync slider positions
    tuningSection.querySelectorAll('input[type=range]').forEach(function (inp, idx) {
      inp.value = def[KNOBS[idx].key];
    });
    refreshDynamic();
  };
  tuningSection.appendChild(restore);
  ui.tuningSection = tuningSection;
  panel.appendChild(tuningSection);

  var desc = el('p', 'desc',
    'drag to orbit · wheel to zoom. Winds, ocean gyres, Hadley/Ferrel-like cells and ' +
    'storm bands are emergent: nothing is scripted. Only pressure is diagnosed; ' +
    'everything else is integrated on the dual hexagonal grid with flux-form upwind ' +
    'advection and finite-volume operators.');
  panel.appendChild(desc);

  app.appendChild(panel);

  // error overlay (created later if needed)
  ui.errBox = null;
}

function showError(msg) {
  if (ui.errBox) return;
  var app = document.getElementById('app');
  var wrap = el('div', 'err');
  var box = el('div', 'errbox');
  box.appendChild(el('h2', null, 'WebGL2 error'));
  box.appendChild(el('p', null, msg));
  wrap.appendChild(box);
  ui.errBox = wrap;
  app.appendChild(wrap);
}

function boot() {
  var canvas = document.getElementById('c');
  buildUI();
  try {
    var p = new Planet(canvas, 5);
    p.onStats = function (s) {
      ui.stats = s;
      ui.fpsEls.fps.textContent = s.fps.toFixed(0) + ' fps';
      ui.fpsEls.day.textContent = 'day ' + s.days.toFixed(1);
      ui.fpsEls.yr.textContent = (s.days / 365).toFixed(2) + ' yr';
      ui.fpsEls.cellSpan.textContent = s.cells.toLocaleString();
      ui.fpsEls.lvlSpan.textContent = String(s.level);
    };
    ui.planet = p;
    refreshDynamic();
  } catch (e) {
    showError(e && e.message ? e.message : String(e));
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
