/* params.js - single source of truth for parameters + pure preset/model helpers.
   Loaded before engine.js and app.js. No DOM dependencies. */

/* Every tunable parameter's metadata (label, default, min/max/step, formatting)
   plus the default value of every other parameter. `defaultParams()` is derived
   from this so there is exactly one definition. */
var PARAMS = {
  // tunable (have min/max/step) -> become sliders
  dt:        { label: 'Timestep dt',          default: 300,   min: 120, max: 1800, step: 60,   fmt: function (v) { return v + ' s'; } },
  substeps:  { label: 'Substeps / frame',     default: 2,     min: 1,   max: 8,    step: 1 },
  omega:     { label: 'Rotation Ω',           default: 7.292e-5, min: 0, max: 3.6e-4, step: 1e-6, fmt: function (v) { return (v / 7.292e-5).toFixed(2) + '× Earth'; } },
  solar:     { label: 'Solar constant',       default: 1361,  min: 800, max: 2000, step: 10,   fmt: function (v) { return v + ' W/m²'; } },
  greenhouse:{ label: 'Greenhouse',           default: 0.55,  min: 0,   max: 1,    step: 0.01 },
  nuVelAir:  { label: 'Air viscosity ν',      default: 1.6e5, min: 0,   max: 6e5,  step: 1e4,  fmt: function (v) { return v.toExponential(1); } },
  nuTAir:    { label: 'Air heat diffusion',   default: 1.1e5, min: 0,   max: 6e5,  step: 1e4,  fmt: function (v) { return v.toExponential(1); } },
  fricAirLow:{ label: 'Surface friction',     default: 1.6e-5, min: 0, max: 8e-5, step: 1e-6, fmt: function (v) { return v.toExponential(1); } },
  conv:      { label: 'Convection gain',      default: 6e-6,  min: 0,   max: 3e-5, step: 5e-7, fmt: function (v) { return v.toExponential(1); } },
  kRad:      { label: 'Radiative exchange',   default: 2.5,   min: 0,   max: 8,    step: 0.1 },
  lapse:     { label: 'Reference lapse ΔT',   default: 45,    min: 20,  max: 70,   step: 1,    fmt: function (v) { return v + ' K'; } },
  evap:      { label: 'Evaporation k',        default: 0.005, min: 0,   max: 0.02, step: 0.0005, fmt: function (v) { return v.toFixed(4); } },
  kSurf:     { label: 'Sensible heat k',      default: 22,    min: 0,   max: 60,   step: 1,    fmt: function (v) { return v + ' W/m²K'; } },
  windStress:{ label: 'Wind stress',          default: 6e-8,  min: 0,   max: 3e-7, step: 5e-9, fmt: function (v) { return v.toExponential(1); } },
  thermo:    { label: 'Thermohaline mixing',  default: 2e-7,  min: 0,   max: 2e-6, step: 2e-8, fmt: function (v) { return v.toExponential(1); } },
  nuVelOcean:{ label: 'Ocean viscosity',      default: 6e3,   min: 0,   max: 4e4,  step: 1e3,  fmt: function (v) { return v.toExponential(1); } },
  cloudK:    { label: 'Cloud sensitivity',    default: 1.7,   min: 0,   max: 4,    step: 0.05 },
  noise:     { label: 'Symmetry-break noise', default: 0.02,  min: 0,   max: 0.2,  step: 0.005 },
  // non-tunable (default only; UI handled by checkboxes / mode / equirect buttons)
  running:        { default: true },
  nuTOcean:       { default: 4e3 },
  fricAirHigh:    { default: 2.5e-6 },
  fricOceanTop:   { default: 1.5e-6 },
  fricOceanDeep:  { default: 6e-7 },
  rainK:          { default: 2200 },
  dayNight:       { default: 1 },
  mode:           { default: 0 },
  showClouds:     { default: true },
  streamline:     { default: 2 },
  streamTrail:    { label: 'Streamline length', default: 6000, min: 0, max: 30000, step: 500,
                    fmt: function (v) { return v <= 0 ? 'dots' : (v / 60).toFixed(0) + ' min'; } },
  showLand:       { default: 1 },
  nightShading:   { default: 1 },
  relief:         { default: 0.004 },
  equirect:       { default: 0 },
};

/* Built-in presets: keyed maps of partial overrides ({ v?, min?, max?, step? }).
   Applying one only touches the listed keys; all other params stay intact. */
var BUILTIN_PRESETS = {
  'Default': null, // sentinel: means "restore defaults"
  'Earth-like': {
    dt: { v: 300 }, solar: { v: 1361 }, greenhouse: { v: 0.55 },
    omega: { v: 7.292e-5 }, evap: { v: 0.005 }, cloudK: { v: 1.7 }, noise: { v: 0.02 },
  },
  'Slow rotation': {
    omega: { v: 1.8e-5, min: 0, max: 3.6e-4, step: 1e-6 },
    lapse: { v: 55 }, conv: { v: 9e-6 },
  },
  'Hothouse': {
    solar: { v: 1700 }, greenhouse: { v: 0.85 }, evap: { v: 0.012, min: 0, max: 0.03, step: 0.0005 },
    kRad: { v: 1.2 }, cloudK: { v: 2.6 },
  },
};

function defaultParams() {
  var o = {};
  Object.keys(PARAMS).forEach(function (k) { o[k] = PARAMS[k].default; });
  return o;
}

/* Effective slider bounds for a key: per-instance override (from a preset)
   merged over the static PARAMS schema. */
function boundsOf(p, key) {
  var s = PARAMS[key];
  var o = p && p.bounds && p.bounds[key];
  return {
    min: o && o.min !== undefined ? o.min : s.min,
    max: o && o.max !== undefined ? o.max : s.max,
    step: o && o.step !== undefined ? o.step : s.step,
  };
}
function setBound(p, key, part) {
  if (!p.bounds) p.bounds = {};
  var cur = p.bounds[key] || {};
  if (part.min !== undefined) cur.min = part.min;
  if (part.max !== undefined) cur.max = part.max;
  if (part.step !== undefined) cur.step = part.step;
  p.bounds[key] = cur;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* Normalize a preset source into a keyed map { key: { v?, min?, max?, step? } }.
   Accepts either an object keyed by param key, or an array of entries each
   carrying a `key` field. */
function normalizePreset(src) {
  if (!src) return {};
  if (Array.isArray(src)) {
    var m = {};
    src.forEach(function (e) {
      if (e && e.key) {
        var o = {};
        if (e.v !== undefined) o.v = e.v;
        if (e.min !== undefined) o.min = e.min;
        if (e.max !== undefined) o.max = e.max;
        if (e.step !== undefined) o.step = e.step;
        m[e.key] = o;
      }
    });
    return m;
  }
  return src;
}
