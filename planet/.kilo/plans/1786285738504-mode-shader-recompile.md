# Recompile render shaders per-mode (no runtime `uMode` branch)

## Goal
Eliminate the runtime `if/else if (uMode==…)` chain from the render shaders (currently the
`MODE_VALUE_CHAIN` / `MODE_MAGNITUDE_STYLE` text, evaluated every pixel/vertex). Bake the
selected mode into the GLSL source via string substitution and compile a dedicated program per
mode. Replace the ugly if-else text with a clean per-mode data table + source builders.

Compilation is **lazy, cache-on-select** (not precompiled): the program for a mode is built the
first time that mode is selected and reused afterwards. This keeps startup cheap and scales to a
future matrix of options (only actually-used combos get compiled).

## Current state
- `shader.js:12-33` — `MODE_VALUE_CHAIN` (the `if(uMode==0)…else…` text) and `MODE_MAGNITUDE_STYLE`
  are emitted via `${…}` into `EQUI_FS` (lines 103,108), `GLOBE_VS` (line 572), `GLOBE_FS` (line 598).
- `uniform int uMode;` declared in `EQUI_FS` (shader.js:73), `GLOBE_VS` (shader.js:557),
  `GLOBE_FS` (shader.js:584). `EQUI_VS` is mode-independent and unchanged.
- `engine.js:188-190` compiles `prog.globe` and `prog.equi` once.
- `engine.js:398` (`renderGlobe`) and `engine.js:452` (`renderEquirect`) call `.i('uMode', P.mode)`.
- `mode` values are integers 0–14 (see `app.js` `LAYER_VIEW.map`).

## shader.js changes
1. Delete `MODE_VALUE_CHAIN` and `MODE_MAGNITUDE_STYLE` constants.
2. Add a data table + builders (replaces the if-else text):
   ```js
   // index = uMode; value = GLSL expression for `float v`, referencing the
   // per-cell textures wt/la/lb/ha/hb/wd already in scope. Drives PER-MODE
   // source compilation, so there is no runtime branch on mode.
   var MODE_FIELDS = [
     '(la.z-238.0)/72.0',                       // 0  low-air T
     '(wt.x-260.0)/50.0',                       // 1  ocean-surface T
     '(la.w-101325.0)/2600.0*0.5+0.5',          // 2  low-air P
     'lb.x/0.022',                              // 3  humidity
     'length(la.xy)/34.0',                      // 4  wind speed
     'length(wt.yz)/1.1',                       // 5  ocean current
     'hb.y/1.6',                                // 6  rain
     '(wt.w-33.0)/4.0',                         // 7  salinity
     '(wd.x-272.0)/16.0',                       // 8  deep-ocean T
     '(ha.z-215.0)/45.0',                       // 9  high-air T
     '(ha.w-45000.0)/4000.0*0.5+0.5',           // 10 high-air P
     'hb.x/0.022',                              // 11 high-air humidity
     'length(ha.xy)/34.0',                      // 12 high-air speed
     'length(wd.yz)/0.25',                      // 13 deep-ocean speed
     '(wd.w-33.0)/4.0',                         // 14 deep-ocean salinity
   ];
   var MODE_MAG = { 3:1, 4:1, 5:1, 6:1, 11:1, 12:1, 13:1 }; // magnitude (dark-bg) modes
   function modeValueSrc(m){ return 'float v = ' + (MODE_FIELDS[m] != null ? MODE_FIELDS[m] : MODE_FIELDS[9]) + ';'; }
   function modeMagSrc(m){ return MODE_MAG[m] ? 'base = mix(vec3(0.02,0.03,0.07), base, pow(vVal,0.7));' : ''; }
   ```
3. Convert the three render sources from `const` strings into builder functions taking `m`:
   - `function EQUI_FS(m){ return SHADER_HEAD + SHADER_COMMON + \`…\` … \`; }` — remove
     `uniform int uMode;` (line 73); replace `${MODE_VALUE_CHAIN}` with `${modeValueSrc(m)}` and
     `${MODE_MAGNITUDE_STYLE}` with `${modeMagSrc(m)}`. Keep `pal()` and `uSun`/`uShowLand`/`uNight`.
   - `function GLOBE_VS(m){ … }` — remove `uniform int uMode;` (line 557); replace the chain with
     `${modeValueSrc(m)}` (computes `v` → `vVal` varying).
   - `function GLOBE_FS(m){ … }` — remove `uniform int uMode;` (line 584); replace
     `${MODE_MAGNITUDE_STYLE}` with `${modeMagSrc(m)}` (uses `vVal` varying from `GLOBE_VS(m)`).
   - `EQUI_VS` is unchanged.
   Both FS builders keep their existing `pal()` definition.

## engine.js changes
1. In `compile()` (lines 188-191): drop the single `prog.globe`/`prog.equi` and instead init
   empty caches:
   ```js
   this.prog.globeByMode = {};
   this.prog.equiByMode = {};
   ```
2. Add lazy getters on `Planet.prototype` (next to `compile`/`build`):
   ```js
   Planet.prototype.getGlobeProg = function (m) {
     var c = this.prog.globeByMode;
     if (!c[m]) c[m] = new Prog(this.gl, GLOBE_VS(m), GLOBE_FS(m), 'globe' + m);
     return c[m];
   };
   Planet.prototype.getEquiProg = function (m) {
     var c = this.prog.equiByMode;
     if (!c[m]) c[m] = new Prog(this.gl, EQUI_VS, EQUI_FS(m), 'equi' + m);
     return c[m];
   };
   ```
   (If `m` is out of range the builder falls back to `MODE_FIELDS[9]`; cache key still valid.)
3. `renderGlobe` (line 394): replace `var g = this.prog.globe.use();` with
   `var g = this.getGlobeProg(P.mode).use();` and delete the `.i('uMode', P.mode)` call.
4. `renderEquirect` (line 448): replace `var eq = this.prog.equi.use();` with
   `var eq = this.getEquiProg(P.mode).use();` and delete the `.i('uMode', P.mode)` call.
5. `cloud`/`points` overlay programs (`prog.cloud`, `prog.points`) are mode-independent — unchanged.

## Validation
- `node --check engine.js shader.js`.
- Load `index.html` (or `python3 -m http.server`): select every cell in the layer table; confirm
  globe and equirect coloring is correct and uses palette vs dark-bg per `MODE_MAG`.
- Toggle equirect (🗺) — coloring still follows the selected cell (shares the same mode program).
- Watch the console for shader compile/link errors when first selecting each mode (lazy compile).
- Grep to confirm no `uMode` references remain in `shader.js`/`engine.js`.

## Risks / notes
- Lazy compile-on-select adds a one-time ~few-ms hitch the first time a mode is selected; cached
  afterwards. Acceptable and aligns with the planned future options matrix.
- Program count is bounded by actually-used modes (≤15 globe + ≤15 equi), memory negligible.
- `EQUI_VS` stays shared across all equi modes since it carries no mode logic.
- `app.js` `LAYER_VIEW.map` mode indices are unchanged by this refactor.
