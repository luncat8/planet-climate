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

## Critical prerequisite: top‑layer pressure‑gradient (PGF) fix

Profiling data shows the current top‑layer PGF is **~490× too strong** and is a
hard blocker for per‑cell `h_ref`:

- Code (`shader.js:316`): `accT = -9.81*gradH` (full gravity) on the **top**
  layer, while the deep uses `accD = +gp*gradH` with `gp ≈ g' ≈ 0.02`.
- This is a rigid‑lid reduced‑gravity two‑layer model (`h_deep = H − h_top`),
  so the interface displacement drives the top layer with **reduced gravity
  `g'`**, not full `g` (theory: `accT = -g'·gradH`, `accD = +g'·gradH`).
  Full `g` is only correct if `h_top` were the free surface; it is the interface.
- Today it is masked because `h_top` is nearly uniform (global ~60 m). As soon as
  `h_ref` becomes per‑cell (Feature 4) it imposes a **permanent** spatial
  gradient on `h_top`, and with `9.81` that yields geostrophic currents of
  1–10 m/s (saturating the 3.0 velocity clamp) everywhere → the simulation is
  dominated by spurious topographic currents.

**Required before per‑cell `h_ref` is exercised. DECISION (resolved): use
**(B) Perturbation form** — `accT = -G·grad(h_top − h_ref)`,
`accD = +gp·grad(h_top − h_ref)`, where `h_ref = uBathy.y` is the per‑cell
reference thickness and `G` keeps the current `9.81` (or a tuned value). This
subtracts the permanent reference gradient, so per‑cell `h_ref` contributes no
force while the existing dynamic steric circulation is preserved. It needs an
extra gather accumulation `gradHref` (same FV stencil as `gradH`).

- *Alternative (A) Pure reduced‑gravity:* `accT = -gp·gradH` (use `g'`, not
  `9.81`). Physically purest, but surface currents become ~500× weaker and may
  need recalibration of the velocity clamp / particle scaling to stay visual.
  Not selected; kept only as a future option.

Either way the deep layer stays `accD = +gp·gradH` (already correct). After the
fix the gravity‑wave CFL *improves* (top internal speed drops from 24.26 to
~1.1 m/s at level 6), so no new timestep restriction is introduced.

## Implementation steps (ordered)
0. **Fix the top‑layer PGF (prerequisite).** In `OCEAN_FS` (`shader.js:316`)
   apply the chosen form (B or A above). For (B) add `gradHref` accumulation in
   the neighbour loop and subtract it; for (A) just replace `9.81` by `gp`. Do
   this before running with per‑cell `h_ref`. Verify (Validation: PGF) that a
   permanent `h_ref` gradient no longer produces spurious currents.
1. **Export bathymetry from the mesh generator.** In `geodesics.js Grid.build()`,
   keep `height[]` and, after the existing land computation, produce a per‑cell
   `oceanDepth` and `refHTop`. Recommended mapping (agent may tune):
   `depth = clamp((thr - height)/(thr - minHeight), 0, 1) * Dmax` with
   `Dmax ≈ 4000 m`; `refHTop` should vary regionally — recommended form combines
   bathymetry and latitude (deeper mixed layer toward high latitudes, as in a
   real thermocline): `refHTop = clamp(globalHtop * smoothstep(0, refDepth, depth)
   * latFactor(|lat|), minHTop, depth - margin)` where `latFactor` ramps the mixed‑layer depth from shallower at the equator to deeper at the poles (suggested concrete default, from q36: `50 + 950·(|lat|/(π/2))²` m, capped to `≤ 0.8·depth`).
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
6. **Stratification‑dependent inter‑layer drag (OCEAN_FS).** Use the **Bulk
   Richardson number** across the interface,
   `Ri = gPrime * h_layer / |Δu|²` (with `Δu = u_top − u_deep`, `h_layer` the
   local top‑layer thickness `h1`, and `gPrime` already computed for `gp`), and
   reduce the drag by a Pacanowski‑Philander‑style factor so a strong pycnocline
   suppresses momentum exchange:
   `dragEff = uDrag * mix(1.0, 1/(1 + aRi*Ri)², stratDrag)` with `aRi ≈ 5`
   (data: `Ri≈3000 → ≈4e‑9`, `Ri≈53 → ≈1.4e‑5`, `Ri≈1.2 → ≈1.9e‑2`). Calibrate
   `aRi`/`stratDrag` so weak stratification (low `Ri`) keeps strong drag and a
   strong pycnocline (high `Ri`) nearly kills it. Add param `stratDrag` (0 = off,
   matches today's constant drag).
7. **Depth‑dependent bottom friction (OCEAN_FS).** Replace constant `uFricDeep`
   with a **quadratic, depth‑scaled** form (data‑backed):
    `fricDeepEff = Cd * |v_deep| / max(h_deep, minH)` with `Cd ≈ 2.5e‑3` and a
    depth floor `minH ≈ 10 m` (q36) to avoid singularity on shallow shelves. This
   gives the observed behaviour — strong on shelves (e.g. `r≈3e‑5 1/s`, τ≈0.4 d),
   weak in the abyss (`r≈1.25e‑8 1/s`, τ≈926 d) — versus the current constant
   `uFricDeep=6e‑7` (τ≈19 d everywhere, far too strong in the deep). In the
   implicit‑Euler update `v1 = (v0 + dt·acc)/(1 + dt·fric)` this makes the drag
   term `−fricDeepEff·v` effectively `−Cd·|v|·v/h_deep` (quadratic bottom
   stress). Add param `bottomDragCd` (= `Cd`); keep `fricTop` unchanged. Optional
   stronger variant: also raise `Cd` with local bathymetry slope `|∇D|`
   (topographic/sill friction).
8. **Switch all shaders that read `land` to `uLand`.** `OCEAN_FS`, `COUPLE_FS`,
   `AIR_FS`, and the globe/equirect render shaders currently use `cb.w`. Replace
   with `texelFetch(uLand, cTex(cell),0).x`. Keep `cb.w` only as the continent
   base inside `maskPass`.
9. **UI.** Sliders for new params auto‑generate from `PARAMS` (step present), as
   the other ocean knobs already do. Optionally add a "Sea‑floor depth" view mode
   reading `uBathy.x`.

10. **Coriolis stability (recommended).** Forward‑Euler Coriolis injects energy
    every step (data: `f·dt=0.252 → 3.1%/step`; at the spin slider max
    `2Ω·dt=1.30 → 64%/step`), currently masked only by the velocity clamp. Make
    it robust with a **semi‑implicit 2×2 solve** in `OCEAN_FS` and `AIR_FS`.
    Let `f = 2·uOmega·n.y` (Coriolis parameter, `n.y = sin(lat)`). First compute
    the non‑Coriolis update `u' = u₀ + dt·accU`, `w' = w₀ + dt·accW` (pressure,
    drag, diffusion, advection — but **not** the Coriolis term). Then apply the
    implicit rotation and friction together:
    `u₁ = (u' + dt·f·w') / ((1+(dt·f)²)·(1+dt·fric))`,
    `w₁ = (w' − dt·f·u') / ((1+(dt·f)²)·(1+dt·fric))`.
    This conserves kinetic energy exactly (the `(1+(dt·f)²)` denominator is the
    energy‑conserving implicit‑Coriolis factor) and is stable for all `f·dt`,
    removing dependence on the velocity clamp.

    **WARNING — do NOT copy the q36.txt Coriolis snippet** (`accT +=
    coriolis/(1+fn*fn)`, `fn=0.5·dt·f`). That only dampens the *explicit*
    Coriolis and still grows energy (~+83%/step at `f·dt=1.3`); its comment
    formula `1+0.5·dt·f²` is also dimensionally inconsistent. Use the 2×2 solve
    above instead.

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
- `shader.js`: `OCEAN_FS` **PGF fix (`accT` at ~316)** + depth/drag/friction
   (~196‑370), `COUPLE_FS` depth/land (~470‑660), `INIT_FS` seed (~663‑684),
   `AIR_FS` land (~372‑449) + Coriolis semi‑implicit, globe/equirect
   `OCEAN_UNPACK`/land usage (~40‑59, ~810‑852) + `uBathy`/`uLand` samplers.
- `params.js`: add `maskEvery`, `stratDrag`, `bottomDragCd`; keep `hTop`
   as global default feeding per‑cell `refHTop`.

## Open decisions left to the implementing agent
1. **Top‑layer PGF form — RESOLVED: (B) Perturbation** `−G·grad(h_top−h_ref)`
   (see Critical prerequisite). (A) pure reduced‑gravity kept only as a future
   alternative. Mandated before per‑cell `h_ref` is run (step 0).
2. `depth`/`refHTop` mapping constants: `Dmax`, `refDepth`, `margin`, `latFactor`.
3. Stratification drag: `aRi` in `1/(1+aRi·Ri)²` and the `stratDrag` blend
   weight; confirm `Ri = gPrime·h_layer/|Δu|²` indexing.
4. Bottom friction: `Cd` default (data suggests `2.5e‑3`), `minH` floor for
   `h_deep`, optional slope‑dependent `Cd` boost.
5. Coriolis: adopt semi‑implicit/Crank‑Nicolson (recommended) vs leave
   forward‑Euler + clamp (flag residual drift).
6. `texMask` R32F vs RGBA32F (pick minimal channels); `maskEvery` default 16.

## Validation
- **PGF fix (critical):** with per‑cell `h_ref` active, apply a permanent
  bathymetric `h_ref` gradient (e.g. 50 m over 3000 km) and confirm the resulting
  geostrophic velocity is *small* (form B: ≈0 because the reference gradient is
  subtracted; form A: `g'·Δh/(f·L)` ≈ 0.003 m/s), **not** the 1.6 m/s the old
  `9.81` produced. This is the regression that would otherwise blow up Feature 4.
- **Mass (GPU readback):** probe `Σ h_top` via `readPixels` on the `topS` texture
  at ~1 Hz (data: 256×161 RGBA32F ≈ 644 KB/probe, cheap). Global
  `Σ(h_top + h_deep) = Σ D(cell)` must stay constant (D fixed); mean `h_top`
  should hover near mean `refHTop` with only slow drift from E−P/surfMass.
- **Momentum:** drag remains equal & opposite (now weighted by per‑cell
  `ρ·h_deep`); verify total ocean momentum trend is non‑explosive.
- **Coastline throttle + mask consistency:** confirm `maskPass` fires only at
  step boundaries (throttled by `maskEvery`), and that within a single step the
  **same `uLand` snapshot** is used by `OCEAN_FS`, `AIR_FS`, and `COUPLE_FS`
  (no per‑pass recompute). Flooding/exposing near coasts must be smooth
  (no NaNs, no one‑step flips from a mid‑step regime change).
- **Stratification drag:** verify `dragEff` drops sharply as `Ri` rises
  (e.g. `Ri≈3000 → ≈4e‑9` of base) and recovers for low `Ri`; no negative/`NaN`.
- **Bottom friction:** verify shelf cells damp far faster than abyssal cells
  (quadratic `Cd·|u|/h` form), and that abyssal `τ` is now ~hundreds of days, not
  ~19 d.
- **Coriolis energy:** with semi‑implicit treatment, kinetic‑energy trend per
  step must be ≈0 at default *and* max spin (no 3–64 %/step growth). If step 10
  is skipped, at least confirm the clamp prevents blow‑up and flag the residual
  energy drift.
- **Stability:** new drag/friction terms stay ≥ 0 and finite across depth range;
  shallow‑cell clamps never produce `h_deep ≤ 0`.
- **Regression:** existing view modes, wind‑stress coupling, and vertical
  heat/salt exchange still conserve (they use `hT/hD` which now vary per cell).
- **Shader sampler budget:** adding `uBathy` + `uLand` keeps `GLOBE_VS` at
  ≤14 vertex‑stage texture units (data: 12 + 2 = 14 < MAX_VERTEX_TEXTURE 16),
  so the new view mode / land read compile on WebGL2.

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

## Relation to the alternative plan (q36 / q36.txt)
`q36.txt` is the same variant catalog as the earlier q36 plan, but now **merged
with the diagnostic data** (PGF blocker, Coriolis instability, bottom‑friction
calibration, Richardson/Pacanowski numbers). Its conclusions overlap this plan;
the useful, data‑backed pieces were already adopted here. Two deliberate
divergences and one correction:

- **PGF form — DIVERGENCE:** q36.txt mandates pure reduced‑gravity (form **A**:
  `accT = -gp·gradH`). This plan uses the **perturbation form (B)** you chose
  (`accT = -G·grad(h_top − h_ref)`), which keeps today's dynamic circulation and
  only neutralises the spurious permanent gradient. Form A is kept as a future
  alternative.
- **Coriolis — CORRECTION:** q36.txt's concrete snippet
  (`accT += coriolis/(1+fn*fn)`, `fn=0.5·dt·f`) is **incorrect** — it only
  dampens the explicit Coriolis and still grows energy (~+83%/step at `f·dt=1.3`);
  its comment `1+0.5·dt·f²` is also dimensionally inconsistent. This plan's step
  10 specifies the correct implicit 2×2 solve (the `(1+(dt·f)²)` energy‑conserving
  factor), with an explicit warning not to copy q36's snippet.
- **Shared adoptions:** bathymetry via reused `height[]` (q36 1A, grounding the
  discarded field); strat drag = Richardson `1/(1+5Ri)²` (q36 2A); bottom
  friction = quadratic `r = Cd·|u|/h`, `Cd≈2.5e‑3`, `minH≈10 m` (q36 3C);
  per‑cell `refHTop` = depth‑proportional + latitude (q36 4B/4C, concrete
  `50+950·(|lat|/(π/2))²` m profile added here). Open questions resolved
  (procedural reuse, auto sliders, WebGL2, unchanged state layout).
- **Key differentiator:** this plan additionally implements a **dynamic, throttled
  coastline** (land mask recomputed every N steps), which q36.txt does **not**
  include; q36's conservative alternative is a static mask with per‑cell depth
  only.

