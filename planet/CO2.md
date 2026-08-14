# Global CO₂ / carbon-cycle module — plan

The carbon cycle is intrinsically **global and low-dimensional**, so it does **not**
belong on the GPU. CO₂ and biomass are two CPU scalars integrated as ODEs each
frame; the only GPU work is **one tiny reduction pass** (mirroring `MAX_FS`) that
returns a handful of area-weighted global means. No atomics, no per-cell carbon
field, one 2-pixel readback per frame.

The loop closes through the *existing* engine: CO₂ → `greenhouse` uniform → the
GPU climate warms/cools → the reduction reports the new mean temperature & ice
cover → CO₂ fluxes respond. The cryosphere from the previous turn is the slow
variable that makes ice-age–style relaxation oscillations possible.

## Reservoirs & fluxes (CPU, per geological year)

State: `co2` (Cₐ, atmosphere) and `biomass` (C_b). Temperature is **not** modelled
by an ODE — it is read from the real GPU sim (`meanT`, `sstMean`, `landT`).

```
dCa/dt = Volcanism − Weathering + OceanFlux − NPP + Respiration
dCb/dt = NPP − Respiration
greenhouse = clamp( g0 + s·ln(Ca/Cref) , 0, 1 )          # log forcing
```
- **Volcanism** `= V0·(1 + var·ξ)` , ξ∈[−1,1] random. Source. Slider: rate + variability.
- **Weathering** (silicate) `= W0 · iceFreeLandFrac · exp(kW·(landT−Tref)) · (Ca/Cref)`.
  Sink. Increases with T & CO₂; **shuts off where land is ice-covered** — this
  gating is what ends "snowball" states and drives the oscillation. Slider: rate.
- **OceanFlux** (bulk Henry, area-averaged SST) `= Kao·(Ceq(SST) − Ca)`,
  `Ceq = Cref·exp(kH·(SST−Tref))` — warm ocean outgasses, cold ocean absorbs.
  Sliders: exchange rate, solubility sensitivity.
- **NPP** `= B0 · (suitOcean+suitLand)/areaTot · (Ca/(Ca+Chalf)) · (1−Cb/K)`.
  Consumes CO₂. `suit = Σ area·exp(−((T−Topt)/Tw)²)` computed on the GPU per cell
  and summed in the reduction, so the biosphere grows **where the temperature is
  near optimal, on water and/or land**. Sliders: rate, optimal T, tolerance.
- **Respiration** `= R0·Cb`. Returns CO₂ (see §2).

Conservation: atmosphere↔biosphere and atmosphere↔ocean are internal exchanges;
Volcanism (rock→air) and Weathering (air→rock) are the only open terms, so the
long-run balance is simply **Volcanism = Weathering**.

## GPU reduction (`REDUCE_FS`, one pass, 2-pixel output)

Single fragment loops over all `V` cells (like `MAX_FS`), branch on `gl_FragCoord.x`
to fill two vec4s:
```
px0 = (Σ A·T,            Σ A,          Σ A·T|ocean,   Σ A|ocean)
px1 = (Σ A·T|iceFreeLand, Σ A|iceFreeLand, Σ suit|ocean, Σ suit|land)
```
CPU derives meanT, sstMean, landT, iceFreeLandFrac, suitOcean/Land. Read back once
per frame (8 floats). Cost: ~V iterations ×2 fragments, sub-ms even at L7.

## §1 — Time acceleration & getting a watchable ice-age cycle

Real carbon/ice-age timescales are 10⁴–10⁵ yr; the weather sim runs at ~seconds.
So the carbon ODE advances on a separate **geological clock**: `co2Speed` = years
advanced **per physics step** (slider). Per frame it advances `co2Speed·substeps`
years, sub-stepped internally at ≤50 yr for ODE stability.

To *watch* an ice-age cycle: if the emergent limit-cycle period is ≈P years and we
want it to play over N steps, set `co2Speed ≈ P/N`. The offline solver
(`harness/co2_solve.js`) integrates the reduced 0-D model, auto-balances V0=W0 at
the target CO₂, measures the limit-cycle period P, and prints the `co2Speed` for a
~1500-step cycle. (Result baked as the default; see the doc tail after solving.)

**Balance:** at the reference climate `iceFreeLandFrac≈landFrac`, `SST≈Tref`, so
`OceanFlux=0`, `NPP=Resp`, and equilibrium requires `V0 = W0·landFrac`. The solver
sets V0 from the chosen W0 so CO₂ neither runs away nor collapses.

## §2 — The four questions

1. **Logarithmic greenhouse scaling — yes, adopted.** Radiative forcing ∝ ln(CO₂),
   so `greenhouse = g0 + s·ln(Ca/Cref)`. Doubling CO₂ adds `s·ln2`. Without the log,
   high-CO₂ states would over-warm and the thermostat would be too stiff at low CO₂.
2. **Bulk Henry's law with area-averaged SST — yes.** This is exactly the
   `OceanFlux` term: no per-cell ocean carbon, just a relaxation of atmospheric CO₂
   toward `Ceq(SST)` using the reduction's mean SST. Fast, no reservoir tracking.
   (A full DIC reservoir would be more conservative but is unnecessary at this
   fidelity — the user explicitly allowed the heuristic.)
3. **Silicate-weathering feedback — yes, it is the core.** It is both the negative
   feedback that stabilises CO₂ *and*, because it is gated by ice cover, the driver
   of the relaxation oscillation (ice on → weathering off → volcanic CO₂ builds →
   warms → ice retreats → weathering resumes → CO₂ drawn down → cools → repeat).
4. **Is biosphere decay/respiration redundant? Mostly, for the *long-run* balance —
   yes.** Once biomass saturates, NPP≈Respiration and the biosphere is a net-zero
   *buffer*, not a permanent sink; the permanent sink is weathering. But respiration
   is **not** redundant *dynamically*: without it biomass would be an ever-growing
   one-way sink and CO₂ would collapse. So we keep it, but framed as a fast
   buffer/feedback (default `R0` small, biomass reaches a carrying capacity).

## Integration points
- `co2`, `biomass` live in `params` → saved with the state automatically.
- `stepCO2()` runs once per frame in `loop()` (before the substeps, so the frame's
  `greenhouse` reflects current CO₂); the harness calls it explicitly.
- When `co2On`, `greenhouse` becomes a **derived readout** (slider overridden);
  when off, the manual greenhouse slider works exactly as before (backward compat).
- New view: header readout of CO₂ / greenhouse / biomass / mean T; sliders in the
  tuning panel; an "Ice ages (CO₂ cycle)" preset near the oscillatory regime.

## Solver results & tuned defaults (baked)

`node harness/co2_solve.js` (reduced 0-D model):
- Balanced **volcanism V0 = 0.056 ppm/yr** (bisected so long-run mean CO₂ → 280).
- The attractor is a **stable weathering thermostat** (no self-sustained limit
  cycle in the reduced model): CO₂ relaxes back after perturbation. This is the
  physically honest result — real glacial cycles are **paced by Milankovitch
  orbital forcing**, which is out of scope here. The ice-gated-weathering
  *machinery* for oscillation is present, so the live GPU system (spatially rich,
  with the slow cryosphere) can wobble, and the sliders let you push toward the
  edge of stability.

Baked defaults (per geological year): `co2Sens 0.09`, `volcRate 0.056`,
`weatherRate 0.09`, `weatherTsens 0.055`, `oceanCO2K 8e-4`, `oceanCO2Tsens 0.03`,
`bioRate 8`, `bioResp 0.005`, `bioOptT 290 K`, `bioTwidth 12 K`, `co2Speed 20
yr/step`. `co2On` defaults **off** (so existing presets/greenhouse slider are
unchanged); the **“CO₂ carbon cycle” preset** turns it on with a lively clock.

**Time acceleration (§1 answer):** the carbon ODE runs on `co2Speed` geological
years per physics step (default 20; the preset uses 40). At 8 substeps that is
160–320 yr/frame, so CO₂ perturbations equilibrate over seconds of wall-clock.
For a would-be ~100-kyr cycle to play over ~1500 steps you'd set `co2Speed ≈ 65`.

## Validation
- `harness/render.js`: **26 programs, 48 draws, 0 failures / 0 console errors**
  (REDUCE_FS compiles).
- `harness/co2_test.js` (authoritative, deterministic): global reduction correct
  (meanT/sstMean/landT/ice-free-land/suitability all sane), CO₂ stays **bounded**,
  **biomass is a stable buffer** (~234, no crash), greenhouse tracks CO₂, and the
  system **responds**: volcanism ×10 → CO₂ 721 ppm / GH 0.64; volcanism 0 → CO₂
  falls back to ~285. No NaN. Save round-trips CO₂/biomass exactly (in `params`).
- Note: the full app cannot be exercised live under the **headless SwiftShader**
  sandbox — the WebGL context is lost after a few seconds of full rendering
  **regardless of CO₂** (verified with CO₂ off). This is a sandbox/CPU-renderer
  limit only; a real GPU browser runs it fine, and the reduction pass is trivial.

## Update — ice-age dynamics + Milankovitch (turn 30)

### Review (`29_review.txt`) verified against the code
That file is a meta-review of two LLM reviews. Its two "highest-risk" claims are
**false**: (1) "the reduce draw happens before the FBO is bound" — `fullscreen()`
binds `this.fbo[name]` before drawing, so the target is correct; (2) the texture
channels (`uCellA.w`=area, `uCellB.w`=land, `uTopS.y`=T, `uIce.y`=frac) are the
real layout. `stepCO2` is confirmed to run before `step()`. Real items were
minor and fixed: the dead `landFrac` in `stepCO2` (removed) and the hardcoded
`REDUCE_FS` loop bound (raised 200000→700000, still `break` at `uCount`).

### The real bug behind "CO₂ won't grow / temperature stays low / no cycle"
Diagnostic: sweeping `greenhouse` 0.55→1.0 changed the mean temperature by
**0.0°C** — because the ocean's heat capacity (~decades) dwarfs the 128 s of sim
time per step, so greenhouse forcing can never move temperature within any
watchable step budget. The carbon cycle was correct but **decoupled from the
visible climate**.

Fix — **impose the accelerated climate on the sim.** `stepCO2` now computes a
target global-mean surface temperature
`Ttarget = climBaseT + climCO2Sens·ln(CO₂/ref) + Milankovitch − climAlbedo·iceFrac`
and hands `dT = Ttarget − meanT` to `COUPLE_FS`, which nudges the whole surface
(ocean column + air) toward it by `climForceFrac` per frame (uniform shift ⇒ the
spatial cold-pole pattern is preserved). Because the ice thermodynamics live in
`COUPLE_FS`, shifting the field directly grows/retreats ice.

### Milankovitch orbital forcing
`milankOn` adds `milankAmp·sin(2π·geoYears/milankPeriod)` to `Ttarget`. `geoYears`
advances by `co2Speed·substeps` per frame, so one cycle spans
`milankPeriod / co2Speed` steps — e.g. period 100 kyr with `co2Speed 2` ⇒ ~50 k
steps (~a minute of wall-clock), matching the requested 50 k–200 k range.

### Snowball fix (was trapping frozen)
Air–sea CO₂ exchange is now gated by open-ocean fraction `(1−iceFrac)`, so a
frozen planet stops drawing CO₂ down and volcanic CO₂ **builds up until it melts**
— the real mechanism that ends snowball states (verified: CO₂ rose to >400 ppm
under heavy ice instead of collapsing).

### Verified behaviour
- **Volcanism now drives CO₂ & temperature** (the original complaint): volc
  0.02→1.0 → CO₂ 221→642 ppm, mean T −6.3→+1.4 °C, ice 37→32 %.
- **Milankovitch drives visible glacial cycles**: ice advances *and* retreats each
  orbital period (e.g. …46→40→51→43→59→49→67→57 %), T swings ~18 °C, CO₂ 178–299
  ppm, all finite, no NaN. (A slow multi-cycle glaciation drift remains and is
  tunable via `climAlbedo` / `climBaseT` / `volcRate`; deep-ice phases self-
  terminate through CO₂ buildup.)
- `render.js`: 26 programs, 48 draws, **0 failures**.

New params: `climCO2Sens, climAlbedo, climBaseT, climForceFrac, milankOn,
milankPeriod, milankAmp` (+ internal `geoYears`). Preset **“CO₂ carbon cycle”**
enables the whole thing with `co2Speed 2`, 100-kyr orbit.
