# Refactoring & Implementation Plan — Per-Cell Ocean Geometry

**Target:** `planet_webgl` (geodesics.js · shader.js · params.js · engine.js · app.js · index.html)
**Scope:** four requested features + supporting refactors and opportunistic wins.

| # | Feature | Phase | Risk |
|---|---------|-------|------|
| 1 | **Per-cell depth** (core) | 2 | High — touches every ocean invariant |
| 2 | **Per-cell reference `h_top`** | 3 | Medium — blocked by Phase 1 |
| 3 | **Depth-dependent water friction** | 4 | Low |
| 4 | **Stratification-dependent drag** | 5 | Low — mostly a sign fix |

---

## 0. Executive summary — read this first

The four features are not independent. Features 1 and 2 both introduce a **permanent, static spatial gradient into `h_top`**, and the current pressure-gradient term cannot survive that. Everything else in this plan is downstream of one three-line fix.

### 0.1 The blocker

`shader.js:316-317` is the momentum core:

```glsl
vec2 accT = -9.81*gradH + uNuVel*lapVt - advVt + vt0*divT;   // top:  full g
vec2 accD = +gp  *gradH + uNuVel*lapVd - advVd + vd0*divD;   // deep: reduced g (~0.02)
```

`gradH` is built at `shader.js:273` from the **raw** thickness difference:

```glsl
gradH += L*0.5*(tsj.x - h0)*nrm*wet;
```

Today `h_top` is a near-uniform 60 m field with small anomalies, so `grad(h_top)` is *entirely* dynamic signal and the 490× overstrength coefficient acts as a tuning knob that produces plausible O(0.1 m/s) currents.

The moment `h_ref` or the depth `D` varies per cell, `grad(h_top)` acquires a **permanent** component that is just the interface draping over bathymetry — not a pressure gradient at all. This is the classic sigma-coordinate pressure-gradient error, and at full `g` it is catastrophic:

```
tilt  20 m over 2000 km  ->  u_geo =  0.98 m/s
tilt  50 m over 3000 km  ->  u_geo =  1.63 m/s
tilt 200 m over 2000 km  ->  u_geo =  9.81 m/s     (velocity clamp is 3.0 m/s)
```

A continental shelf is a ~200 m step over a few hundred km. **Phase 2 lands a permanent, planet-wide 3 m/s topographic jet pinned to the coastline** unless Phase 1 goes in first. The clamp at `shader.js:335` hides the blow-up as a *steady wrong answer*, which is the worst failure mode: no NaN, no visible crash, just a silently non-physical ocean.

### 0.2 The fix (Phase 1)

Split thickness into **static reference + dynamic anomaly**, and let only the anomaly drive pressure:

```
eta = h_top - h_ref(cell)        // interface displacement, the baroclinic variable
accT = -uPgfTop * grad(eta)
accD = +uPgfDeep * grad(eta)
```

With `h_ref ≡ 60 m` (Phase 1's default) `eta ≡ h_top - 60`, so `grad(eta) ≡ grad(h_top)` **exactly** — Phase 1 is a provable no-op on current behaviour while making Phases 2–3 safe. That is the whole reason it goes first.

> **Deliberate non-goal.** The textbook 1.5-layer result is `accT = -g'·∇h` with `g' ≈ 0.02`, not `-g·∇h`. Switching to it would weaken surface currents ~490× and destroy every tuned preset. The `-9.81` is a *barotropic-pressure-gradient proxy* standing in for the rigid lid's missing free surface. This plan **keeps it** (as the tunable `uPgfTop`, default `9.81`) and only removes the spurious static part. Rebalancing toward true `g'` is filed as optional Phase 7.3.

### 0.3 Phase order (each phase ships green)

```
Phase 0  Refactor scaffolding — zero behaviour change, pure prep   [DONE f4d043f..]
Phase 1  PGF anomaly split + per-cell h_ref plumbing               [DONE] <-- UNBLOCKED EVERYTHING
Phase 2  Per-cell depth D, bathyMode=0 (D == hTotal)               [DONE] bit-identical gate
Phase 2b Real procedural bathymetry, bathyMode=1                   [DONE]
Phase 3  Per-cell reference h_top (shelf-aware)                    [DONE]
Phase 4  Depth-dependent water friction                            [DONE 7eaba55]
Phase 5  Stratification-dependent drag (+ sign-bug fix)            [DONE ac5f12a]
Phase 6  Diagnostics, render modes, UI                             [DONE 37cc8e7, b4fcd0b]
Phase 7  Optional / stretch                                        [NOT STARTED]
```

**All four requested features are implemented, verified and committed.**

| # | Feature | Where it lives |
|---|---------|----------------|
| 1 | Per-cell depth (*core*) | `cellC.x` = D, built in `geodesics.js`, consumed everywhere via `cellD()` |
| 2 | Stratification-dependent drag | `bulkRi()`/`stratMix()` in `SHADER_COMMON`; `dragStrat` in `OCEAN_FS` |
| 3 | Depth-dependent water friction | `rBot{T,D} = Cd·|v|/h` + `depthTaper` in `OCEAN_FS` |
| 4 | Per-cell reference `h_top` | `cellC.y` = hRef, drives the `eta` PGF split |

Verification summary:
- Every phase that *should* be a no-op was proven **bitwise identical** (Phases 0, 2, and the neutralised reductions of 4 and 5); Phase 6 is bitwise identical to Phase 5 at L5/500 (`a29ed37c`) and L6/200 (`fa362f78`).
- The blocker fix is empirically confirmed: spurious coastal jet **4.24 m/s + 464 clamp hits → 0.135 m/s + 0 clamp hits**.
- 8000-step run (~166 sim-days): 0 NaN, 0 clamp hits, **volume drift exactly 0.000e+00 %**, salt +9.0e-4 %, heat +4.2e-4 %.
- All 36 render paths (18 modes × globe/equirect) compile, draw and produce non-empty output.

---

## 1. Codebase findings

Read in full. Beyond the requested work, these matter:

### 1.1 Bugs found

**(a) Stratification mixing has the wrong sign.** `shader.js:615-617`:

```glsl
float rt = -0.00017*(Ts-283.0) + 0.00078*(St-35.0);   // density anomaly, top
float rd = -0.00017*(Td-283.0) + 0.00078*(Sd-35.0);   // density anomaly, deep
float stab = 1.0 + 900.0*abs(rt-rd);                  // <-- abs()
```

`abs()` makes **strong stable stratification increase mixing**. Physically a dense deep layer under a light top layer should *suppress* exchange; only an unstable column (`rt > rd`) should convect. Currently a sharply stratified tropical column mixes just as hard as an overturning polar one. Multiplies `uVertHeat`, `uVertSalt` **and** `uThermo` (lines 620, 625, 630), so it distorts all three. Fixed in Phase 5 — it is the same physics the requested "stratification-dependent drag" needs, so one shared function serves both.

**(b) Coriolis is explicit and unconditionally unstable at the slider maximum.** `shader.js:326-330` and `421-423` apply rotation with forward Euler. Rotation by forward Euler amplifies energy by `sqrt(1+(f·dt)^2)` per step:

```
omegaSpin = 7.292e-5 (default), dt=1800  ->  f*dt = 0.26  ->  +3.4 %/step
omegaSpin = 3.6e-4   (slider max), dt=1800 -> f*dt = 1.30  -> +63.7 %/step
```

The velocity clamps mask it. Fix is a 6-line Crank–Nicolson rotation (Phase 7.1) — cheap, and it makes the "Slow rotation"/fast-spin presets trustworthy.

**(c) Deep-layer continuity is never enforced.** `h_deep = uHtot - h_top` is derived (`shader.js:229`), so the model is rigid-lid. A rigid lid requires the **barotropic transport to be divergence-free**, `div(h_t·u_t + h_d·u_d) = 0`. Nothing enforces this; `u_deep` evolves from its own momentum equation with no projection step. Harmless-ish today with flat depth; with real bathymetry the deep layer will try to flow *through* seamounts. Documented as a known limitation, with optional Phase 7.2 offering a barotropic correction.

### 1.2 Refactor debt directly in the way

- **`40.0` hard-coded 8×** (`shader.js` 309, 323, 324, 359, 362, 515, 554, 680) as the minimum layer thickness. With per-cell depth a 30 m shelf cell makes `clamp(h, 40.0, D-40.0)` an **inverted range** — `clamp` with `lo > hi` is undefined-ish and will pin `h` to garbage. Must become a per-cell function before Phase 2.
- **`uHtot` threaded as a scalar** through 3 JS call sites (`engine.js` 333, 372, 304) and 6 GLSL sites. All become per-cell texture reads.
- **`OCEAN_UNPACK`** (`shader.js:40-48`) is the single view all render paths share — the natural place to expose `D` and `eta` to every mode expression at once.
- **`geodesics.js` already computes a 9-octave fbm elevation field** (lines 101-118) and **throws it away** after thresholding to a land mask (line 120). Bathymetry is nearly free — the hard part is already written.
- Neighbour-loop boilerplate is duplicated between `OCEAN_FS` and `AIR_FS`. Noted, **not** touched (high churn, no functional gain).

### 1.3 Budget checks (verified, not assumed)

- **Texture units.** `GLOBE_VS` is the heaviest: 8 state + 4 grid = 12. Adding `uCellC` → 13. WebGL2 guarantees `MAX_VERTEX_TEXTURE_IMAGE_UNITS >= 16`. **Fits.**
- **`Prog.tex()` tolerates absent uniforms** (`engine.js:82-83` returns early on `null` location, without consuming a unit). So `uCellC` can be declared once in `SHADER_COMMON` and bound once in `gridUniforms()`; programs that don't use it optimise it out at no cost. **No per-program plumbing needed.**
- **Diagnostic readback.** One state texture at level 6 is 256×161 RGBA32F = **644 KB**. At 1 Hz this is free.
- **Grid build cost.** Coastal-distance BFS is O(V) over an existing adjacency (`rings`); at level 7 (163 842 cells) it is milliseconds against an already-heavy build.

---

## 2. Data model changes

### 2.1 New static per-cell texture `uCellC`

`cellA` = (pos.xyz, area) and `cellB` = (east.xyz, land) are both full. Add one RGBA32F:

| Channel | Name | Meaning |
|---|---|---|
| `.x` | `D` | total ocean depth at this cell (m), `>= uDmin` everywhere incl. land |
| `.y` | `hRef` | reference top-layer thickness (m) — Feature 4 |
| `.z` | `bedElev` | signed bed elevation (m); `>0` land, `<0` sea floor — drives relief |
| `.w` | `coastDist` | distance to nearest coast (m) — shelf profile + future runoff |

`engine.js` builds `this.texCellC` alongside A/B and binds it in `gridUniforms()`; `destroyGrid()` disposes it. Because it is static, it is uploaded once per `build()`.

### 2.2 GLSL accessors — one place, used everywhere

Appended to `SHADER_COMMON`:

```glsl
uniform sampler2D uCellC;      // D, hRef, bedElev, coastDist
uniform float uHmin;           // nominal minimum layer thickness (m), was the literal 40.0

vec4  cellC(int i){ return texelFetch(uCellC, cTex(i), 0); }
float cellD(int i){ return cellC(i).x; }
float cellHref(int i){ return cellC(i).y; }

// Per-cell thickness limits. Replaces every hard-coded clamp(h, 40.0, uHtot-40.0).
// On a shallow shelf the nominal floor is scaled down so the range can never invert.
void hLimits(float D, out float hLo, out float hHi){
  hLo = min(uHmin, 0.25*D);
  hHi = max(D - hLo, hLo + 1.0);          // guarantees hHi > hLo unconditionally
}
float clampH(float h, float D){
  float lo, hi; hLimits(D, lo, hi);
  return clamp(h, lo, hi);
}

// How "two-layer" this column is. Shallow shelf seas are vertically well mixed,
// so baroclinic structure ramps to zero and vertical exchange ramps up.
float twoLayerFrac(float D){ return smoothstep(uDshelf, 3.0*uDshelf, D); }
```

`hLimits` is the single most important refactor in this document: it is what makes a 30 m shelf cell and a 5 000 m trench cell obey the same code path safely.

### 2.3 Extended `OCEAN_UNPACK`

```glsl
vec4 _cc = cellC(cell);
float Dep  = _cc.x;              // total depth
float hRef = _cc.y;
float ht   = _tS.x;              // top thickness (unchanged meaning)
float eta  = ht - hRef;          // interface displacement — the baroclinic variable
float hdp  = max(Dep - ht, 1.0); // deep thickness, now per-cell
```

Every render mode, globe and equirect, gains `Dep`/`eta`/`hdp` for free.

### 2.4 New parameters (`params.js`)

```js
// --- ocean geometry -------------------------------------------------------
bathyMode:  { default: 1 },      // 0 = flat (legacy, D == hTotal), 1 = procedural
hMin:       { default: 40 },     // was the literal 40.0 in 8 places
dShelf:     { default: 200 },    // shelf/deep transition depth (m)
depthMax:   { label:'Max ocean depth', default: 4000, min: 500, max: 8000, step: 100,
              fmt: v => (v/1000).toFixed(1)+' km' },
shelfWidth: { label:'Shelf width',     default: 250e3, min: 0, max: 800e3, step: 25e3,
              fmt: v => (v/1000).toFixed(0)+' km' },
bathyRough: { label:'Bathymetry roughness', default: 0.35, min: 0, max: 1, step: 0.05 },

// --- pressure gradient (was the hard-coded -9.81 / +gp) -------------------
pgfTop:     { label:'PGF gain (top)',  default: 9.81, min: 0, max: 20, step: 0.05 },
pgfDeepGain:{ label:'PGF gain (deep)', default: 1.0,  min: 0, max: 4,  step: 0.05 },

// --- friction (Phase 4) ---------------------------------------------------
cdBottom:   { label:'Bottom drag Cd',  default: 2.5e-3, min: 0, max: 1e-2, step: 1e-4,
              fmt: v => v.toExponential(1) },
fricDepthRef:{ default: 1000 },  // reference depth for the linear-friction taper

// --- stratification (Phase 5) --------------------------------------------
riCrit:     { label:'Richardson crit', default: 0.25, min: 0.05, max: 2, step: 0.05 },
mixConv:    { label:'Convective mixing', default: 50, min: 1, max: 500, step: 5 },

seed:       { default: 12345 }, // was Math.random() — needed for reproducible tests
```

`hTotal` is **retained** as the flat-mode depth and the `depthMax` fallback, so old presets and saves keep working untouched. `migrateKeys()` needs no change.

---

## 3. Phase-by-phase

### Phase 0 — Scaffolding (no behaviour change)

**Goal:** make the diff of every later phase small and reviewable.

1. `params.js`: add all keys from §2.4. Set `bathyMode: 0`, `hMin: 40`, `pgfTop: 9.81`, `pgfDeepGain: 1.0` — i.e. exact current behaviour.
2. `geodesics.js`: emit a `cellC` array filled with `D = hTotal`, `hRef = hTop`, `bedElev` from the existing land smoothstep, `coastDist = 0`. Return it from `build()`.
3. `engine.js`: create/bind/destroy `texCellC`; bind in `gridUniforms()`; pass `uHmin`, `uDshelf`.
4. `shader.js`: add §2.2 accessors to `SHADER_COMMON`. Replace all 8 literal `40.0` with `uHmin` / `clampH()` / `hLimits()`. Replace `uHtot` reads with `cellD(cell)`. Replace literal `-9.81` / `+gp` with `-uPgfTop` / `+uPgfDeepGain*gp`.
5. `engine.js`: thread `seed` instead of `Math.random()` in `reset()`.

**Gate:** with `bathyMode=0`, a 500-step run from a fixed seed must produce a **bitwise-identical** state hash to `main`. This is the phase that earns trust for Phase 2.

---

### Phase 1 — PGF anomaly split ★ the unblocker

**One change, in `OCEAN_FS`.** Line 273:

```glsl
// BEFORE — raw thickness difference; a static h_ref/bathymetry tilt is
// indistinguishable from a real pressure gradient.
gradH += L*0.5*(tsj.x - h0)*nrm*wet;

// AFTER — displacement of the interface from its own local reference.
// Static geometry cancels identically; only the dynamic anomaly pushes water.
float eta0 = h0     - cellHref(cell);
float etaj = tsj.x  - cellHref(j);
gradEta += L*0.5*(etaj - eta0)*nrm*wet;
```

and lines 316-317:

```glsl
vec2 accT = -uPgfTop      *gradEta + uNuVel*lapVt - advVt + vt0*divT;
vec2 accD = +uPgfDeepGain*gp*gradEta + uNuVel*lapVd - advVd + vd0*divD;
```

`hEq` (line 305) and the mass spring (line 308) already reference `uHref`; they become `cellHref(cell)` — again a no-op while `hRef` is uniform.

**Why this is provably safe now and load-bearing later.** With uniform `hRef`, `etaj - eta0 == tsj.x - h0` exactly (the constant cancels in the difference), so Phase 1 cannot change a single float. With varying `hRef`, it is the *only* thing standing between the model and a 3 m/s coastal jet.

**Gate:** bitwise-identical to Phase 0. Then a deliberate probe: hand-set `hRef` to a 200 m ramp, confirm currents stay ~unchanged (**with** the fix) vs. saturating the 3 m/s clamp (**without** it). That negative control is the proof the fix works.

---

### Phase 2 — Per-cell depth, flat mode (`bathyMode = 0`)

Infrastructure only; `D == hTotal` everywhere, so still a no-op.

Sites converting scalar `uHtot` → `cellD(cell)`:

| Location | Change |
|---|---|
| `OCEAN_FS:229` | `float hd0 = max(Dep - h0, 1.0);` |
| `OCEAN_FS:309` | `h1 = clampH(h1, Dep);` |
| `OCEAN_FS:311` | `float hd1 = max(Dep - h1, 1.0);` |
| `OCEAN_FS:323-324` | inverse-column-mass weights use per-cell `hLo` floor, not `40.0` |
| `OCEAN_FS:359,362` | entrainment fractions use per-cell floors |
| `COUPLE_FS:515,554-555` | `hT = clampH(...)`, `hD = max(Dep-hT, 1.0)` |
| `INIT_FS:680` | `clampH(uHtop + rn*0.5, Dep)` |

**Conservation audit — does the core invariant survive?** Yes. `h_deep = D(cell) - h_top` is still *derived per cell*, and `D` is static, so `h_top + h_deep = D(cell)` holds exactly and per-cell water volume is still fixed by construction. The invariant is now *local* rather than global-uniform, which is strictly stronger. Every conservation comment in `COUPLE_FS:454-462` remains true verbatim.

The **one** thing that genuinely changes is the deep-layer continuity gap (§1.1c) — previously masked by uniform depth, now able to push flow into a slope. Not fixed here; see Phase 7.2.

**Gate:** bitwise-identical again.

---

### Phase 2b — Procedural bathymetry (`bathyMode = 1`)

Now the field actually varies. In `geodesics.js`, immediately after the existing land threshold (line 129):

```js
// The 9-octave fbm `height` field is already computed for the land mask; reuse it.
// 1) Rank-normalise via the existing `sorted` array -> a proper equal-area hypsometry.
// 2) Multi-source BFS from coastal cells over `rings` -> geodesic distance to coast.
// 3) Shelf profile in coastDist, blended with fbm roughness for ridges/trenches.
```

Three steps:

**(1) Coast distance.** Multi-source BFS seeded from every ocean cell adjacent to a land cell, relaxing over `rings` with the great-circle edge lengths already computed. O(V).

**(2) Shelf profile.** A monotone shelf→slope→abyss curve:

```js
var s = Math.min(1, coastDist[i] / shelfWidth);
var profile = s*s*(3 - 2*s);                    // smoothstep: shelf, slope, plain
var depth = dShelf + (depthMax - dShelf) * profile;
```

**(3) Roughness.** Modulate with the rank-normalised fbm so mid-ocean ridges and trenches appear, scaled by `bathyRough`, then clamp to `[dShelfMin, depthMax]`.

Land cells get `D = hTotal` (nominal, keeps arithmetic finite; velocities are masked by `land` anyway) and `bedElev > 0` from the same fbm — which finally gives the globe **real topographic relief** instead of the current binary `uRelief*land` step (`shader.js:851`).

**Gate — this is where real risk lands.** Acceptance criteria:
- No NaN in any state texture after 5 000 steps at levels 5/6/7.
- Total ocean volume `Σ D·A` constant to machine precision (it is static — a trivially checkable invariant).
- Max `|u_top|` does **not** ride the 3 m/s clamp anywhere along a coastline. *This is the direct test that Phase 1 did its job.*
- Heat/salt content drift per §5 within pre-Phase-2 tolerance.

---

### Phase 3 — Per-cell reference `h_top` (Feature 4)

Only meaningful once `D` varies. In `geodesics.js`:

```js
// The top layer cannot be 60 m thick in 40 m of water, and the interface should
// shoal onto the shelf rather than intersect the sea floor.
hRef[i] = Math.min(params.hTop, 0.5 * D[i]);
```

Consumers (all already switched to `cellHref()` in Phase 1, so this phase is mostly *data*):
- steric equilibrium `hEq = cellHref(cell) + uSteric*buoy(...)` — the shelf now relaxes toward a thin layer, the abyss toward the full 60 m
- mass spring target
- `INIT_FS` initial condition

**Payoff:** a physically-shoaling mixed layer, and — because `Cw = cpW*rhoW*hT` at `COUPLE_FS:525` — **shelf seas automatically get a small heat capacity and therefore a large seasonal temperature swing**, which is exactly right and emerges for free.

**Watch:** `massSpring` pulls toward `hRef`; with strong spatial `hRef` contrast plus `steric`, the shelf could ring. Mitigate by keeping `massSpring` at its already-tiny `1e-8` default and validating the shelf-vs-abyss `h_top` difference is monotone and steady.

---

### Phase 4 — Depth-dependent water friction (Feature 3)

Current friction is a depth-blind Rayleigh drag (`shader.js:332-333`): `uFricTop = 1.5e-6` (7.7 d) and `uFricDeep = 6e-7` (19.3 d) regardless of whether the column is 30 m or 5 000 m. Physically, bottom stress is `Cd·|u|·u` spread over the layer, so the *effective rate* is `Cd·|u|/h`:

```
open-ocean top layer  u=0.10 h=  60   ->  r=4.2e-06 1/s    2.8 d
shelf, thin column    u=0.30 h=  25   ->  r=3.0e-05 1/s    0.4 d
slope / sill          u=0.05 h= 400   ->  r=3.1e-07 1/s   37   d
abyssal plain         u=0.02 h=4000   ->  r=1.3e-08 1/s  926   d
```

Two orders of magnitude of spread that the current model collapses to one number — and note the abyss is currently damped **~50× too hard**, which is very likely why the deep return limb is sluggish.

```glsl
// Quadratic bottom drag, felt by whichever layer touches the floor.
// Deep layer always does; the top layer only where the column is thin enough
// that the two-layer split has collapsed (shelf).
float rBotDeep = uCdBottom*length(vd0)/max(hd1, uHmin);
float rBotTop  = uCdBottom*length(vt0)/max(h1 , uHmin) * (1.0 - twoLayerFrac(Dep));

// Keep the existing linear terms as a weak background, tapered by depth so the
// abyss is no longer damped like a 60 m surface layer.
float fT = uFricTop *(uFricDepthRef/max(Dep, uFricDepthRef)) + rBotTop;
float fD = uFricDeep*(uFricDepthRef/max(Dep, uFricDepthRef)) + rBotDeep;

vec2 vt1 = (vt0 + uDt*accT)/(1.0 + uDt*fT);   // already backward-Euler: unconditionally stable
vec2 vd1 = (vd0 + uDt*accD)/(1.0 + uDt*fD);
```

The existing implicit treatment means even the shelf's 0.4-day timescale cannot go unstable at `dt = 1800 s`. **Low risk, high realism payoff.**

---

### Phase 5 — Stratification-dependent drag (Feature 2) + sign fix

One shared function replaces the broken `stab` and serves the interfacial drag too:

```glsl
// Gradient Richardson number across the interface. Ri >> 1 = strongly stratified
// (suppress exchange); Ri < 0 = statically unstable (convect hard).
float bulkRi(float gp, float h, vec2 du){
  return gp*h/max(dot(du,du), 1e-8);
}

// Pacanowski-Philander style. Replaces `1.0 + 900.0*abs(rt-rd)`, which had the
// sign backwards: it made STABLE columns mix HARDER.
float stratMix(float Ri){
  if(Ri < 0.0) return uMixConv;                       // convective overturning
  float x = 1.0 + 5.0*Ri/max(uRiCrit*4.0, 1e-3);
  return 1.0/(x*x);                                   // shear-driven, suppressed by stability
}
```

Verified response:

```
du=0.02  g'=0.020  h=60  ->  Ri=3000.0   factor=4.4e-09   (locked -- correct)
du=0.15  g'=0.020  h=60  ->  Ri=  53.3   factor=1.4e-05
du=0.40  g'=0.005  h=40  ->  Ri=   1.2   factor=1.9e-02   (shear-mixed)
Ri < 0                    ->  factor=uMixConv (50)        (convecting)
```

Applied in two places:

**(a) Interfacial drag — the requested feature.** `OCEAN_FS:322`:
```glsl
// A sharp pycnocline decouples the layers; a weak/unstable one welds them together.
float mixFac = stratMix(bulkRi(gp, h1, dv));
vec2  tau = uDrag*(0.1 + mixFac)*length(dv)*dv;
```
The `0.1 +` floor keeps the purely mechanical `mechanicalFric` component alive regardless of stratification — matching that parameter's documented intent (`params.js`: "conceptually independent of the density stratification").

**Critically, the equal-and-opposite application at lines 323-324 is untouched**, so momentum conservation survives exactly: whatever `mixFac` does, `-tau/(ρh_t) · ρh_t + tau/(ρh_d) · ρh_d = 0`.

**(b) Vertical exchange — the sign fix.** `COUPLE_FS:615-630`: replace `stab` with `stratMix(bulkRi(...))` for `uVertHeat`, `uVertSalt` and `uThermo`. All three already use content-form symmetric exchange, so conservation is again untouched — only the *rate* changes.

**Expected visible change (and it is a behaviour change, not a no-op):** tropical stratified columns stop over-mixing, polar convection sharpens. Retuning `verticalHeat` / `thermo` defaults is likely. Budget time for it; consider bumping `mixConv` rather than the base coefficients.

---

### Phase 6 — Diagnostics, rendering, UI  *(COMPLETE)*

> **As-built note.** Conservation checking landed in the *offline* harness
> (`harness/harness.js` + `gate.sh`) rather than as an in-page `Planet.probe()`,
> which turned out to be the better call: it runs in CI-style batch, needs no
> readback on the render thread, and produced the 8000-step numbers quoted in
> §0.3. Render work shipped as two new ocean view modes — **16 `D`** (bathymetry)
> and **17 `η`** (interface displacement `h_top − h_ref`, the quantity the fixed
> PGF actually differentiates). Both are flagged in `MODE_GEOM` so they render
> unlit with flat-grey land instead of being cut in half by the day/night
> terminator. UI work: `GRID_PARAMS` in `app.js` triggers a debounced (160 ms)
> grid rebuild for the eight params baked into the static `uCellC` texture, and
> all twelve new depth/mixing params carry `min`/`max`/`step` so the existing
> auto-generated slider panel picks them up (42 sliders, all verified in range
> for every builtin preset). New rig: `harness/render.js` walks all 18 modes in
> both projections; `harness/snap.js` writes a PNG of any single mode.

**6.1 Conservation harness** (highest value of this phase — the codebase makes strong conservation claims in comments with nothing checking them). A `Planet.probe()` doing `readPixels` on the 4 ocean textures at 1 Hz, reducing on CPU:

```
volume  = Σ D·A                        (static — must be exactly constant)
heat    = Σ cpW·rhoW·(h_t·T_t + h_d·T_d)·A
salt    = Σ rhoW·(h_t·S_t + h_d·S_d)·A
```

Report **drift per simulated year** in the stats bar. 644 KB/probe — negligible. This turns every later phase from "looks fine" into a measurement, and would have caught the §1.1a sign bug immediately.

**6.2 New render modes.** `MODE_FIELDS` additions — note `Dep`/`eta`/`hdp` are already in scope via the extended `OCEAN_UNPACK`, so these are literally one line each:

```js
'(Dep/uDepthMaxView)',      // 16 bathymetry
'(eta/40.0)*0.5+0.5',       // 17 interface displacement (signed, diverging)
'hdp/uDepthMaxView',        // 18 deep-layer thickness
```
Plus a `depth`/`eta` column in `LAYER_VIEW.views` and `LAYER_VIEW.map.ocean`.

**6.3 True relief.** `shader.js:851` currently does `vPos = n*(1.0 + uRelief*cb.w)` — displacement by the binary land mask. With `bedElev` in `uCellC` this becomes real hypsometry (mountains *and* ocean trenches) for a one-line change and a large visual payoff.

**6.4 UI.** `PARAMS` gains an optional `group` field ('Ocean geometry', 'Friction', 'Mixing', …); `buildUI()` (`app.js:419`) renders `<details>` sections. The slider list is about to grow by ~10 and the panel is already a flat scroll.

**6.5 Presets.** `'Shallow sea'` (`depthMax: 800, shelfWidth: 600e3`), `'Deep ocean'` (`depthMax: 6000, shelfWidth: 80e3`), `'Aquaplanet'` (flat `bathyMode: 0`) — these double as regression fixtures.

---

### Phase 7 — Optional / stretch

- **7.1 Semi-implicit Coriolis.** Crank–Nicolson rotation, ~6 lines, fixes §1.1b exactly:
  ```glsl
  float a = f*uDt*0.5, den = 1.0/(1.0+a*a);
  v1 = vec2(v.x + a*v.y, v.y - a*v.x)*den;   // energy-neutral for all f*dt
  ```
- **7.2 Barotropic divergence correction.** Addresses §1.1c. A Jacobi/multigrid projection so `div(h_t·u_t + h_d·u_d) = 0`. Real work (iterative solve on an unstructured hex grid); only worth it if the deep flow visibly ignores bathymetry after Phase 2b.
- **7.3 PGF rebalance toward true `g'`.** Split `accT` into an explicit barotropic proxy + a genuine `-g'∇eta` baroclinic term. Physically correct but *will* require retuning every preset — defer until Phase 6.1 diagnostics can quantify what changed.
- **7.4 Grid-cached bathymetry.** Bathymetry generation adds cost to `build()`, which runs on every resolution change (`app.js:rebuild`). Cache by `(level, seed)`.

---

## 4. Risk register

| Risk | Phase | Severity | Mitigation |
|---|---|---|---|
| Topographic PGF error → 3 m/s coastal jet | 2b | **Critical** | Phase 1 first; explicit negative-control test |
| `clamp(h, 40, D-40)` inverts on shelves | 2 | **High** | `hLimits()` in Phase 0; assert `hHi > hLo` |
| Shallow cells → `hd → 0` → div-by-zero in `tau/(ρ·h)` | 2b | **High** | `max(·, uHmin)` everywhere + `twoLayerFrac` ramp |
| Phase 5 changes climate, forces retune | 5 | Medium | Phase 6.1 diagnostics first; `mixConv` as the escape valve |
| Deep flow crosses bathymetry (no barotropic projection) | 2b | Medium | Document; Phase 7.2 if visible |
| Preset/save incompat | 0 | Low | `hTotal` retained; `bathyMode: 0` reproduces legacy exactly |
| Build-time regression at level 7 | 2b | Low | BFS is O(V); cache per Phase 7.4 |

**Rollback:** every phase is gated behind `bathyMode` or a default-neutral parameter. Setting `bathyMode = 0` and `pgfTop = 9.81` restores pre-refactor behaviour at runtime, with no code revert.

---

## 5. Test strategy

**Determinism first.** `Planet.reset()` (`engine.js:304`) uses `Math.random()` for `uSeed`; `Grid` is already deterministic (default seed 12345). Threading the new `seed` param through `reset()` is a Phase 0 prerequisite — without it none of the equivalence gates below are checkable.

| Gate | Phases 0–2 | Phase 2b+ |
|---|---|---|
| State hash after 500 steps, fixed seed | **bitwise identical** | expected to differ |
| NaN sweep, 5 000 steps, levels 5/6/7 | clean | clean |
| `Σ D·A` (static volume) | exact | exact |
| Heat / salt drift per sim-year | baseline | ≤ baseline |
| `max|u_top|` at coastlines | n/a | **must not touch the 3 m/s clamp** |
| Frame time, level 6 | ±5 % | ±10 % |

The bitwise gate through Phase 2 is the backbone: it means any behavioural difference observed at 2b is *unambiguously* the bathymetry, not an accidental regression in 200 lines of touched plumbing.

---

## 6. File-by-file impact

| File | Phase 0 | 1 | 2 | 2b | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|
| `geodesics.js` | emit `cellC` | – | – | **bathymetry + BFS** | `hRef` | – | – | `bedElev` |
| `shader.js` | accessors, de-magic | **PGF split** | `cellD()` sites | – | – | bottom drag | `stratMix()` | modes, relief |
| `params.js` | new keys | pgf keys | – | bathy keys | – | fric keys | mix keys | groups, presets |
| `engine.js` | `texCellC`, seed | uniforms | uniforms | – | – | uniforms | uniforms | `probe()` |
| `app.js` | – | – | – | – | – | – | – | UI groups, modes |

Rough size: Phase 0 ~200 lines (mostly mechanical), Phase 1 ~15 lines (highest leverage in the document), Phase 2b ~120 lines of new grid code, Phases 3–5 ~30 lines each, Phase 6 ~250 lines.

---

## 7. Recommended sequence

**Land Phase 0 + Phase 1 together as one PR.** Phase 1 is fifteen lines, is provably a no-op today, and is the difference between Phase 2b working and Phase 2b producing a silently broken ocean. Everything after it is incremental and independently revertable.

If you want a visible result fastest: **0 → 1 → 2 → 2b** gives real bathymetry with correct dynamics. Phases 3–5 then each add one physically-motivated behaviour on top, in any order — though **5 is worth pulling forward** if the current over-mixing bothers you, since it is largely a sign fix and pays for itself immediately.
