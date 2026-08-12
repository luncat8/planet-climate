/* screenshot.js - equirectangular ("projection map") screenshots with
   selectable capture configs (presets).

   A capture configuration ("preset") is a plain, JSON-serializable object:
     {
       name:    'Equirect · low-air speed @ 1000', // label for the dropdown
       step:    1000,      // target sim step (omit/undefined = current step)
       params:  {          // param overrides applied ONLY during capture
         equirect: 1, nightShading: 0, mode: 4
       },
       filename: 'proj.png',   // optional; derived from step if omitted
       download: true          // optional; auto-trigger the download
     }
   `params` may contain ANY planet.params key; only those keys are touched and
   are restored to their previous values afterwards. `running` is always paused
   during capture and restored.

   Default config = "Current view": no overrides, current step -> captures
   exactly what is on screen right now.

   A dropdown + [Screenshot] button are auto-installed into the control panel.
   Console:
     captureWithPreset(ui.planet, CAPTURE_PRESETS[1]);
     captureProjectionMap(ui.planet, { step: 1000, mode: 4 });
*/

/* Low-air layer, "speed" view -> mode number (see LAYER_VIEW.map in app.js). */
var MODE_LOW_AIR_SPEED = 4;

/* Catalog of capture configs shown in the dropdown. Add entries freely; the
   first one is the default selection. */
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

/* Generic capture: snapshot the override keys (+running), apply them, advance
   to the target step, render, capture, then restore the snapshot. Returns the
   save link element. */
function captureWithPreset(planet, preset) {
  if (!planet) throw new Error('captureWithPreset: planet instance required');
  preset = preset || {};
  var overrides = preset.params || {};
  var keys = Object.keys(overrides);

  var filename = preset.filename || ('projection_step_' +
    ((preset.step !== undefined) ? preset.step : planet.stepCount) + '.png');
  var autoDownload = preset.download !== false;

  // Snapshot exactly the values we are about to change.
  var saved = { running: planet.params.running };
  keys.forEach(function (k) { saved[k] = planet.params[k]; });

  // Apply overrides (and always pause the auto loop while we drive stepping).
  planet.params.running = 0;
  keys.forEach(function (k) { planet.params[k] = overrides[k]; });

  // Advance to the target step (no-op if already there or past it).
  var step = (preset.step !== undefined) ? preset.step : planet.stepCount;
  var need = step - planet.stepCount;
  for (var i = 0; i < need; i++) planet.step();

  // Render and capture in the same synchronous turn so the WebGL drawing
  // buffer is read before the compositor can clear it.
  planet.render();
  var url = planet.canvas.toDataURL('image/png');

  // Restore the previous view so the live globe/map is unaffected.
  keys.forEach(function (k) { planet.params[k] = saved[k]; });
  planet.params.running = saved.running;
  _refreshUI(planet);

  // Build a clickable link the user can use to save the screenshot, placed
  // under the day/year readout in the header panel.
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.textContent = 'Save: ' + (preset.name || ('projection step ' + step));
  a.className = 'projcap';
  a.style.cssText =
    'flex-basis:100%;margin-top:6px;pointer-events:auto;' +
    'background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);' +
    'border-radius:8px;padding:8px 12px;font-size:12px;color:#67e8f9;' +
    'text-decoration:none;cursor:pointer;backdrop-filter:blur(8px);' +
    '-webkit-backdrop-filter:blur(8px)';
  var mono = (typeof ui !== 'undefined' && ui && ui.fpsEls && ui.fpsEls.day)
    ? ui.fpsEls.day.parentElement
    : (document.querySelector('.hdr .mono') || document.body);
  mono.appendChild(a);

  if (autoDownload) {
    // Defer the auto-download one tick so the link is already in the DOM.
    setTimeout(function () { a.click(); }, 0);
  }

  return a;
}

/* Convenience wrappers over presets. */
function captureProjectionMap(planet, opts) {
  opts = opts || {};
  var preset = { params: {}, download: opts.download };
  if (opts.step !== undefined) preset.step = opts.step;
  if (opts.mode !== undefined) preset.params.mode = opts.mode;
  if (opts.filename) preset.filename = opts.filename;
  if (opts.equirect !== undefined) preset.params.equirect = opts.equirect;
  if (opts.nightShading !== undefined) preset.params.nightShading = opts.nightShading;
  return captureWithPreset(planet, preset);
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

/* Re-sync the UI controls after we've poked params directly (so the
   equirect/globe toggle button etc. reflect the restored state). */
function _refreshUI(planet) {
  if (typeof ui !== 'undefined' && ui && ui.planet === planet &&
      typeof refreshDynamic === 'function') {
    refreshDynamic();
  }
}

/* Build a [config dropdown] + [Screenshot] control and append it to the
   control panel (falls back to the document body). */
function installProjectionCaptureButtons(planet, container) {
  planet = planet || (typeof ui !== 'undefined' && ui && ui.planet);
  if (!planet) return null;
  container = container || (typeof ui !== 'undefined' && ui && ui.panelEl) || document.body;

  var wrap = document.createElement('div');
  wrap.className = 'projcap-row';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px';

  var lab = document.createElement('div');
  lab.className = 'lab';
  lab.textContent = 'Screenshot config';
  wrap.appendChild(lab);

  var sel = document.createElement('select');
  sel.className = 'btn';
  CAPTURE_PRESETS.forEach(function (p, i) {
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = p.name;
    sel.appendChild(o);
  });

  var btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = 'Screenshot';
  btn.onclick = function () {
    var idx = parseInt(sel.value, 10);
    var preset = CAPTURE_PRESETS[idx] || CAPTURE_PRESETS[0];
    captureWithPreset(planet, preset);
  };

  wrap.appendChild(sel);
  wrap.appendChild(btn);
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
