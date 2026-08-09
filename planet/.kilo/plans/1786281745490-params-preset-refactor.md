# Move PARAMS / presets into params.js

## Context
The param model + preset logic was implemented in the previous turn and works
(single `PARAMS` schema, flat per-instance `v`, per-instance `bounds`, partial-merge
presets). Currently `PARAMS`, `defaultParams`, `boundsOf`, `setBound`, `clamp` live in
`engine.js`, and `BUILTIN_PRESETS`, `normalizePreset`, `applyPreset`, `syncSliders` live in
`app.js`. The data and pure model helpers are shared and DOM-independent, so they belong in a
dedicated `params.js` loaded first; `app.js` keeps the UI/controller layer.

Decision (confirmed): move **data + pure helpers only** into `params.js`:
`PARAMS`, `BUILTIN_PRESETS`, `defaultParams`, `boundsOf`, `setBound`, `clamp`, `normalizePreset`.
`applyPreset` and `syncSliders` stay in `app.js` (they touch `ui.planet`, `syncSliders`,
`refreshDynamic`).

## Dependency facts (verified)
- `engine.js` only uses `PARAMS`, `defaultParams()`, and sets `this.bounds`. It does NOT call
  `boundsOf`/`setBound`/`clamp` directly → safe to remove them from engine.js.
- `app.js` uses all the moved symbols as globals; `applyPreset` calls `normalizePreset`,
  `setBound`, `boundsOf`, `clamp` (now from params.js) + the UI funcs kept in app.js.

## Steps
1. **Create `params.js`** (new file, no DOM dependencies) containing, in order:
   - `var PARAMS = { ... }` — full schema (copy verbatim from engine.js:41-78).
   - `var BUILTIN_PRESETS = { ... }` — copy from app.js:9-27.
   - `function defaultParams()` — derives flat defaults from `PARAMS`.
   - `function boundsOf(p, key)` — `p && p.bounds && p.bounds[key]` merged over `PARAMS`.
   - `function setBound(p, key, part)` — merges `{min?,max?,step?}` into `p.bounds[key]`.
   - `function clamp(v, lo, hi)`.
   - `function normalizePreset(src)` — keyed-object OR array-of-entries → keyed map.
2. **Edit `engine.js`**: delete the `PARAMS` definition, `defaultParams`, `boundsOf`,
   `setBound`, `clamp` (lines ~40-105). Keep `this.params = defaultParams();` and
   `this.bounds = {};` in the constructor (they now reference globals from params.js).
3. **Edit `app.js`**: delete `var BUILTIN_PRESETS = [...]` and `function normalizePreset(...)`
   (now in params.js). `applyPreset`/`syncSliders` stay unchanged (they call the moved globals).
4. **Edit `index.html`**: add `<script src="params.js"></script>` **before** engine.js, i.e.
   between the geodesics/shader scripts and engine.js:
   ```
   <script src="geodesics.js"></script>
   <script src="shader.js"></script>
   <script src="params.js"></script>   <!-- PARAMS + pure preset/model helpers -->
   <script src="engine.js"></script>
   <script src="app.js"></script>
   ```

## Files touched
- `params.js` (new)
- `engine.js` (remove data + pure helpers; keep constructor usage)
- `app.js` (remove `BUILTIN_PRESETS` + `normalizePreset`)
- `index.html` (script order)

## Validation
- `node --check params.js && node --check engine.js && node --check app.js`.
- Load harness (stub DOM): build fake planet `{params: defaultParams(), bounds:{}}`, then:
  - partial merge `{evap:{v:0.05}}` → only `evap` changes; other params identical.
  - bounds override `{evap:{v:0.05,min:0,max:0.1,step:0.0005}}` → `bounds.evap` set, `v` set.
  - array form `[{key:'noise',v:0.1}]` → applied.
  - out-of-range `v` clamped into effective bounds.
  - unknown key ignored (no crash).
- Open `index.html` (WebGL2) and confirm: sliders render from `PARAMS`, dropdown applies
  built-in presets, Load JSON merges, Export downloads, Reset clears bounds.

## Risks
- Script load order: params.js MUST precede engine.js and app.js or globals are undefined at
  call time (calls happen post-boot, but definitions must exist when scripts parse references).
- Don't accidentally move `applyPreset`/`syncSliders` (UI-coupled) — keep them in app.js.
