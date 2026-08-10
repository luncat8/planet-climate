/* app.js - UI, modes/knobs, and bootstrap */
// rows top->bottom = high->low (row0 = High air). view->uMode; absent key = no data.
var LAYER_VIEW = {
  layers: [
    { id: 'highAir', label: 'High air' },
    { id: 'lowAir', label: 'Low air' },
    { id: 'ocean', label: 'Ocean' },
    { id: 'deepOcean', label: 'Deep ocean' },
  ],
  views: [
    { id: 'T', label: 'T', title: 'Temperature' },
    { id: 'P', label: 'P', title: 'Pressure' },
    { id: 'speed', label: 'Spd', title: 'Speed' },
    { id: 'humidity', label: 'Hum', title: 'Humidity' },
    { id: 'salinity', label: 'Sal', title: 'Salinity' },
    { id: 'rain', label: 'Rain', title: 'Rain' },
    { id: 'thick', label: 'h', title: 'Top-layer thickness (m)' },
  ],
  map: {
    highAir: { T: 9, P: 10, humidity: 11, speed: 12, rain: 6 },
    lowAir: { T: 0, P: 2, humidity: 3, speed: 4 },
    ocean: { T: 1, speed: 5, salinity: 7, thick: 15 },
    deepOcean: { T: 8, speed: 13, salinity: 14 },
  },
};

/* per-layer streamline colors, indexed by LAYER_VIEW.layers order */
var STREAM_COLORS = ['#ff3b3b', '#27e36b', '#3b82f6', '#f5f5f5'];

/* reverse lookup: mode number -> { layer label, view label } */
var VIEW_BY_ID = {};
LAYER_VIEW.views.forEach(function (v) { VIEW_BY_ID[v.id] = v; });
var MODE_INFO = {};
LAYER_VIEW.layers.forEach(function (layer) {
  var row = LAYER_VIEW.map[layer.id] || {};
  Object.keys(row).forEach(function (v) {
    var vi = VIEW_BY_ID[v];
    MODE_INFO[row[v]] = { layer: layer.label, view: vi ? vi.label : v };
  });
});

/* Merge a (partial) preset into the live planet: set v and/or bounds for the
   listed keys only. Unknown keys are ignored. (PARAMS, BUILTIN_PRESETS,
   normalizePreset, boundsOf, setBound, clamp are defined in params.js.) */
function applyPreset(src) {
  var p = ui.planet;
  if (!p) return;
  var map = normalizePreset(src);
  Object.keys(map).forEach(function (key) {
    if (!PARAMS[key]) return; // ignore unknown params
    var e = map[key];
    if (e.min !== undefined || e.max !== undefined || e.step !== undefined) {
      setBound(p, key, { min: e.min, max: e.max, step: e.step });
    }
    if (e.v !== undefined) {
      var b = boundsOf(p, key);
      p.params[key] = clamp(Number(e.v), b.min, b.max);
    }
  });
  syncSliders();
  refreshDynamic();
}

/* Re-sync every tuning slider to the current v and (possibly overridden) bounds. */
function syncSliders() {
  if (!ui.planet) return;
  var p = ui.planet;
  Object.keys(ui.knobInputs).forEach(function (key) {
    var inp = ui.knobInputs[key];
    var b = boundsOf(p, key);
    inp.min = b.min; inp.max = b.max; inp.step = b.step;
    inp.value = p.params[key];
  });
}

var ui = {
  planet: null,
  panel: true,
  tuning: false,
  level: 6,
  stats: { fps: 0, days: 0, cells: 0, level: 6 },
  err: null,
  // remembered sun rate so un-ticking "tidally locked" restores the old value
  lockedOrbit: 6.2831853 / 86400,
  // element refs
  runBtn: null,
  layerRadios: {},
  streamlineChecks: {},
  levelBtns: [],
  knobVals: {},
  knobInputs: {},
  checks: {},
  fpsEls: {},
  tuningSection: null,
  panelEl: null,
  tuningToggleBtn: null,
  panelToggleBtn: null,
  projBtn: null,
  vinfoEl: null,
  vinfoLayer: null,
  vinfoStreams: null,
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
  var keepBounds = p.bounds;
  var t = p.simTime; // keep the daylight/orbit phase continuous across resolution changes
  p.build(l);
  p.simTime = t;
  Object.keys(keep).forEach(function (key) { p.params[key] = keep[key]; });
  p.bounds = keepBounds;
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
  Object.keys(ui.layerRadios).forEach(function (m) {
    var inp = ui.layerRadios[m];
    var on = (P.mode === +m);
    inp.checked = on;
    inp.parentNode.classList.toggle('sel', on);
  });
  Object.keys(ui.streamlineChecks).forEach(function (i) {
    ui.streamlineChecks[i].checked = ((P.streamline >> +i) & 1) !== 0;
  });
  ui.levelBtns.forEach(function (b, i) {
    var l = 4 + i;
    b.className = 'mbtn' + (ui.level === l ? ' on' : '');
  });
  Object.keys(ui.checks).forEach(function (k) {
    ui.checks[k].checked = P[k] > 0.5;
  });
  if (ui.lockChk) ui.lockChk.checked = P.omegaOrbit < 1e-9;
  Object.keys(ui.knobVals).forEach(function (key) {
    var def = PARAMS[key];
    var v = P[key];
    ui.knobVals[key].textContent = def && def.fmt ? def.fmt(v) : String(v);
  });
  updateViewportInfo();
}

function updateViewportInfo() {
  if (!ui.vinfoEl || !ui.planet) return;
  var P = ui.planet.params;
  var mi = MODE_INFO[P.mode];
  ui.vinfoLayer.textContent = mi ? (mi.layer + ' · ' + mi.view) : ('mode ' + P.mode);
  var cont = ui.vinfoStreams;
  while (cont.firstChild) cont.removeChild(cont.firstChild);
  var any = false;
  for (var i = 0; i < LAYER_VIEW.layers.length; i++) {
    if (((P.streamline >> i) & 1) === 0) continue;
    any = true;
    var t = el('span', 'vtag', LAYER_VIEW.layers[i].label + ' speed');
    t.style.color = STREAM_COLORS[i];
    cont.appendChild(t);
  }
  if (!any) {
    var none = el('span', 'vtag', 'no streamlines');
    none.style.color = '#64748b';
    cont.appendChild(none);
  }
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
  var projBtn = el('button', 'btn proj', '🌐 globe');
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

  // viewport info (top center)
  var vinfo = el('div', 'vinfo');
  var vlabel = el('div', 'vlabel', 'rendering');
  var vlayer = el('div', 'vlayer', '');
  var vstreams = el('div', 'vstreams');
  vinfo.appendChild(vlabel);
  vinfo.appendChild(vlayer);
  vinfo.appendChild(vstreams);
  ui.vinfoEl = vinfo; ui.vinfoLayer = vlayer; ui.vinfoStreams = vstreams;
  app.appendChild(vinfo);

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
  var wrap = el('div', 'ltable-wrap');
  var table = el('table', 'ltable');
  var thead = document.createElement('thead');
  var hrow = document.createElement('tr');
  hrow.appendChild(el('th', 'lname', ''));
  LAYER_VIEW.views.forEach(function (v) {
    var th = el('th', null, v.label);
    th.title = v.title;
    hrow.appendChild(th);
  });
  var sth = el('th', 'stream', '≋');
  sth.title = 'Streamlines';
  hrow.appendChild(sth);
  thead.appendChild(hrow);
  table.appendChild(thead);
  var tbody = document.createElement('tbody');
  function setStreamBit(mask, i, on) { return on ? (mask | (1 << i)) : (mask & ~(1 << i)); }
  LAYER_VIEW.layers.forEach(function (layer, li) {
    var tr = document.createElement('tr');
    tr.appendChild(el('th', 'lname', layer.label));
    var row = LAYER_VIEW.map[layer.id] || {};
    LAYER_VIEW.views.forEach(function (v) {
      var mode = row[v.id];
      if (mode === undefined) {
        tr.appendChild(el('td', 'na', ''));
        return;
      }
      var td = el('td');
      var inp = document.createElement('input');
      inp.type = 'radio';
      inp.name = 'lview';
      inp.value = String(mode);
      inp.title = layer.label + ' — ' + v.title;
      inp.setAttribute('aria-label', layer.label + ' ' + v.title);
      inp.onchange = function () { setParam('mode', +this.value); };
      td.appendChild(inp);
      tr.appendChild(td);
      ui.layerRadios[mode] = inp;
    });
    var std = el('td', 'stream');
    var sw = el('span', 'swatch');
    sw.style.background = STREAM_COLORS[li];
    std.appendChild(sw);
    var sinp = document.createElement('input');
    sinp.type = 'checkbox';
    sinp.className = 'accent-cyan-400';
    sinp.title = layer.label + ' streamlines';
    sinp.setAttribute('aria-label', layer.label + ' streamlines');
    sinp.onchange = function () {
      setParam('streamline', setStreamBit(ui.planet.params.streamline, li, this.checked));
    };
    std.appendChild(sinp);
    tr.appendChild(std);
    ui.streamlineChecks[li] = sinp;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  // streamlines control: 0 = dots, >0 = streak length (kept visible, not in collapsed tuning)
  panel.appendChild(el('div', 'lab', 'Streamline length (0 = dots)'));
  var stWrap = el('div');
  var stKv = el('div', 'kv');
  stKv.appendChild(el('span', null, 'Streak'));
  var stVal = el('span', 'v', '');
  stKv.appendChild(stVal);
  stWrap.appendChild(stKv);
  var stInp = document.createElement('input');
  stInp.type = 'range';
  var stb = boundsOf(ui.planet, 'streamTrail');
  stInp.min = stb.min; stInp.max = stb.max; stInp.step = stb.step;
  stInp.value = ui.planet ? ui.planet.params.streamTrail : 6000;
  stInp.oninput = function () { setParam('streamTrail', parseFloat(stInp.value)); };
  stWrap.appendChild(stInp);
  panel.appendChild(stWrap);
  ui.knobVals['streamTrail'] = stVal;
  ui.knobInputs['streamTrail'] = stInp;
  var bar = el('div', 'bar');
  panel.appendChild(bar);
  var barlab = el('div', 'barlab');
  barlab.appendChild(el('span', null, 'low'));
  barlab.appendChild(el('span', null, 'high'));
  panel.appendChild(barlab);

  // checkboxes
  var chkDefs = [
    ['showClouds', 'Clouds & rain overlay'],
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

  // Tidal lock: freezes the sun's apparent motion (omegaOrbit = 0) while
  // leaving the planet's real spin -- and therefore Coriolis -- untouched.
  var lockLab = el('label', 'chk');
  var lockSpan = el('span', null, 'Tidally locked (freeze sun)');
  lockSpan.title = "Freezes the sun's apparent motion (omegaOrbit = 0) while leaving the planet's real spin — and thus Coriolis — untouched.";
  lockLab.appendChild(lockSpan);
  var lockInp = document.createElement('input');
  lockInp.type = 'checkbox';
  lockInp.className = 'accent-cyan-400';
  lockInp.onchange = function () {
    var P = ui.planet && ui.planet.params;
    if (!P) return;
    if (lockInp.checked) {
      if (P.omegaOrbit > 1e-9) ui.lockedOrbit = P.omegaOrbit;
      setParam('omegaOrbit', 0);
    } else {
      setParam('omegaOrbit', ui.lockedOrbit || PARAMS.omegaOrbit.default);
    }
    syncSliders();
  };
  ui.lockChk = lockInp;
  lockLab.appendChild(lockInp);
  panel.appendChild(lockLab);

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
  // build sliders for every tunable param (those carrying min/max/step in PARAMS)
  Object.keys(PARAMS).forEach(function (key) {
    var spec = PARAMS[key];
    if (spec.step === undefined) return;
    if (key === 'streamTrail') return;
    var wrap = el('div');
    wrap.style.marginBottom = '10px';
    var kv = el('div', 'kv');
    kv.appendChild(el('span', null, spec.label));
    var val = el('span', 'v', '');
    kv.appendChild(val);
    ui.knobVals[key] = val;
    wrap.appendChild(kv);
    var inp = document.createElement('input');
    inp.type = 'range';
    var b = boundsOf(ui.planet, key);
    inp.min = b.min; inp.max = b.max; inp.step = b.step;
    inp.value = ui.planet ? ui.planet.params[key] : spec.default;
    inp.oninput = function () { setParam(key, parseFloat(inp.value)); };
    ui.knobInputs[key] = inp;
    wrap.appendChild(inp);
    tuningSection.appendChild(wrap);
  });
  var restore = el('button', 'togbtn', 'restore defaults');
  restore.onclick = function () {
    var def = defaultParams();
    Object.keys(def).forEach(function (key) { ui.planet.params[key] = def[key]; });
    ui.planet.bounds = {};
    syncSliders();
    refreshDynamic();
  };
  tuningSection.appendChild(restore);
  ui.tuningSection = tuningSection;
  panel.appendChild(tuningSection);

  // presets
  panel.appendChild(el('div', 'lab', 'Presets'));
  var presetRow = el('div', 'row');
  var sel = document.createElement('select');
  sel.className = 'btn';
  Object.keys(BUILTIN_PRESETS).forEach(function (name) {
    var o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
  sel.onchange = function () {
    var name = sel.value;
    if (name === 'Default') {
      ui.planet.bounds = {};
      var def = defaultParams();
      Object.keys(def).forEach(function (key) { ui.planet.params[key] = def[key]; });
      syncSliders(); refreshDynamic();
    } else {
      applyPreset(BUILTIN_PRESETS[name]);
    }
  };
  presetRow.appendChild(sel);
  var loadBtn = el('button', 'btn', 'Load JSON');
  var fileInp = document.createElement('input');
  fileInp.type = 'file';
  fileInp.accept = '.json,application/json';
  fileInp.style.display = 'none';
  fileInp.onchange = function () {
    var f = fileInp.files && fileInp.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        applyPreset(JSON.parse(r.result));
      } catch (e) {
        showError('Invalid preset JSON: ' + (e && e.message ? e.message : e));
      }
    };
    r.readAsText(f);
    fileInp.value = '';
  };
  loadBtn.onclick = function () { fileInp.click(); };
  presetRow.appendChild(loadBtn);
  panel.appendChild(presetRow);
  panel.appendChild(fileInp);

  var expBtn = el('button', 'btn', 'Export current');
  expBtn.onclick = function () {
    var out = {};
    Object.keys(PARAMS).forEach(function (key) {
      var e = { v: ui.planet.params[key] };
      if (ui.planet.bounds && ui.planet.bounds[key]) {
        var b = ui.planet.bounds[key];
        if (b.min !== undefined) e.min = b.min;
        if (b.max !== undefined) e.max = b.max;
        if (b.step !== undefined) e.step = b.step;
      }
      out[key] = e;
    });
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'preset.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  panel.appendChild(expBtn);

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
