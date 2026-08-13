# Unified Cryosphere Module — Plan Review & Implementation

This is the response to `uploads/Cryosphere.txt` in the §9 deliverable format. It
first records where the spec's assumptions had to be **corrected against the real
code**, then the design that was implemented.

## 0. Review — spec vs. actual code (what changed and why)

| Spec claim | Reality in this repo | Consequence |
|---|---|---|
| "Reuse free channels `TopS.w`, `DeepS.z/.w` → preserves codec." | **Every** ocean pass (`OCEAN_FS`, `OCEAN_PREDICT_FS`, `OCEAN_CORRECT_FS`) ends with `oTopS = vec4(hT,Ts,St, 0.0)`, `oDeepS = vec4(Td,Sd, 0.0,0.0)`, `oDeepV = vec4(vd, 0.0,0.0)`. Those "free" slots are **written to literal 0 every substep.** | Naive channel reuse **erases ice each tick.** Either add pass-through to 3 tuned shaders (equilibrium risk) or don't keep ice there at runtime. |
| "Add a 9th texture ⇒ rewrite the whole save/codec." | `serializeState()` just does `A:[0..7].map(readTex)` and `encodePlanetState` base64s that array; `applyState` `writeTex`s them back. | Persistence is tied to those 8 textures — but ice can be **packed into their free channels only at (de)serialize time (pure CPU)**, needing *no* shader/codec change and *no* runtime residence in ocean channels. |
| `ICE_DRIFT_FS` "solves momentum for `u_ice`" and stores it. | — | Storing ice velocity needs 2 more persistent channels. Unnecessary: at 50–300 km cells, sea-ice inertia is negligible, so **free-drift is diagnostic** (`u_ice = f(wind,current)` recomputed per step, incl. for neighbours) → **no stored momentum**, only `iceThk`,`iceFrac`. |
| Feedbacks + phase change all "in `COUPLE_FS`". | `COUPLE_FS` is per-cell (no neighbour stencil); transport needs a 1-ring stencil. | **Split:** energy/salt side of phase change + all feedbacks stay in `COUPLE_FS`; the *mass* side (thickness change) + transport live in a new `ICE_DYN_FS` (has the FV stencil). Rate handed off through transient scratch channels. |
| `MAX_DRAW_BUFFERS` implicitly ≥5 (a 5th ice attachment). | WebGL2 only **guarantees 4** (this sandbox reports 8, but real targets may be 4). | Keep every FBO ≤ 4 attachments → ice lives in its **own** ping-pong texture, not as a 5th couple output. |

Net: the spec's Eulerian / free-drift / SIA / flux-form choices (§5.1–5.6) are all
adopted; the **storage strategy** and **pass decomposition** were redesigned so the
existing tuned equilibrium is not touched and the 8-texture codec is preserved.

## 1. State layout

Runtime: a dedicated **ping-pong `iceA`/`iceB`** RGBA32F texture (`W×H`):
`(iceThk [m], iceFrac [0..1], _, _)`. Not one of the 8 saved textures; the ocean
dynamics shaders are therefore **unmodified**.

Phase-change hand-off (per-step, transient): `COUPLE_FS` writes the freeze/melt
**thickness rate** into `oDeepS.z` and the **new-ice fraction source** into
`oDeepS.w` (both currently written `0.0`, both consumed by `ICE_DYN_FS` the same
step, before the next ocean pass zeroes them). No persistence needed.

Save/Load: `serializeState()` reads `iceTex` to the CPU and packs
`iceThk → A[3].z`, `iceFrac → A[3].w` in the *readback arrays only*; `applyState()`
extracts them back into `iceA`/`iceB`. `A[3]` (`oDeepV`) `.zw` is overwritten by
the dynamics each step, so using it as the save carrier is invisible to the live
sim. **Codec, `mksave.js`, base64 format, and the 8-texture count are unchanged.**

## 2. Shader architecture

`ICE_DYN_FS` (new, one full-screen pass, dedicated 2-channel output):
```
thk, frac      = iceTex(cell)
thk           += deepS.z * dt        // phase-change mass from COUPLE_FS
frac           = max(frac, deepS.w)  // new coverage where freezing began
// diagnostic face velocities, flux-form (upwind) over the 1-ring:
for each neighbour j:
  if ocean face: v_face = driftW*wind_face + driftC*current_face   // free drift
  else (land involved): v_face = -Dsia * (s_i - s_j)               // SIA downslope
                         s = bedElev + thk      (land→ocean gradient ⇒ calving)
  F = upwind(v_face, thk_i, thk_j); accumulate divergence
thk -= dt/area * Σ F           // conservative transport (mass exact)
frac advected likewise; ridging: convergence that would push frac>1 is
  capped at 1 and the excess mass thickens thk.
clamp thk∈[0,thkMax], frac∈[0,1]; NaN/Inf guarded; CFL-limited drift+Dsia.
```
Phase change energy (`ICE_THERMO` role) is folded into `COUPLE_FS` (§3), so no
separate thermo pass — fewer passes than the spec's two.

Ping-pong: `step()` runs `…→ couple(B→A) → ICE_DYN(iceCur→iceNext) → swap iceIdx`.

## 3. Coupling integration (`COUPLE_FS`, ocean mode)

All symmetric / conservative:
- **Albedo (replaces the old `smoothstep(273,258,Ts)` hack):**
  `alb = mix(alb_open, mix(uAlbIce,uAlbSnow,land), iceFrac·uIceOn)`.
- **Insulation:** sensible + latent (evap) air–sea fluxes scaled by
  `(1 − uIceInsul·iceFrac·thk/(thk+H0))` → thicker/greater-coverage ice throttles
  exchange.
- **Freezing point:** ocean `Tf = 273.15 − 0.054·S_top`; land `Tf = 273.15`.
- **Latent heat (energy exact):** super-cooling below `Tf` is converted to ice,
  `dThk = C_w·(Tf−Ts)/(L_f·ρ_ice)`, and `Ts` reset toward `Tf` (freezing warms).
  Existing ice above `Tf` melts, cooling the skin by the same latent budget.
  `L_f=3.34e5`, `ρ_ice=917`.
- **Brine / freshening:** freeze rejects salt `S_top += dThk·ρ_ice·(S_top−S_ice)/(ρ_w h_top)`
  (`S_ice≈4`); melt reverses. Ocean **volume `h_top` is left unchanged** (floating
  ice; volume bookkeeping is second-order at this resolution) — documented
  approximation that protects the free-surface equilibrium.
- **Precipitation routing:** when `T_low < 273.15`, precip is added to `dThk`
  instead of the ocean freshwater flux (removed from `E−P`).
- **Runoff:** melt freshens `S_top` in the cell (calving freshening is applied
  where land ice enters ocean cells in `ICE_DYN_FS`).
- Output: `oDeepS.z = dThk/dt`, `oDeepS.w = new-fraction source`.

## 4. Physics & constants (chosen paths)

- **5.1 Representation:** Eulerian `iceThk`/`iceFrac`. (mass-conserving, ping-pong,
  survives save.)
- **5.3 Rheology:** free drift + natural flux-form jamming (no EVP). `u_ice =
  0.02·wind + 1.0·current` baseline (the classic ~2 % wind-factor), CFL-clamped.
- **5.4 Glacial flow:** SIA as a thickness-diffusion `q = −D_sia ∇s`, `s=bed+thk`,
  with `D_sia ∝ thk^(n+1)` (`n=3`) folded into the coefficient — mass-conserving on
  the FV grid, halts at flat/retrograde slopes, and drives land→sea flux at coasts.
- **5.5 Calving:** emergent — the land→ocean surface-elevation gradient in the same
  unified flux moves ice into the sea; no special-case trigger, mass exact.
- **5.6 Coastal BC:** zero normal flux at the domain edge / invalid neighbours;
  convergence at coasts raises `iceFrac→1` then thickens (ridging).

## 5. Coastal handling

Jamming/ridging: `iceFrac` capped at 1, surplus convergent mass → `iceThk`.
Calving: unified flux across land↔ocean faces (see §4.5), conserving mass and
freshening the receiving ocean cell. No-flux BC: neighbours with `cell≥uCount`
(padding) contribute zero face flux.

## 6. Cost & optimisation

+1 pass per substep (`ICE_DYN_FS`); phase-change energy rides inside the existing
`COUPLE_FS` (0 extra). Memory: +2 RGBA32F `W×H` textures (ice ping-pong) — e.g.
~5 MB at L6 (256×… ) , trivial vs. the existing 8 state + particle pools. Within
the §8.4 budget ("≤ current ocean dynamics"). `iceFrac<ε` cells still execute
(GPU SIMT) but do near-zero work (early `thk==0` short-circuit in the shader).

## 7. Assumptions & open questions

- Floating sea ice does **not** alter `h_top` (volume) — only salinity — to avoid
  perturbing the tuned free-surface. Revisit if sea-level feedback is wanted.
- Diagnostic free drift omits internal ice stress except the flux-form
  jam/ridge; adequate at ≥50 km, not for pack-ice detail.
- `iceFrac` uses a prognostic-advected + `thk`-relaxed hybrid; a full ITD
  (thickness distribution) is out of scope.
- Wind-factor (0.02) and `D_sia`, calving coefficients are exposed as params for
  tuning against equilibrium; baselines regenerated only if the equilibrium
  shifts (it should not, since ice defaults can be toggled).
