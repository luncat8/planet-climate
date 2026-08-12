# Plan: dt-independent air simulation (Carry-over for next session)

**Working dir:** `/media/sf_1/planet242/planet`
**Repo is NOT a git repo.** Do not commit unless asked.

## Goal
Make the air simulation timestep-independent for large `dt`:
- Cap the per-face Courant number in `AIR_FS` so raw upwind advection can't
  over-diffuse and spuriously calm the wind at large `dt` (the original bug:
  large-dt air ~1.9× residual wind bias = too calm).
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
- `node /tmp/air_dt_sweep.js --dir=/media/sf_1/planet242/planet`
- Check console for: shader compile OK, dt-sweep bias table, PASS/FAIL.
