# Map Layers GUI Refactor — Layer × View Table

## Goal
Replace the flat 10-button "Layer view" grid with a clean table:
- **Rows = physical layers**, ordered by height, row 0 = High air (top) → Deep ocean (bottom).
- **Columns = view maps**: `T`, `P`, `Humidity`, `Speed`, `Salinity`, `Rain`.
- **One global radio group** across the whole table (shared `name`) → exactly one cell is
  selectable at a time. Selecting a cell sets the single render mode (`params.mode` → shader
  `uMode`). The engine renders only one `uMode` (one layer+field) at a time, so "only one
  physical layer renders" is satisfied by one-cell selection. (Not a per-row radio group.)

This is mostly a UI/data restructure, but it **requires a small shader addition**: the
simulation already computes high-air and deep-ocean fields, but they have no `uMode` branches.
We add `uMode` 10-14 in the two render fragment shaders (see Shader additions below).

## Current state (what to change)
- `app.js:2-5` — `MODES` flat array (10 labels) drives the grid.
- `app.js:179-194` — "Layer view" block: a `lab`, a `grid2` of 10 `mbtn`s, plus a static `bar`/`barlab` colorbar.
- `app.js:99-101` — `refreshDynamic` highlights buttons via `ui.modeBtns`.
- `app.js:50` — `ui.modeBtns: []` element refs.
- Render shaders (`shader.js:76-85` EQUI_FS, `shader.js:556-564` GLOBE_FS) currently map `uMode` 0-9:
  - 0 Low-air T (`la.z`), 1 Surface/ocean T (`wt.x` = `Ts`), 2 Low-air P (`la.w`),
    3 Humidity (`lb.x`), 4 Wind speed (`la.xy`), 5 Ocean current (`wt.yz` = `vt`),
    6 Rain (`hb.y`), 7 Salinity (`wt.w` = `St`), 8 Deep-ocean T (`wd.x` = `Td`),
    9 High-air T (`ha.z`).
  - Modes 3,4,5,6 use magnitude (dark-bg) coloring.
- **Under-exposed fields (data exists, no `uMode`):** the high atmosphere (`oHiA=vec4(vh,Th,Ph)`,
  `oHiB=vec4(qh,rain,…)` → `ha.xy/vh` velocity, `ha.w/Ph` pressure, `hb.x/qh` humidity) and the
  deep ocean (`oDeep=vec4(Td,vd,Sd)` → `wd.yz/vd` current, `wd.w/Sd` salinity) carry fields that
  are simulated but not selectable. We add `uMode` 10-14 to expose them.
- **Fields that genuinely don't exist** (leave cell empty, physically correct): ocean has no
  P / Humidity / Rain; air has no Salinity. "Surface temp" (mode 1) is the ocean-surface (skin)
  temperature — same shell as ocean current/salinity, so it folds into the **Ocean** row.

## New data model (`app.js`)
Add near top of `app.js` (replace `MODES`):

```js
// rows top->bottom = high->low (row0 = High air). view->uMode; absent key = no data.
// view.label = short header; view.title = full name (tooltip).
var LAYER_VIEW = {
  layers: [
    { id:'highAir',   label:'High air' },
    { id:'lowAir',    label:'Low air' },
    { id:'ocean',     label:'Ocean' },
    { id:'deepOcean', label:'Deep ocean' },
  ],
  views: [
    { id:'T',        label:'T',   title:'Temperature' },
    { id:'P',        label:'P',   title:'Pressure' },
    { id:'humidity', label:'Hum', title:'Humidity' },
    { id:'speed',    label:'Spd', title:'Speed' },
    { id:'salinity', label:'Sal', title:'Salinity' },
    { id:'rain',     label:'Rain',title:'Rain' },
  ],
  // uMode 0-9 pre-exist; 10-14 are NEW branches to add in the shaders (see Shader additions).
  map: {
    highAir:   { T:9, P:10, humidity:11, speed:12, rain:6 }, // ha/hb full shell
    lowAir:    { T:0, P:2, humidity:3, speed:4 },            // la/lb shell
    ocean:     { T:1, speed:5, salinity:7 },                  // wt = surface ocean (Ts,vt,St)
    deepOcean: { T:8, speed:13, salinity:14 },                // wd = deep ocean   (Td,vd,Sd)
  },
};
```
Covers `uMode` 0-14. Empty cells are physically correct: ocean has no P/Humidity/Rain
(atmospheric only); air has no Salinity. "Surface temp" (old mode 1) is ocean-surface T,
folded into the Ocean row.

## Shader additions (do first — required)
The high-air and deep-ocean fields are simulated but have no `uMode` branch. Add to **both**
`EQUI_FS` (shader.js:76-85) and `GLOBE_FS` (shader.js:556-564), extending the `uMode` chain:

```glsl
  else if(uMode==10) v = (ha.w-45000.0)/16000.0*0.5+0.5;  // High-air pressure   (ha.w)
  else if(uMode==11) v = hb.x/0.022;                      // High-air humidity   (hb.x)
  else if(uMode==12) v = length(ha.xy)/34.0;              // High-air speed      (ha.xy)
  else if(uMode==13) v = length(wd.yz)/1.1;               // Deep-ocean speed    (wd.yz)
  else if(uMode==14) v = (wd.w-33.0)/4.0;                 // Deep-ocean salinity (wd.w)
```

Widen the magnitude-style (dark-bg) branch in **both** shaders (currently
`uMode==3||uMode==4||uMode==5||uMode==6`) to include the new magnitude fields:
```glsl
  if(uMode==3||uMode==4||uMode==5||uMode==6||uMode==11||uMode==12||uMode==13){
    base = mix(vec3(0.02,0.03,0.07), base, pow(vVal,0.7));
  }
```
- Add **11,12,13** (high humidity ∥ 3, high speed ∥ 4, deep speed ∥ 5).
- Do **not** add 10 (high P) or 14 (deep salinity): they use palette coloring, like their
  low-air/surface counterparts (modes 2 and 7).
- Scales reuse the analogous low/surface-mode divisors. Deep-ocean speed (13) may need a
  smaller divisor (deep currents are far slower than surface) — tune if it renders near-black.

## Implementation steps
1. **Shaders** — apply the Shader additions above (both render FS).
2. **`app.js` — replace `MODES`** with the `LAYER_VIEW` structure above.
3. **`app.js` UI state** — replace `modeBtns: []` (line 50) with `layerRadios: {}` (keyed by `uMode`).
4. **`app.js` buildUI** — replace the block at lines 179-194:
   - Keep `el('div','lab','Layer view')`.
   - Build `<table class="ltable">`:
     - `<thead>`: corner cell + one `<th>` per view (labels from `LAYER_VIEW.views`).
     - `<tbody>`: one `<tr>` per layer; first `<th>` = layer label; then one `<td>` per view.
       - If `LAYER_VIEW.map[layer.id][view.id]` exists → render
         `<input type="radio" name="lview" value="<uMode>">` with a `title`/`aria-label`.
         `onchange` → `setParam('mode', +this.value)`.
       - Else → empty disabled `<td class="na">`.
    - Keep the `.bar`/`.barlab` colorbar (optional: make its low/high labels dynamic per selected
      view later; out of scope for v1).
     - Store each radio in `ui.layerRadios[mode]`.
  5. **`app.js` refreshDynamic** — replace `ui.modeBtns.forEach(...)` (lines 99-101) with:
    ```js
    Object.keys(ui.layerRadios).forEach(function (m) {
      var inp = ui.layerRadios[m];
      var on = (P.mode === +m);
      inp.checked = on;
      inp.parentNode.classList.toggle('sel', on); // reconcile highlight for preset/JSON loads
    });
    ```
    The radio `change` handler (in buildUI) must also toggle `sel` off the previously selected
    `<td>` and on the new one.
    6. **`index.html` CSS** — add `.ltable` styles. Layout is the main risk: 6 view columns + 1
    label column in a 300px panel. Mitigations:
    - Short column headers (`T`, `P`, `Hum`, `Spd`, `Sal`, `Rain`) with `title` full names (from
      `LAYER_VIEW.views[].title`); layer labels kept short ("High air", "Low air", …).
    - Wrap the table in `<div class="ltable-wrap">` with `overflow-x:auto` as a safety net if it
      still overflows at `font-size:10px`.
    - `.ltable { border-collapse:collapse; width:100%; font-size:10px }`.
    - `th,td { padding:3px 2px; text-align:center }`; first column (layer name) `text-align:left;
      white-space:nowrap; padding-right:6px`.
    - Radios are native (compact); hide default chrome only if needed. Selected cell highlight
      (cyan, matching `.mbtn.on`): add class `sel` to the parent `<td>` when checked, or use
      `.ltable input:checked` styling. Recommended: on `change` toggle `td.classList` so the
      highlight is visible around the radio:
      `td.sel { background:rgba(34,211,238,.25); box-shadow:inset 0 0 0 1px rgba(34,211,238,.4) }`.
    - `.ltable td.na { visibility:hidden }` for empty cells (keep cell space for column alignment).

## Default selection
`params.mode` default is `0` (Low air / T) — the radio for that cell should show checked on load
(`refreshDynamic` runs in `boot`). No default change required.

## Validation
- Open `index.html` in a browser (or `python3 -m http.server` then load).
- Confirm: table shows 4 layer rows (High air, Low air, Ocean, Deep ocean) × 6 view columns;
  High air is the top row.
- Newly exposed cells work: High air / P, Humidity, Speed; Deep ocean / Speed, Salinity — each
  changes the globe coloring and uses the correct (palette vs dark-bg) style.
- Clicking any cell updates the globe/equirect coloring; exactly one cell stays selected
  (radio exclusivity). Disabled cells (e.g. Ocean / P, High air / Salinity) are blank and
  unclickable.
- Toggle equirect (🗺) — coloring still follows the selected cell (shares `uMode`).
- Verify no console errors; `refreshDynamic` reflects preset/JSON loads (mode still a valid index 0-14).

## Risks / notes
- **Shader edits are required** (not a pure UI change): add `uMode` 10-14 in both `EQUI_FS` and
  `GLOBE_FS`, and widen the magnitude-style branch. Scale divisors are first approximations;
  deep-ocean speed (13) may need tuning to avoid rendering near-black.
- If a future field is added, just extend `LAYER_VIEW.map` + `views`/`layers` and (if new) add a
  `uMode` branch in the two render shaders.
- `MODES` is referenced only in `buildUI`; safe to delete once replaced.
