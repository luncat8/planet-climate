/* screenshot.js - equirectangular ("projection map") screenshots with
   selectable capture configs (presets), plus an "apply view preset" control.

   A capture configuration ("preset") is a plain, JSON-serializable object:
     {
       name:    'Equirect · low-air speed @ 1000', // dropdown label
       step:    1000,      // target sim step (omit/undefined = current step)
       params:  {          // param overrides applied during capture / applied to view
         equirect: 1, nightShading: 0, mode: 4
       },
       filename: 'proj.png',   // optional; derived from step+seed+time if omitted
       download: true          // optional; auto-trigger the download
     }
   `params` may contain ANY planet.params key; only those keys are touched and
   are restored afterwards (for screenshots) or set persistently (for view apply).
   The same CAPTURE_PRESETS list drives BOTH the screenshot dropdown and the
   "apply to view" dropdown.

   UI installed into the control panel:
     • Screenshot config  [dropdown]  [Screenshot]
     • [Copy current view as preset]
     • Captures:  <progress>  <single latest save link>
     • Apply view preset  [dropdown]  [Apply]
*/

/* Low-air layer, "speed" view -> mode number (see LAYER_VIEW.map in app.js). */
var MODE_LOW_AIR_SPEED = 4;

/* Keys snapshotted by "copy current view as preset" (the meaningful view state). */
var VIEW_KEYS = [
  'equirect', 'nightShading', 'mode', 'showClouds', 'showLand',
  'relief', 'streamline', 'streamTrail', 'dayNight',
];

/* Catalog of capture configs shown in both dropdowns. The first is the default
   selection. Add entries freely. */
var CAPTURE_PRESETS = [
  { name: 'Current view', step: undefined, params: {} },
  {
    name: 'Equirect · low-air speed @ 1000',
    step: 1000,
    params: { equirect: 1, nightShading: 0, mode: MODE_LOW_AIR_SPEED },
  },
  {
    name: 'Equirect · current step',
    step: undefined,
    params: { equirect: 1, nightShading: 0 },
  },
  {
    name: 'Equirect · no night @ 1000',
    step: 1000,
    params: { equirect: 1, nightShading: 0 },
  },
  {
    name: 'Globe · current step',
    step: undefined,
    params: { equirect: 0 },
  },
];

var STEP_CHUNK = 50; // sim steps advanced per animation frame (keeps UI responsive)

/* Module-level handles for the Captures section. */
var _capturesBox = null;
var _progressEl = null;
var _lastLink = null;

/* ---- filename helper: step + seed + compact timestamp ---- */
function _makeFilename(step, seed) {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  var ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + 'T' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  var sd = (seed === undefined ? '' : '_s' + seed);
  return 'projection_step' + step + sd + '_' + ts + '.png';
}

/* ---- chunked stepping so long runs show progress and don't freeze the tab ---- */
function _stepChunked(planet, targetStep, onProgress, onDone) {
  function tick() {
    if (planet.stepCount >= targetStep) {
      if (onProgress) onProgress(planet.stepCount, targetStep);
      if (onDone) onDone();
      return;
    }
    var n = Math.min(STEP_CHUNK, targetStep - planet.stepCount);
    for (var i = 0; i < n; i++) planet.step();
    if (onProgress) onProgress(planet.stepCount, targetStep);
    if (planet.stepCount < targetStep) requestAnimationFrame(tick);
    else if (onDone) onDone();
  }
  tick();
}

/* ---- Captures section DOM (created lazily if not installed) ---- */
function _ensureCapturesUI() {
  if (_capturesBox) return { box: _capturesBox, progress: _progressEl };
  var box = document.createElement('div');
  box.className = 'projcap-captures';
  var prog = document.createElement('div');
  prog.className = 'projcap-progress';
  prog.style.cssText = 'font-size:11px;color:#94a3b8;min-height:14px;margin-bottom:4px';
  box.appendChild(prog);
  _capturesBox = box; _progressEl = prog;
  var container = (typeof ui !== 'undefined' && ui && ui.panelEl) ? ui.panelEl : document.body;
  container.appendChild(box);
  return { box: box, progress: prog };
}
function _setProgress(cur, total) {
  if (_progressEl) _progressEl.textContent = 'stepping ' + cur + '/' + total;
}
function _clearProgress() {
  if (_progressEl) _progressEl.textContent = '';
}
function _addCaptureLink(url, filename, label) {
  var ui2 = _ensureCapturesUI();
  if (_lastLink && _lastLink.parentNode) _lastLink.parentNode.removeChild(_lastLink);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = 'Save: ' + label;
  a.className = 'projcap';
  a.style.cssText =
    'display:block;margin-top:6px;pointer-events:auto;' +
    'background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);' +
    'border-radius:8px;padding:8px 12px;font-size:12px;color:#67e8f9;' +
    'text-decoration:none;cursor:pointer;backdrop-filter:blur(8px);' +
    '-webkit-backdrop-filter:blur(8px)';
  ui2.box.appendChild(a);
  _lastLink = a;
  return a;
}

/* ---- re-sync UI controls after poking params directly ---- */
function _refreshUI(planet) {
  if (typeof ui !== 'undefined' && ui && ui.planet === planet &&
      typeof refreshDynamic === 'function') {
    refreshDynamic();
  }
}

/* ---- core async capture ---- */
function captureWithPreset(planet, preset, opts) {
  if (!planet) throw new Error('captureWithPreset: planet instance required');
  opts = opts || {};
  preset = preset || {};
  var overrides = preset.params || {};
  var keys = Object.keys(overrides);
  var autoDownload = preset.download !== false;
  var targetStep = (preset.step !== undefined) ? preset.step : planet.stepCount;
  var filename = preset.filename || _makeFilename(targetStep, planet.params.seed);

  // Snapshot exactly the values we are about to change.
  var saved = { running: planet.params.running };
  keys.forEach(function (k) { saved[k] = planet.params[k]; });

  // Apply overrides and pause the auto loop while we drive stepping.
  planet.params.running = 0;
  keys.forEach(function (k) { planet.params[k] = overrides[k]; });

  function finish() {
    // Render + capture in the same synchronous turn so the GL buffer is read
    // before the compositor can clear it.
    planet.render();
    var url = planet.canvas.toDataURL('image/png');
    // Restore the previous view.
    keys.forEach(function (k) { planet.params[k] = saved[k]; });
    planet.params.running = saved.running;
    _refreshUI(planet);
    _clearProgress();
    var a = _addCaptureLink(url, filename, preset.name || ('projection step ' + targetStep));
    if (autoDownload) setTimeout(function () { a.click(); }, 0);
    if (opts.onDone) opts.onDone(a);
  }

  _stepChunked(planet, targetStep, opts.onProgress, finish);
}

/* ---- apply the same preset to the LIVE view (persistent, not restored) ---- */
function applyViewPreset(planet, preset, opts) {
  if (!planet) throw new Error('applyViewPreset: planet instance required');
  opts = opts || {};
  preset = preset || {};
  var overrides = preset.params || {};
  var keys = Object.keys(overrides);
  var savedRunning = planet.params.running;
  keys.forEach(function (k) { planet.params[k] = overrides[k]; });
  var targetStep = (preset.step !== undefined) ? preset.step : planet.stepCount;
  // Pause the auto loop while we advance so it doesn't also step.
  planet.params.running = 0;
  _stepChunked(planet, targetStep, opts.onProgress, function () {
    planet.params.running = savedRunning;
    _refreshUI(planet);
    if (opts.onDone) opts.onDone();
  });
  return planet;
}

/* ---- build a preset from the current view and copy it to the clipboard ---- */
function copyCurrentViewPreset(planet) {
  if (!planet) throw new Error('copyCurrentViewPreset: planet instance required');
  var params = {};
  VIEW_KEYS.forEach(function (k) {
    if (planet.params[k] !== undefined) params[k] = planet.params[k];
  });
  var preset = { name: 'Custom @ step ' + planet.stepCount, step: planet.stepCount, params: params };
  _copyText(JSON.stringify(preset, null, 2));
  return preset;
}
function _copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function () { _copyTextFallback(text); });
  } else {
    _copyTextFallback(text);
  }
}
function _copyTextFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

/* ---- convenience wrappers (async; link returned via opts.onDone) ---- */
function captureProjectionMap(planet, opts) {
  opts = opts || {};
  var preset = { params: {}, download: opts.download };
  if (opts.step !== undefined) preset.step = opts.step;
  if (opts.mode !== undefined) preset.params.mode = opts.mode;
  if (opts.filename) preset.filename = opts.filename;
  if (opts.equirect !== undefined) preset.params.equirect = opts.equirect;
  if (opts.nightShading !== undefined) preset.params.nightShading = opts.nightShading;
  if (opts.name) preset.name = opts.name;
  return captureWithPreset(planet, preset, opts);
}
function captureProjectionMapNow(planet, opts) {
  opts = opts || {};
  opts.step = planet.stepCount;
  return captureProjectionMap(planet, opts);
}
function captureProjectionMapAtStep(planet, step, opts) {
  opts = opts || {};
  opts.step = (step !== undefined) ? step : 1000;
  return captureProjectionMap(planet, opts);
}

/* ---- install the control panel UI ---- */
function installProjectionCaptureButtons(planet, container) {
  planet = planet || (typeof ui !== 'undefined' && ui && ui.planet);
  if (!planet) return null;
  container = container || (typeof ui !== 'undefined' && ui && ui.panelEl) || document.body;

  var wrap = document.createElement('div');
  wrap.className = 'projcap-section';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px;' +
    'border-top:1px solid rgba(255,255,255,.1);padding-top:12px';

  function lab(t) {
    var e = document.createElement('div');
    e.className = 'lab';
    e.textContent = t;
    return e;
  }
  function btn(t) {
    var e = document.createElement('button');
    e.className = 'btn';
    e.textContent = t;
    return e;
  }
  function sel() {
    var e = document.createElement('select');
    e.className = 'btn';
    CAPTURE_PRESETS.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      e.appendChild(o);
    });
    return e;
  }
  function row() {
    var e = document.createElement('div');
    e.className = 'row';
    return e;
  }

  // --- Screenshot config ---
  wrap.appendChild(lab('Screenshot config'));
  var cfgRow = row();
  var cfgSel = sel();
  var shotBtn = btn('Screenshot');
  shotBtn.style.flex = '1';
  cfgRow.appendChild(cfgSel);
  cfgRow.appendChild(shotBtn);
  wrap.appendChild(cfgRow);

  var clipBtn = btn('Copy current view as preset');
  wrap.appendChild(clipBtn);

  // --- Captures (progress + single latest link) ---
  wrap.appendChild(lab('Captures'));
  var capBox = document.createElement('div');
  capBox.className = 'projcap-captures';
  var prog = document.createElement('div');
  prog.className = 'projcap-progress';
  prog.style.cssText = 'font-size:11px;color:#94a3b8;min-height:14px;margin-bottom:4px';
  capBox.appendChild(prog);
  wrap.appendChild(capBox);
  _capturesBox = capBox;
  _progressEl = prog;

  // --- Apply view preset (applies immediately on selection) ---
  wrap.appendChild(lab('Apply view preset'));
  var viewSel = sel();
  wrap.appendChild(viewSel);

  // wire events
  shotBtn.onclick = function () {
    var idx = parseInt(cfgSel.value, 10);
    var preset = CAPTURE_PRESETS[idx] || CAPTURE_PRESETS[0];
    captureWithPreset(planet, preset, { onProgress: _setProgress, onDone: _clearProgress });
  };
  clipBtn.onclick = function () {
    var p = copyCurrentViewPreset(planet);
    if (_progressEl) _progressEl.textContent = 'preset copied (' + p.name + ')';
    setTimeout(_clearProgress, 1500);
  };
  viewSel.onchange = function () {
    var idx = parseInt(viewSel.value, 10);
    var preset = CAPTURE_PRESETS[idx] || CAPTURE_PRESETS[0];
    applyViewPreset(planet, preset, { onProgress: _setProgress, onDone: _clearProgress });
  };

  container.appendChild(wrap);
  return wrap;
}

// Auto-install the controls once the UI is ready.
var _projCapInstalled = false;
function _autoInstallProjCap() {
  if (_projCapInstalled) return;
  var p = (typeof ui !== 'undefined' && ui && ui.planet) ? ui.planet : null;
  if (!p) return;
  _projCapInstalled = true;
  installProjectionCaptureButtons(p);
}
if (typeof window !== 'undefined') {
  window.captureWithPreset = captureWithPreset;
  window.applyViewPreset = applyViewPreset;
  window.copyCurrentViewPreset = copyCurrentViewPreset;
  window.captureProjectionMap = captureProjectionMap;
  window.captureProjectionMapNow = captureProjectionMapNow;
  window.captureProjectionMapAtStep = captureProjectionMapAtStep;
  window.CAPTURE_PRESETS = CAPTURE_PRESETS;
  window.installProjectionCaptureButtons = installProjectionCaptureButtons;
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', _autoInstallProjCap);
  } else {
    _autoInstallProjCap();
  }
}
