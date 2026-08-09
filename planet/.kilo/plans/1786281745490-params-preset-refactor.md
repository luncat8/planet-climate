# Params + Preset Refactor Plan

## Goal
Replace the two parallel structures `defaultParams()` (flat defaults) and `KNOBS` (static UI
metadata) with a **single static `PARAMS` schema**, keep per-instance current values as **flat `v`**
(`planet.params[key] = number`), and add a **preset system** that merges a (possibly partial) JSON
preset without wiping the other params. Presets may override `v`, `min`, `max`, and `step`.

Decisions (confirmed with user):
- `v` is stored **flat** per-instance (`planet.params[key]`), NOT inside the shared schema.
- Presets **may override value + bounds** (`min`/`max`/`step`), so a small per-instance
  `planet.bounds` override map is added.
- UI: **built-in presets dropdown + JSON file load** (and optional "Export current").

## 1. Single static schema — `PARAMS` (engine.js, near `defaultParams`)
Replace the hand-written `defaultParams()` values and `KNOBS` with one source of truth:

```js
var PARAMS = {
  // tunable (have min/max/step) -> become sliders
  dt:      { label: 'Timestep dt',        default: 300,   min: 120, max: 1800, step: 60,  fmt: v => v + ' s' },
  substeps:{ label: 'Substeps / frame',   default: 2,     min: 1,   max: 8,    step: 1 },
  omega:   { label: 'Rotation Ω',         default: 7.292e-5, min: 0, max: 3.6e-4, step: 1e-6, fmt: v => (v/7.292e-5).toFixed(2)+'× Earth' },
  solar:   { label: 'Solar constant',     default: 1361,  min: 800, max: 2000, step: 10, fmt: v => v + ' W/m²' },
  greenhouse:{label: 'Greenhouse',        default: 0.55,  min: 0,   max: 1,    step: 0.01 },
  nuVelAir:{ label: 'Air viscosity ν',    default: 1.6e5, min: 0,   max: 6e5,  step: 1e4, fmt: v => v.toExponential(1) },
  nuTAir:  { label: 'Air heat diffusion', default: 1.1e5, min: 0,   max: 6e5,  step: 1e4, fmt: v => v.toExponential(1) },
  fricAirLow:{label:'Surface friction',  default: 1.6e-5,min: 0,   max: 8e-5, step: 1e-6, fmt: v => v.toExponential(1) },
  conv:    { label: 'Convection gain',    default: 6e-6,  min: 0,   max: 3e-5, step: 5e-7, fmt: v => v.toExponential(1) },
  kRad:    { label: 'Radiative exchange', default: 2.5,    min: 0,   max: 8,    step: 0.1 },
  lapse:   { label: 'Reference lapse ΔT', default: 45,     min: 20,  max: 70,   step: 1,  fmt: v => v + ' K' },
  evap:    { label: 'Evaporation k',      default: 0.005,  min: 0,   max: 0.02, step: 0.0005, fmt: v => v.toFixed(4) },
  kSurf:   { label: 'Sensible heat k',    default: 22,     min: 0,   max: 60,   step: 1,  fmt: v => v + ' W/m²K' },
  windStress:{label:'Wind stress',        default: 6e-8,  min: 0,   max: 3e-7, step: 5e-9, fmt: v => v.toExponential(1) },
  thermo:  { label: 'Thermohaline mixing',default: 2e-7,  min: 0,   max: 2e-6, step: 2e-8, fmt: v => v.toExponential(1) },
  nuVelOcean:{label:'Ocean viscosity',    default: 6e3,   min: 0,   max: 4e4,  step: 1e3, fmt: v => v.toExponential(1) },
  cloudK:  { label: 'Cloud sensitivity',  default: 1.7,    min: 0,   max: 4,    step: 0.05 },
  noise:   { label: 'Symmetry-break noise',default: 0.02, min: 0,   max: 0.2,  step: 0.005 },
  // non-tunable (default only; UI handled elsewhere)
  running:        { default: true },
  nuTOcean:       { default: 4e3 },
  fricAirHigh:    { default: 2.5e-6 },
  fricOceanTop:   { default: 1.5e-6 },
  fricOceanDeep:  { default: 6e-7 },
  rainK:          { default: 2200 },
  dayNight:       { default: 1 },
  mode:           { default: 0 },
  showClouds:     { default: true },
  showParticles:  { default: true },
  particleOcean:  { default: 0 },
  showLand:       { default: 1 },
  nightShading:   { default: 1 },
  pointSize:      { default: 2.2 },
  relief:         { default: 0.004 },
  equirect:       { default: 0 },
};
```

Keep `defaultParams()` but derive it so there is ONE source of truth:
```js
function defaultParams() {
  var o = {};
  Object.keys(PARAMS).forEach(function (k) { o[k] = PARAMS[k].default; });
  return o;
}
```
This preserves every existing callsite (`planet.params = defaultParams()`,
`defaultParams()[k.key]`, restore loop).

## 2. Per-instance state — flat `v` + `bounds` override map (engine.js)
- `this.params = defaultParams();` — unchanged (flat `v`).
- Add `this.bounds = {};` in the `Planet` constructor (engine.js:138-139 area).
- Add helpers (app.js or engine.js, global):
  - `function boundsOf(p, key)` → `p.bounds[key] || { min: PARAMS[key].min, max: PARAMS[key].max, step: PARAMS[key].step }`.
  - `function setBound(p, key, part)` → merge `part` (`{min?,max?,step?}`) into `p.bounds[key]`.

## 3. Preset core (app.js)
- `function normalizePreset(src)` → returns a **keyed map** `{ key: {v?,min?,max?,step?} }`.
  Accepts either:
  - object keyed by param key: `{ evap: { v: 0.05, min: 0, max: 0.1, step: 0.0005 } }`
  - array of entries each with `key`: `[{ key: 'evap', v: 0.05, min: 0, max: 0.1, step: 0.0005 }]`
- `function applyPreset(src)`:
  1. `map = normalizePreset(src)`.
  2. For each `key` in map: if `key` not in `PARAMS`, skip.
     - if `v !== undefined`: `ui.planet.params[key] = clamp(v, effectiveMin, effectiveMax)`
       (clamp into the *effective* bounds after any bound override in same entry).
     - if `min`/`max`/`step` present: `setBound(ui.planet, key, {min,max,step})`.
  3. `syncSliders()` then `refreshDynamic()`.
  - **Partial merge**: only keys present in the preset are touched; all other params and their
    bounds remain intact. (Satisfies "keep other intact".)
- `function syncSliders()` (app.js): for every tunable key, set `inp.min/max/step` from
  `boundsOf(ui.planet, key)` and `inp.value` from `ui.planet.params[key]`, using stored refs
  `ui.knobInputs[key]` (see §4).

## 4. UI changes (app.js `buildUI`)
- Remove `var KNOBS = [...]`. Iterate `PARAMS` filtered to entries with `step` when building sliders.
  - Slider creation uses `boundsOf(ui.planet, key)` for `min/max/step` and
    `ui.planet.params[key]` for `value`. Store `ui.knobInputs[key] = inp`.
  - `inp.oninput` → `setParam(key, parseFloat(inp.value))` (unchanged logic).
- Add a **Presets** section in the panel:
  - `<select>` dropdown from `BUILTIN_PRESETS` (define 2–3 examples keyed by name, e.g.
    `Default`, `Earth-like`, `Slow rotation`; each a keyed preset map). `onchange` → `applyPreset(BUILTIN_PRESETS[sel.value])`.
  - `Load JSON` `<input type="file" accept=".json,application/json">` →
    `FileReader.readAsText` → `JSON.parse` → `applyPreset(parsed)`. (Optional: a paste `<textarea>` + Apply button for convenience.)
  - `Export current` button → build keyed preset of current `v` (and `min/max/step` for any key
    present in `planet.bounds`) and trigger a download / copy to clipboard (round-trip support).
- `refreshDynamic` (app.js:93-97): replace `KNOBS.find(x => x.key === key)` with direct
  `PARAMS[key]`; use `PARAMS[key].fmt` for formatting.
- `restore` defaults handler (app.js:247-256): set `ui.planet.params[key] = PARAMS[key].default`
  for all keys, `ui.planet.bounds = {}`, then `syncSliders()` + `refreshDynamic()`.
- `rebuild(l)` (app.js:60): also preserve `ui.planet.bounds` across rebuild (copy/restore) for
  consistency. (`build()`→`reset()` does not touch `params`/`bounds`, engine.js:271,301, so this is
  belt-and-suspenders.)

## 5. Files touched
- `engine.js`: add `PARAMS`; rewrite `defaultParams()` to derive from `PARAMS`; add `this.bounds = {}`
  in `Planet` constructor; add `boundsOf`/`setBound` helpers (global).
- `app.js`: remove `KNOBS`; slider build loop uses `PARAMS` + `boundsOf`; add `applyPreset`,
  `normalizePreset`, `syncSliders`, `BUILTIN_PRESETS`, `ui.knobInputs`; update `refreshDynamic`,
  `restore`, `rebuild`, preset UI section.

## 6. Validation
- Run `npm run lint` (if configured) / open `index.html` in a browser with WebGL2.
- Partial merge: record `ui.planet.params` before applying a 1-key preset (e.g. `{evap:{v:0.05}}`);
  assert only `evap` changed, all others identical.
- Bounds override: apply `{evap:{v:0.05,min:0,max:0.1,step:0.0005}}`; assert slider `min/max/step`
  for evap updated and value set to 0.05.
- Unknown keys in preset are ignored (no crash).
- Reset returns all `v` to `PARAMS` defaults and clears `bounds` overrides.
- Regression: engine.js still reads `P.dt`, `P.solar`, etc. as raw numbers; simulation runs
  unchanged.

## 7. Open notes / risks
- `clamp` helper must be added (or inline `Math.min/Math.max`).
- `BUILTIN_PRESETS` content is illustrative; define realistic value sets.
- JSON load error handling: wrap `JSON.parse` in try/catch and surface a message.
- Preserve `fmt` functions exactly as in current `KNOBS` to avoid display regressions.
