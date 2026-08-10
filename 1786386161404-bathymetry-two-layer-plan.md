# Bathymetry & Two‑Layer Ocean Refactor

## Context (current state)
The ocean is a 2‑layer reduced‑gravity model on an icosahedral dual‑hex grid
(`geodesics.js`, `engine.js`, `shader.js`, `params.js`). Today:
- `h_deep` is derived as a **global constant** `hTotal (1000 m) − h_top` in
  `OCEAN_FS` (`shader.js:229,311`) and `COUPLE_FS` (`shader.js:516`).
- Land is a **static binary‑ish mask** `cb.w`, produced once in
  `geodesics.js:122-129` from a `height[]` noise field that is then **discarded**.
- Inter‑layer drag is `τ = (oceanDrag+mechanicalFric)·|Δu|·Δu`, applied equal &
  opposite with inverse column‑mass weighting. `mechanicalFric` is **constant**
  (stratification‑independent by design).
- Deep‑layer friction `uFricDeep` is a **constant** linear damping.
- `hTop` reference thickness is a single global value.

Goal: make ocean depth **per‑cell** (a real heightmap), drive a dynamic but
slowly‑updated coastline, and add the physically motivated per‑cell refinements
that the depth field unlocks.

## Chosen design (resolved)
1. **Bathymetry source:** reuse the existing `height[]` noise in `geodesics.js`;
   do not add a second field. Export it.
2. **Coastline:** dynamic, derived from `depth(cell)` vs `h_top`, but the land
   mask is only **recomputed every N steps** (coastline change is slow → cheap
   throttle). Continents (depth ≈ 0) remain permanently land.
3. **Scope (all bundled):** per‑cell depth (core), stratification‑dependent
   inter‑layer drag, depth‑dependent bottom friction, per‑cell reference `h_top`.

## Implementation steps (ordered)
1. **Export bathymetry from the mesh generator.** In `geodesics.js Grid.build()`,
   keep `height[]` and, after the existing land computation, produce a per‑cell
   `oceanDepth` and `refHTop`. Recommended mapping (agent may tune):
   `depth = clamp((thr - height)/(thr - minHeight), 0, 1) * Dmax` with
   `Dmax ≈ 4000 m`; `refHTop` should vary regionally — recommended form combines
   bathymetry and latitude (deeper mixed layer toward high latitudes, as in a
   real thermocline): `refHTop = clamp(globalHtop * smoothstep(0, refDepth, depth)
   * latFactor(|lat|), minHTop, depth - margin)` where `latFactor` ramps from
   ~0.5 at the equator to ~1+ at the poles. Return `bathy` (Float32Array, 4
   channels: `x=depth, y=refHTop, z=seaLevel, w=spare`) alongside the other
   grid outputs. (Texture‑fetch cost: adds 1 `uBathy` fetch per ocean/air cell;
   the dynamic mask adds 1 `uLand` fetch. Negligible vs existing neighbour loop.)
2. **New static texture.** In `engine.js build()`, add `this.texBathy`
   (`mkTex`, RGBA32F) from `g.bathy`. Wire it into `gridUniforms()` as `uBathy`.
3. **New dynamic land mask texture.** Add `this.texMask` (R32F or RGBA32F) and a
   tiny FBO. Add a `maskPass` program (or reuse `init2`‑style fullscreen pass)
   that, per cell, computes
   `flood = smoothstep(margin, margin+trans, depth - h_top)` and outputs
   `land = max(cellB.w, 1 - flood)` (continents always land; shallow cells flood
   when `h_top` exceeds local depth). Store `maskEvery` in params (default ~16).

   **HARD TIMING RULE (per the mid‑step land/water pitfall):** `texMask` is
   **read‑only during a step** and is recomputed **only at a step boundary —
   after the ocean dynamics, air dynamics, AND coupling passes of that step have
   all completed. Never recompute or mutate the land mask inside any single pass,
   and never let two passes in the same step see different masks.** Concretely:
   at the end of `step()`, if `stepCount % maskEvery == 0`, run `maskPass` once
   (it reads the final `h_top` in state `A` and `cellB.w`, writes `texMask`);
   otherwise leave `texMask` untouched. Within a step, `OCEAN_FS`, `AIR_FS`, and
   `COUPLE_FS` all sample the same `uLand` snapshot. This guarantees a cell is
   ocean (or land) consistently across every pass of a step, preventing spurious
   mass / momentum / heat sources or NaNs from a mid‑step regime flip.
4. **Refactor `uHtot` → per‑cell depth** in `OCEAN_FS` and `COUPLE_FS`:
   replace `uHtot` reads with `D = texelFetch(uBathy, cTex(cell),0).x`.
   `hd0 = D - h0; hd1 = D - h1;` (and `hD = D - hT` in coupling). Update all
   `clamp(h, 40, uHtot-40)` to `clamp(h, margin, D - margin)`.
5. **Per‑cell reference `h_top`.** Read `refHTop` from `uBathy.y`; use it in
   place of the global `uHref` in the steric + mass‑spring relaxations and in
   init seeding. `INIT_FS` should seed `h_top = refHTop(cell)` (+ tiny noise)
   instead of the global `uHtop` uniform.
6. **Stratification‑dependent inter‑layer drag (OCEAN_FS).** Reuse the existing
   `rhoTop/rhoDeep` already computed for `gPrime` to form a stability factor,
   e.g. `stab = abs(rhoTop - rhoDeep)`. Apply a tunable reduction so a strong
   pycnocline lowers momentum exchange:
   `dragEff = uDrag * f(stab)` where `f` is a monotonic decreasing function
   (agent picks the exact form, e.g. `1/(1 + kStrat*stab)` or `exp(-kStrat*stab)`).
   Add param `stratDrag` (0 = off, matches today).
7. **Depth‑dependent bottom friction (OCEAN_FS).** Replace constant `uFricDeep`
   with `fricDeepEff = uFricDeep * g(D)` where `g` grows for shallow shelves
   (e.g. `g = clamp(refDepth / max(D, minDepth), 1, cap)`). Add param
   `bottomFricDepth` (reference depth) or fold into existing constant. Keep
   `fricTop` unchanged. Optional stronger variants (agent's choice): (a)
   topographic/slope friction — `g` also increases with local bathymetry slope
   `|∇D|` computed from neighbour depths; (b) quadratic bottom stress
   `τ_b = C_d(|v|)·v` with depth‑dependent `C_d` (more standard in OGCMs but
   changes the implicit‑Euler update form, so prefer the linear scaling unless
   realism clearly demands it).
8. **Switch all shaders that read `land` to `uLand`.** `OCEAN_FS`, `COUPLE_FS`,
   `AIR_FS`, and the globe/equirect render shaders currently use `cb.w`. Replace
   with `texelFetch(uLand, cTex(cell),0).x`. Keep `cb.w` only as the continent
   base inside `maskPass`.
9. **UI.** Sliders for new params auto‑generate from `PARAMS` (step present), as
   the other ocean knobs already do. Optionally add a "Sea‑floor depth" view mode
   reading `uBathy.x`.

## Correctness constraints (must hold)
These are the non‑negotiable invariants the implementing agent must preserve;
they directly address the mid‑step land/water pitfall.

1. **One land snapshot per step.** Enforced by the HARD TIMING RULE from step 3:
   `uLand` is constant across the ocean‑dynamics, air‑dynamics, and coupling
   passes of any single step. Recomputing it between passes would let one cell be
   "ocean" in the dynamics pass (advecting `h_top`, exchanging momentum/heat) and
   "land" in the coupling pass (masked by `1−land`), producing spurious sources
   or NaNs. The mask is only refreshed at the step boundary, throttled by
   `maskEvery`.
2. **Land transition is mass‑safe by construction.** When `land` flips, do **not**
   delete or rewrite `h_top`. Ocean velocity is already multiplied by `(1−land)`
   every pass, so a newly‑land cell stops advecting; its `h_top` simply relaxes
   toward `refHTop` (which is near `minHTop` where `depth≈0`), so no ocean mass
   accumulates on "dry" land and no discontinuity appears when the cell later
   re‑floods. `maskPass` writes **only** `texMask`, never state textures.
3. **Continents stay land.** `land = max(cellB.w, 1−flood)` guarantees a cell with
   `depth≈0` (continent) is always land regardless of `h_top`, so the air side
   keeps a stable albedo/evaporation base and the ocean never tries to flow onto
   a continent.
4. **Depth is fixed per run.** `D(cell)` comes from the static `texBathy`; it is
   never modified by the simulation, so `Σ(h_top + h_deep) = Σ D(cell)` is
   conserved by construction even as the mask evolves.

## Key code touch‑points
- `geodesics.js`: ~lines 111‑129 (height/land), return object (~253).
- `engine.js`: `build()` texture/FBO allocation (~213‑236), `gridUniforms()`
  (~283), `step()` (add throttled `maskPass`, ~354), new `maskPass` program in
  `compile()` (~178).
- `shader.js`: `OCEAN_FS` depth/drag/friction (~196‑370), `COUPLE_FS`
  depth/land (~470‑660), `INIT_FS` seed (~663‑684), `AIR_FS` land (~372‑449),
  globe/equirect `OCEAN_UNPACK`/land usage (~40‑59, ~810‑852).
- `params.js`: add `maskEvery`, `stratDrag`, `bottomFricDepth`, keep `hTop`
  as global default feeding per‑cell `refHTop`.

## Open decisions left to the implementing agent
- Exact `depth`/`refHTop` mapping constants and `Dmax`, `refDepth`, `margin`.
- Exact `f(stab)` form for stratification drag and its default `kStrat`.
- Exact `g(D)` form/depth for bottom friction and its cap.
- Whether `texMask` is R32F or RGBA32F (pick for minimal channels).
- `N` default for mask throttle (suggest 16).

## Validation
- **Mass:** global `Σ(h_top + h_deep) = Σ D(cell)` must stay constant (D fixed);
  track mean `h_top` over time — should hover near mean `refHTop` with only slow
  drift from E−P/surfMass/relaxation. Add a stats readout if helpful.
- **Momentum:** drag remains equal & opposite (now weighted by per‑cell
  `ρ·h_deep`); verify total ocean momentum trend is non‑explosive.
- **Coastline throttle + mask consistency:** confirm `maskPass` fires only at
  step boundaries (throttled by `maskEvery`), and that within a single step the
  **same `uLand` snapshot** is used by `OCEAN_FS`, `AIR_FS`, and `COUPLE_FS`
  (no per‑pass recompute). Flooding/exposing near coasts must be smooth
  (no NaNs, no one‑step flips from a mid‑step regime change).
- **Stability:** new drag/friction terms stay ≥ 0 and finite across depth range;
  shallow‑cell clamps never produce `h_deep ≤ 0`.
- **Regression:** existing view modes, wind‑stress coupling, and vertical
  heat/salt exchange still conserve (they use `hT/hD` which now vary per cell).

## Risks
- Continents fixed at depth 0 keep the air side simple; only shallow ocean cells
  can flood/expose. If deeper flooding is desired later, raise the dynamic
  threshold (out of scope now).
- Stale land mask between updates (up to `maskEvery−1` steps) is physically
  negligible and, by the HARD TIMING RULE, never causes a mid‑step regime flip;
  the `smoothstep` flood transition keeps coastal changes gradual. The only
  residual effect is that a cell exposed/flooded by `h_top` drift waits at most
  `maskEvery` steps before the mask catches up.
- Per‑cell `refHTop` interacts with the steric relaxation; ensure the relaxation
  target stays within `[margin, D − margin]` to avoid clamping bias.

## Relation to the alternative plan (q36)
The q36 plan enumerates the same four features with broad variant tables
(1A–1D, 2A–2D, 3A–3D, 4A–4D) and raises open questions (external data, UI,
platform, backward compatibility). This plan adopts q36's useful variants and
resolves its open questions concretely:
- **Bathymetry**: this plan picks q36's 1A (dedicated depth texture) but grounds
  it — `geodesics.js` already computes a `height[]` noise field that is currently
  discarded; we reuse it instead of adding a second generator (q36's 1C).
- **Stratification drag**: adopts q36's 2A (dynamic, from local stratification);
  reuses the `rhoTop/rhoDeep` already computed for `gPrime` rather than a separate
  Richardson/Buoyancy‑frequency evaluation.
- **Bottom friction**: adopts q36's 3A (inverse‑depth scaling) as default and
  folds in q36's 3D (slope/topographic) and 3C (quadratic stress) as optional.
- **Per‑cell refHTop**: adopts q36's 4B (depth‑proportional) and adds q36's 4C
  (latitude dependence) as the recommended form.
- **Open questions resolved**: no external data loading (procedural reuse); UI
  via auto‑generated sliders (existing mechanism); WebGL2 already required;
  state‑texture layout unchanged so existing saves stay compatible.
- **Key differentiator**: this plan additionally implements a **dynamic, throttled
  coastline** (land mask recomputed every N steps from `depth` vs `h_top`),
  which q36 does **not** include. That is the main extra scope/risk here; q36's
  more conservative alternative is to keep the static land mask and let depth
  vary only for ocean cells.
