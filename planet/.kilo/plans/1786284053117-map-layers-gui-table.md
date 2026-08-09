# Map Layers GUI Refactor — Layer × View Table

## Goal
Replace the flat 10-button "Layer view" grid with a clean table:
- **Rows = physical layers**, ordered by height, row 0 = High air (top) → Deep ocean (bottom).
- **Columns = view maps**: `T`, `P`, `Humidity`, `Speed`, `Salinity`, `Rain`.
- **One global radio group** across the whole table (shared `name`) → exactly one cell is
  selectable at a time. Selecting a cell sets the single render mode (`params.mode` → shader
  `uMode`). The engine renders only one `uMode` (one layer+field) at a time, so "only one
  physical layer renders" is satisfied by one-cell selection. (Not a per-row radio group.)

This is a pure UI/data restructure: the engine and shaders already encode each (layer, field)
combo as a distinct `uMode` integer, so no shader/engine changes are needed.

## Current state (what to change)
- `app.js:2-5` — `MODES` flat array (10 labels) drives the grid.
- `app.js:179-194` — "Layer view" block: a `lab`, a `grid2` of 10 `mbtn`s, plus a static `bar`/`barlab` colorbar.
- `app.js:99-101` — `refreshDynamic` highlights buttons via `ui.modeBtns`.
- `app.js:50` — `ui.modeBtns: []` element refs.
- Shaders (`shader.js:76-85` EQUI_FS, `shader.js:556-564` GLOBE_FS) already map `uMode` 0-9:
  - 0 Low-air T (`la.z`), 1 Surface T (`wt.x`), 2 Low-air P (`la.w`), 3 Humidity (`lb.x`),
    4 Wind speed (`la.xy`), 5 Ocean current (`wt.yz`), 6 Rain (`hb.y`), 7 Salinity (`wt.w`),
    8 Deep-ocean T (`wd.x`), 9 High-air T (`ha.z`).
  - Modes 3,4,5,6 use magnitude (dark-bg) coloring — no change needed; new cells inherit this.

## New data model (`app.js`)
Add near top of `app.js` (replace `MODES`):

```js
// rows top->bottom = high->low (row0 = High air). view->uMode; null = no data.
// view.label = short header; view.title = full name (tooltip).
var LAYER_VIEW = {
  layers: [
    { id:'highAir',   label:'High air' },
    { id:'lowAir',    label:'Low air' },
    { id:'surface',   label:'Surface' },
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
  map: {
    highAir:   { T:9 },
    lowAir:    { T:0, P:2, humidity:3, speed:4 },
    surface:   { T:1, rain:6 },
    ocean:     { speed:5, salinity:7 },
    deepOcean: { T:8 },
  },
};
```
This covers all 10 existing `uMode` values (0-9); nothing is lost.
Note: High air exposes only Temperature (`ha.z`); P/Humidity/Speed are low-air fields only.

## Implementation steps
1. **`app.js` — replace `MODES`** with the `LAYER_VIEW` structure above.
2. **`app.js` UI state** — replace `modeBtns: []` (line 50) with `layerRadios: {}` (keyed by `uMode`).
3. **`app.js` buildUI** — replace the block at lines 179-194:
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
 4. **`app.js` refreshDynamic** — replace `ui.modeBtns.forEach(...)` (lines 99-101) with:
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
 5. **`index.html` CSS** — add `.ltable` styles. Layout is the main risk: 6 view columns + 1
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
- Confirm: table shows 5 layer rows × 6 view columns; High air is the top row.
- Clicking any cell updates the globe/equirect coloring; exactly one cell stays selected
  (radio exclusivity). Disabled cells (e.g. High air / P) are blank and unclickable.
- Toggle equirect (🗺) — coloring still follows the selected cell (shares `uMode`).
- Verify no console errors; `refreshDynamic` reflects preset/JSON loads (mode still a valid index).

## Risks / notes
- No engine/shader edits required; `uMode` semantics unchanged.
- If a future field is added, just extend `LAYER_VIEW.map` + `views`/`layers`.
- `MODES` is referenced only in `buildUI`; safe to delete once replaced.
