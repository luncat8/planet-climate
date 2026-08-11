/* params.js - single source of truth for parameters + pure preset/model helpers.
   Loaded before engine.js and app.js. No DOM dependencies. */

/* Every tunable parameter's metadata (label, default, min/max/step, formatting)
   plus the default value of every other parameter. `defaultParams()` is derived
   from this so there is exactly one definition. */
var PARAMS = {
  // tunable (have min/max/step) -> become sliders
  dt:        { label: 'Timestep dt',          default: 120,   min: 120, max: 1800, step: 60,   fmt: function (v) { return v + ' s'; } },
  substeps:  { label: 'Substeps / frame',     default: 4,     min: 1,   max: 8,    step: 1 },
  /* Physical spin rate (rad/s) — drives the real 3-D Coriolis force. A tidally
     locked planet still rotates once per orbit in the inertial frame, so this
     should generally stay non-zero even when omegaOrbit = 0. */
  omegaSpin: { label: 'Spin Ω (Coriolis)',    default: 7.292e-5, min: 0, max: 3.6e-4, step: 1e-6, fmt: function (v) { return (v / 7.292e-5).toFixed(2) + '× Earth'; } },
  /* Apparent angular rate (rad/s) of the sub-solar point sliding across the
     surface — i.e. the day/night cycle. Independent of omegaSpin: set to 0 to
     freeze the sun (tidal lock) while Coriolis keeps spinning. */
  omegaOrbit:{ label: 'Sun angular rate',     default: 6.2831853 / 86400, min: 0, max: 3e-4, step: 1e-6,
               fmt: function (v) { return v > 1e-8 ? (6.2831853 / v / 3600).toFixed(1) + ' h/day' : 'frozen (locked)'; } },
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
  windStress:{ label: 'Wind stress (air-side)', default: 2e-6, min: 0, max: 1e-5, step: 1e-7, fmt: function (v) { return v.toExponential(1); } },
  thermo:    { label: 'Thermohaline mixing',  default: 2e-7,  min: 0,   max: 2e-6, step: 2e-8, fmt: function (v) { return v.toExponential(1); } },
  /* Inter-layer mechanical drag coefficient (kg/m^3/s). The shear stress
     tau = (oceanDrag + mechanicalFric) * |u_top - u_deep| * (u_top - u_deep)
     is applied equally and oppositely to the two layers, weighted by inverse
     column mass (rho*h), so total ocean momentum is conserved exactly. */
  oceanDrag:      { label: 'Inter-layer drag r',    default: 2.5e-3, min: 0, max: 2e-2, step: 5e-5, fmt: function (v) { return v.toExponential(1); } },
  /* Purely mechanical friction between the layers: identical in form to
     oceanDrag but conceptually independent of the density stratification
     (unlike the thermohaline exchange). Combined into one effective coeff. */
  mechanicalFric: { label: 'Mechanical friction',   default: 1e-3, min: 0, max: 5e-3, step: 1e-4, fmt: function (v) { return v.toExponential(1); } },
  /* Stratification dependence of the inter-layer drag. The effective drag is
     uDrag * mix(1, 1/(1+5*Ri)^2, stratDrag) with the bulk Richardson number
     Ri = g'*h_top/|u_top-u_deep|^2, so a strong pycnocline nearly shuts the
     vertical momentum exchange off while a weakly stratified, strongly sheared
     column keeps the full drag. 0 reproduces the old constant-drag behaviour. */
  stratDrag:      { label: 'Stratified drag (Ri)',  default: 1, min: 0, max: 1, step: 0.05 },
  /* Quadratic bottom-drag coefficient: r = Cd*|u_deep|/max(h_deep,10 m), i.e.
     a bottom stress -Cd*|u|*u spread over the deep layer. Strong on shallow
     shelves (hours-days), weak in the abyss (hundreds of days). */
  bottomDragCd:   { label: 'Bottom drag Cd',        default: 2.5e-3, min: 0, max: 1e-2, step: 1e-4, fmt: function (v) { return v.toExponential(1); } },
  /* How many steps between recomputations of the dynamic coastline. The mask
     is only ever refreshed at a step boundary, so every pass within one step
     sees the same land snapshot. */
  maskEvery:      { label: 'Coastline update every', default: 16, min: 1, max: 128, step: 1, fmt: function (v) { return v + ' steps'; } },
  /* Steric (thermal/haline expansion) amplitude, in metres of extra top-layer
     thickness per unit buoyancy anomaly (alphaT*dT - betaS*dS). This is what
     turns the T/S field into a sea-surface-height field and hence drives the
     surface circulation; the deep layer then feels the opposite gradient. */
  steric:         { label: 'Steric height gain',    default: 500, min: 0, max: 5000, step: 50, fmt: function (v) { return v.toExponential(1); } },
  /* Rate (1/s) at which h_top relaxes toward its steric equilibrium. */
  stericRate:     { label: 'Steric relax rate',     default: 1e-6, min: 0, max: 1e-5, step: 1e-7, fmt: function (v) { return v.toExponential(1); } },
  /* Extra mass correction (1/s) on top of the steric relaxation: nudges h_top
     back toward the plain reference thickness H_ref. The steric relaxation
     (stericRate) is what actually stabilises the interface; this term only
     removes any residual bias, so it needs a timescale of months-to-years
     (~1e-8 = 3 yr) to do anything at all on simulated timescales. */
  massSpring:     { label: 'Mass spring (global)',  default: 1e-8, min: 0, max: 1e-7, step: 1e-9, fmt: function (v) { return v.toExponential(1); } },
  /* Extra uniform surface mass forcing on h_top (m/s), on top of E-P. Useful
     to probe the mass budget; positive thins the top layer. */
  surfMass:       { label: 'Surface mass forcing',  default: 0, min: -1e-6, max: 1e-6, step: 5e-8, fmt: function (v) { return v.toExponential(1); } },
  /* Vertical heat exchange coefficient (W/m^2/K): Q = k*(T_deep - T_top),
     applied symmetrically in heat-content form (top gains, deep loses). */
  verticalHeat:   { label: 'Vertical heat k',       default: 0.9, min: 0, max: 10, step: 0.05, fmt: function (v) { return v.toFixed(2) + ' W/m²K'; } },
  /* Vertical salt exchange coefficient (kg/m^2/s per ppt), symmetric. */
  verticalSalt:   { label: 'Vertical salt k',       default: 5e-7, min: 0, max: 5e-5, step: 5e-7, fmt: function (v) { return v.toExponential(1); } },
  nuVelOcean:{ label: 'Ocean viscosity',      default: 6e3,   min: 0,   max: 4e4,  step: 1e3,  fmt: function (v) { return v.toExponential(1); } },
  cloudK:    { label: 'Cloud sensitivity',    default: 1.7,   min: 0,   max: 4,    step: 0.05 },
  noise:     { label: 'Symmetry-break noise', default: 0.02,  min: 0,   max: 0.2,  step: 0.005 },
  // non-tunable (default only; UI handled by checkboxes / mode / equirect buttons)
  running:        { default: true },
  /* Ocean geometry. The sea-floor depth is now PER CELL (a real heightmap
     exported by geodesics.js as uBathy.x) and h_deep = depth - h_top is
     derived, so the total ocean volume never changes. hTop is no longer a
     global thickness: it scales the per-cell reference profile in
     Grid.build(), so changing it requires a rebuild (see Planet.build). */
  hTop:           { default: 60 },
  /* Deep-layer LINEAR background friction; the dominant term is now the
     quadratic, depth-scaled bottom drag (bottomDragCd), so this is only a tiny
     residual damping instead of the old 19-day-everywhere constant. */
  fricOceanDeep:  { default: 1e-8 },
  nuTOcean:       { default: 4e3 },
  fricAirHigh:    { default: 2.5e-6 },
  fricOceanTop:   { default: 1.5e-6 },
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
    omegaSpin: { v: 7.292e-5 }, omegaOrbit: { v: 6.2831853 / 86400 },
    evap: { v: 0.005 }, cloudK: { v: 1.7 }, noise: { v: 0.02 },
  },
  'Slow rotation': {
    omegaSpin: { v: 1.8e-5, min: 0, max: 3.6e-4, step: 1e-6 },
    omegaOrbit: { v: 1.8e-5, min: 0, max: 3e-4, step: 1e-6 },
    lapse: { v: 55 }, conv: { v: 9e-6 },
  },
  'Tidally locked': {
    omegaSpin: { v: 7.292e-5 }, omegaOrbit: { v: 0 },
    lapse: { v: 55 },
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
    return migrateKeys(m);
  }
  return migrateKeys(src);
}

/* Backwards compatibility: the old single `omega` drove BOTH the Coriolis term
   and the sub-solar point, so an old preset/save maps onto both new keys. */
function migrateKeys(m) {
  if (!m || m.omega === undefined) return m;
  var out = {}, k;
  for (k in m) if (k !== 'omega') out[k] = m[k];
  if (out.omegaSpin === undefined) out.omegaSpin = m.omega;
  if (out.omegaOrbit === undefined) out.omegaOrbit = m.omega;
  return out;
}
