# Plan: dt-independent air simulation (Carry-over for next session)

**Working dir:** `/media/sf_1/planet242/planet`
Ddo not test L7 - it is slow.

## Goal
Make the air simulation timestep-independent for small `dt` (currently values <20 cause wind grow. 
in test wind at dt=0.5 (5.56 m/s) is 4.8× stronger than at dt=8 (1.17 m/s) — real dt-dependence
Some told the situation is revert: high dt cause slow wind, but visually it looks better with dt 80...200 then with dt=5, so i think bug with lod dt). What some models suggest to try:
- Cap the per-face Courant number in `AIR_FS` so raw upwind advection can't
  over-diffuse and spuriously calm the wind.
- Keep FV (capped) as the DEFAULT air path.
- Add an opt-in Semi-Lagrangian air advection (`airAdvect==1`) as a comparison
  scaffold only.
- Verify with a dt-sweep harness: residual wind / wind bias must be flat across
  `dt` ∈ {0.5, 1, 2, 4, 8} for the FV-capped path.

## Constraints (UI params)
- `airCourantMax`: default 0.5, min 0.05, max 2, step 0.05.
- `airAdvect`: default 0, min 0, max 1, step 1.
- FV = default; SL = opt-in via `airAdvect`.

## DONE (code edits already applied & syntax-checked)
1. **`params.js`** (lines ~31-37): added `airCourantMax` and `airAdvect` after
   `fricAirLow`. Confirmed present.
2. **`shader.js` `AIR_FS`:**
   - Uniform line 1074: added `uCourantMax, uAirAdvect`.
   - Per-face Courant cap inside neighbor loop: `un -> unEff` via
     `unEff = un * (uCourantMax/cour)` when `cour = |un|*uDt/max(d,1e-3) > uCourantMax`.
     `unEff` used for `div`, `advT`, `advV` (consistent FV transport). `d` is the
     center-to-center distance from `uNbrA` (`.z`), guarded with `max(d,1e-3)`.
   - SL branch (`uAirAdvect>0.5`): back-trajectory of cell center along
     `-v0*uDt`, inverse-distance-weighted sample of `vDep/trDep` from 6-ring
     neighbours + self, folds into `advV=(v0-vDep)/dt`, `advT=(tr0-trDep)/dt`,
     `div=0`. GradP/Cori/fric untouched.
   - Clamp `v1` to ±60 m/s (was ±90). Line 1203.
   - **DRY done via `dry2.js`**: `coriFric` extracted to `var CORI_FRIC_GLSL`
     const (inserted after `SHADER_HEAD` closing `;`), 6 inline copies replaced
     with `${CORI_FRIC_GLSL}`. `MODE_FIELDS` const is preserved (still exactly 1
     definition). `node -c shader.js` passes.
3. **`engine.js`** (air draw block ~line 451): sets `.f('uCourantMax', P.airCourantMax)`
   and `.f('uAirAdvect', P.airAdvect)`. Confirmed present.

## LEFT TO DO
1. **Recreate the dt-sweep harness** — it was in `/tmp` and is GONE (tmp cleared).
   Rebuild `/tmp/air_dt_sweep.js` (or commit to repo as `tools/air_dt_sweep.js`):
   - Initialize the same air IC used by the app (flat rest + a wind kick / a
     single rotating cell, plus a temperature dipole so Coriolis drives wind).
   - Loop `dt` ∈ {0.5, 1, 2, 4, 8} with `airCourantMax=0.5`, `airAdvect=0`.
   - Run N steps per dt; measure residual wind speed (RMS |v|) and the
     high-vs-low `dt` wind bias.
   - Assert bias within tolerance (e.g. |bias| < 5-10%) → proves dt-independence.
   - Also run with `airAdvect=1` at the same dt sweep to sanity-check SL path
     does not blow up / is also dt-flat.
   **IMPORTANT:** harness MUST be invoked with explicit
   `--dir=/media/sf_1/planet242/planet`. There is NO `project` symlink; the
   default dir resolution fails with ENOENT. (See `main`/dir handling — confirm
   the `--dir` flag parsing; if none exists, add minimal `process.argv` parsing
   to accept `--dir=`.)
2. **Run harness**, confirm FV-capped path is dt-flat (bias within tolerance).
3. **GL error check**: add/verify a `gl.getError()` check after the air draw in
   engine.js (or in harness) to catch any shader-compile/link issue from the
   uniform addition. (REGL surfaces shader errors as thrown exceptions on
   `prog.use()`; ensure harness/node run surfaces them rather than silently
   passing.)
4. **SL sanity**: confirm `airAdvect=1` produces sensible, stable, dt-flat output
   and does not regress default (airAdvect=0) behavior.

## Pitfalls / reminders
- `dry2.js` already ran once successfully and preserves `MODE_FIELDS`; do NOT
  re-run it unless `shader.js` is regenerated. If you must regenerate, the script
  lives at `/tmp/dry2.js` (also gone — recreate from the inline copy in prior
  context if needed).
- `v1` clamp at ±60 intentionally bounds wind; keep it.
- The cap must scale `un` for BOTH momentum (`advV`) and tracer (`advT`) and the
  divergence term, otherwise transport is inconsistent.
- REGL: `Prog` compile errors throw on first `use()`; a missing/extra uniform in
  the JS `.f()` call vs the shader is fine (REGL ignores unused), but a uniform
  referenced in shader but never set defaults to 0 — `uCourantMax=0` would make
  `cour>0` almost always true → `unEff=0` (frozen air). Always set it (done).

## Verification commands
- `node -c shader.js && node -c engine.js && node -c params.js` (syntax).
- Harness lives in the repo now: `node harness/air_dt_sweep.js --dir=/media/sf_1/planet242/planet`
  (defaults: level 4, time 172800 s, dts 0.5,1,2,4,8, advects 0,1, tol 0.10).
  Extra flags: `--time=`, `--dts=`, `--advects=`, `--tol=`, `--level=`,
  `--patch='{"noise":0}'` (param overrides), `--out=file.json`.
- Check console for: shader compile OK, dt-sweep bias table, PASS/FAIL.

## RESULTS (this session)
- Harness recreated at `harness/air_dt_sweep.js` (was lost from /tmp). Runs the
  FULL integrated step for a fixed simulated time T at each dt, measures air RMS
  |v| over wet cells, and asserts the FV path is flat across dt.
- **GL error check (#3):** added `gl.getError()` flushes; the only error seen was
  a stale one from the constructor's one-shot `render()` (rAF is stubbed) — flush
  it post-construct. No errors from the air draw / readback. Shader compiles OK.
- **KEY FINDING — the Courant cap is NOT the real fix.** With `d ≈ 1e6 m`
  (great-circle spacing) and realistic winds, the per-face Courant
  `|u|·dt/d` is ~1e-5·dt — i.e. << `uCourantMax=0.5` for any dt the app uses, so
  the cap is inert and cannot remove the dt-bias.
- **Root cause of the dt-dependence:** `COUPLE_FS` injected the symmetry-break
  noise as a *fixed per-step* amount: `Tl += uNoise*nz`. Over a fixed simulated
  time the accumulated forcing scales as N = T/dt → ~1/dt, so smaller dt spun
  the wind up far harder (and, via `Tl→Pl`, built a larger pressure gradient).
  At 1 day: rmsWind 5.56 m/s @ dt=0.5 vs 1.17 m/s @ dt=8 (130% spread); PlRange
  3047 vs 1439 Pa. With `--patch={"noise":0}` the spread collapsed to 6.5%,
  confirming noise as the dominant driver.
- **Fix applied (shader.js ~L1419):** `Tl += uNoise * nz * (uDt/60.0)` — scale
  the per-step increment by dt so the total forcing over any fixed time is dt-
  independent. Reference dt=60 preserves the original tuned amplitude at the
  default timestep (no change to default app behavior).
- **Verification after fix:**
  - 2 h sweep dt∈{0.5,1,2,4,8}: FV relSpread **0.2%** (was 6.7%), SL **1.4%**,
    stable (no NaN/explosion). PlRange/TlRange now match across dt.
  - 1 day, dt=0.5 vs 8: FV relSpread **6.6%** (was 130%). PASS.
- **SL sanity (#4):** opt-in `airAdvect=1` is dt-flat (1.4% @ 2 h) and stable;
  does not regress default (airAdvect=0) behavior.
- NOTE: a small ~6% residual remains even with noise off (genuine base numerics of
  the capped-FV advection / convection); it is within the 10% tolerance. If tighter
  dt-flatness is wanted later, also audit the fixed-fraction relaxations
  (`cloud = mix(...,0.06)`, `rain = mix(...,0.10)`) and the convection cap
  `clamp(uConv*buoy*uDt,0,0.45)` for dt-consistency.

