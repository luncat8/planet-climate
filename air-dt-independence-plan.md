# Plan: Air dt-independence & robustness improvements

## Context / goal

After the Coriolis CN fix (already applied), the surface air layer (`loA`) is
still ~1.9× windier at `dt=10 s` than at `dt=300 s` after the same 3-day run,
and it slowly grows with time. The original write-up blamed explicit upwind
advection in `stepAir` (Courant `|u|·dt/d` rising with `dt`). That diagnosis
does **not** survive a Courant-number check or an ablation:

| check | result |
|---|---|
| L5 mean spacing | `d ≈ 220 km` (`sqrt(4πR²/V)`, `V=10242`) |
| Operational Courant at `dt=300`, `\|u\|=17 m/s` | `C ≈ 0.023` — a cap of `0.5` **never fires** |
| 1-day L5, default `noise=0.02` | `loA` ratio `dt=10/60/300` = **1.41×** (2.80 / 1.99 / 1.99) |
| 1-day L5, `noise=0` | `loA` ratio = **1.05×** (2.11 / 2.00 / 2.02) |

Almost the entire residual bias is the couple-pass symmetry-break noise

```
Tl += uNoise * nz;    // once per step, not per second
```

(`shader.js` `COUPLE_FS`). Injection rate scales as `1/dt`, so `dt=10 s` is
~6× noisier than `dt=60 s`. Extra `T` variance leaks into diagnostic pressure
and then into the pressure-gradient wind, and it accumulates with time — which
is exactly the reported “small-dt windier, slowly grows” signature. `dt=60`
and `dt=300` already cluster; the split is `dt=10` vs everything else.

The ocean is immune: its speeds (~0.1 m/s) make advective Courant negligible,
and it does not receive this per-step `T` kick.

This plan (1) removes the residual dt bias by making that noise a
dt-independent Wiener increment, (2) keeps the proposed Courant cap and
velocity clamp as **safety nets** (they are not the residual-dt fix), (3) adds
a regression guard, (4) DRYs `coriFric`, (5) scaffolds Semi-Lagrangian air
advection as an A/B comparison, not the default.

## Decisions (resolved)

- **Residual dt fix = scale couple-pass noise by `sqrt(dt / 60)`.**
  `60 s` is `PARAMS.dt.default`, so the default interactive/gate timestep is
  bit-identical (`sqrt(1) = 1`). `sqrt(dt)` is the correct white-noise
  (Wiener) scaling; linear `dt` would over-amplify large-dt noise.
- **Face Courant cap stays**, default `airCourantMax = 0.5`, as a runaway /
  fine-grid guard. It is **not** what makes `dti_check` pass at L5/L6.
- **Air velocity clamp** tightens `±90 → ±60` m/s (observed winds ≲ 17 m/s).
- **Last phase = selectable algorithm**: `airAdvect` switches air advection
  between capped-FV (default) and Semi-Lagrangian, so SL can be A/B compared
  without becoming the default.

## Affected files

- `planet/shader.js` — `COUPLE_FS` (noise `sqrt(dt)` scale); `AIR_FS` (clamp,
  Courant cap, `uCourantMax` / `uAirAdvect`, SL branch); `coriFric` dedup
  into `SHADER_CORI_FRIC`. Dead copies removed from `INIT_FS` / `INIT2_FS`.
- `planet/engine.js` — air pass: `uCourantMax`, `uAirAdvect`.
- `planet/params.js` — `airCourantMax` (default `0.5`), `airAdvect`
  (default `0`, opts FV/SL).
- `planet/app.js` — `airAdvect` dropdown (same pattern as `oceanScheme`).
- `harness/dti_check.js` (**new**) — dt-independence regression check.
- `harness/harness.js` — default `--dir` resolves to `../planet` when present
  (the tree is `planet/` + `harness/`, not `../project`); `protocolTimeout: 0`
  so long runs do not die at the 180 s CDP default.
- `harness/gate.sh` — `LEVELS` env (L7 is slow; sandbox does not need it).
- `harness/baselines/*.json` — **only regenerate if the default `dt=60`
  path actually drifts**. The noise scale is exactly 1 at `dt=60`, the
  Courant cap does not fire, the clamp does not fire; expect identical
  scheme-0 hashes. If a compiler-level hash twitch appears, refresh L5/L6
  only. There is no committed `L7.json`; do not create one in the sandbox.

## Phased task list

### Phase 1 — dt-independence regression test (no behavior change)

- Add `harness/dti_check.js`:
  - One Chromium, one `Planet`. Grid is dt-independent — `reset()` between
    dts, do **not** `build()` each time.
  - Chunked `page.evaluate` (800–2000 steps) so a 3-day run cannot trip
    Puppeteer’s 180 s `protocolTimeout`. Launch with `protocolTimeout: 0`.
  - Default `--dir` = `../planet`.
  - For `dt ∈ {10,30,60,120,300}` at fixed sim time (`SIMT = 259200 s` =
    3 days, level 5) run `planet.params.dt = dt` then `SIMT/dt` steps.
  - Parse `loA` / `hiA` → `comp = max(|u|,|v|)` from channel extrema
    (plan metric) **and** true `max hypot(u,v)` (more physical). Ratio =
    `max/min` across the dt set per layer.
  - Exit non-zero if either layer’s **comp** ratio exceeds tolerance.
    **Tolerance = 1.3×.**
  - CLI: `--simt=`, `--dts=10,30,60,120,300`, `--level=5`, `--tol=1.3`,
    `--params='{...}'`, `--air-advect=0|1`, `--quick` (1 day, `10,60,300`).
- This test **FAILS on current code** (~1.4× at 1 day, ~1.9× at 3 days for
  `loA`) and **PASSES after Phase 3**.
- L7 is out of scope for sandbox validation (`LEVELS=L5 L6`).

### Phase 2 — tighten air velocity clamp

- In `stepAir`, `clamp(v1, vec2(-90.0), vec2(90.0))` → `vec2(-60.0), vec2(60.0)`.
  Sane hard safety net; observed winds ≤ ~17 m/s, so 60 leaves headroom and
  still catches runaway. Keep as a const (slider later if desired).

### Phase 3 — residual dt fix + Courant safety cap

**3a. The actual fix (couple noise).** In `COUPLE_FS`:

```
Tl += uNoise * nz * sqrt(max(uDt, 0.0) / 60.0);
```

`60` is the default timestep, so `dt=60` is a no-op multiply-by-1.
Do **not** touch the hash argument (`floor(uTime*0.37)`); only the amplitude.

**3b. Face Courant cap in `stepAir` (safety, as originally specified).**
Uniform `uCourantMax` from `params.airCourantMax` (default `0.5`). In the
neighbour loop, after `un = 0.5*dot(v0+vj, nrm)`:

```
float unEff = un;
if (uCourantMax > 0.0) {
  float cour = abs(un) * uDt / max(d, 1.0e-3);
  if (cour > uCourantMax) unEff = un * (uCourantMax / cour);
}
```

Use `unEff` for `advV`, `advT`, `div`, and the upwind `w`. `uCourantMax = 0`
disables the cap. Pass the uniform from `engine.js`.

Validation: `dti_check.js` passes (`loA`/`hiA` ratio < 1.3×). 3-day
`dt=10` vs `dt=300` winds cluster; the small-dt excess growth is gone.

### Phase 4 — DRY `coriFric` (cleanup, low risk)

- Extract the GLSL body (the `c==0` bit-exact form from `OCEAN_FS`) into
  `SHADER_CORI_FRIC` and concatenate it only into programs that call it:
  `OCEAN_FS`, `OCEAN_PREDICT_FS`, `AIR_FS`, `COUPLE_FS`.
- Delete the unused copies in `INIT_FS` / `INIT2_FS`.
- Do **not** dump it into `SHADER_COMMON` (every render program would carry
  it). No behaviour change; verify L5/L6 hashes still match (or only twitch
  from AIR/COUPLE recompile, ocean channels untouched).

### Phase 5 — selectable air advection (comparison scaffold)

- `params.airAdvect`: `0 = capped-FV (default)`, `1 = Semi-Lagrangian`.
- Plumb `uAirAdvect` through the `engine.js` air pass. UI dropdown next to
  the ocean-scheme selector; skip it in the auto-slider loop (`opts` present).
- In `stepAir`, branch on `uAirAdvect`:
  - `0` → capped-FV path (Phases 2–3b).
  - `1` → Semi-Lagrangian for momentum/tracers: back-trajectory of the cell
    centre along `-v·dt`, barycentric sample of the 1-ring triangle that
    contains the departure point (clamp to the triangle if the trajectory
    leaves the 1-ring). Replace the upwind flux accumulation (`advV`/`advT`/
    `div = 0`); keep PGF, diffusion, Coriolis, friction at the arrival cell.
    Fall back to FV on `isnan`.
- SL is **A/B only until validated**. `dti_check --air-advect=1` reports
  its ratio; it is not required to pass the 1.3× gate.

## Data flow / invariants

- `step()` order is unchanged: ocean → air (`prog.air`) → couple.
- Phases 2–3b only touch the air program + one multiply in couple.
  The ocean path must remain byte-identical at default `dt=60`.
- The Courant cap is conservative (uses centre distance `d`) and inert at
  operational L5/L6 Courant. dt-independence comes from Phase 3a.
- Default `dt=60` noise amplitude is unchanged → gate hashes should hold.

## Failure modes / risks

- **Baseline drift**: extra ALU in `stepAir` *can* change register
  allocation and twitch air bits even when the cap does not fire.
  Mitigation: run `LEVELS="L5 L6" ./gate.sh …`; refresh only if needed;
  never require L7 in the sandbox.
- **`sqrt(dt)` vs linear `dt`**: linear scaling would make `dt=300` 5×
  noisier per step than today and can invert the ratio. Wiener scaling is
  milder (`×√5 ≈ 2.24` at `dt=300`) and is the right model for a new
  random number every step.
- **Over-capping**: a tiny `uCourantMax` would gut physical advection
  (`C_op ≈ 0.004` at `u=3 m/s`, `dt=300`). Leave the default at `0.5`.
- **SL divergence (Phase 5)**: unstructured geodesic interpolation is
  noisy. Keep SL off by default; fall back to FV on `isnan`.
- **Other per-step relaxations** in couple (`cond *= 0.4`,
  `cloud = mix(..., 0.06)`) are contractions, not sources. At these dts
  they all finish in minutes; leave them alone.

## Validation plan

1. `node harness/dti_check.js --quick` (1 day, 3 dts) → FAIL pre-3a
   (~1.4×), PASS post-3a (<1.3×). Full `node harness/dti_check.js` is the
   3-day / 5-dt gate (slow; optional in sandbox).
2. `LEVELS="L5 L6" ./gate.sh <tag>` scheme 0: `nanCount == 0`; prefer
   identical hashes. Ocean-only physics must not move.
3. Spot-check 1-day (or 3-day) `loA`/`hiA` at `dt=10,60,300` now cluster
   (no monotonic “smaller dt → more wind” trend).
4. Phase 5 (optional): `dti_check.js --air-advect=1` produces finite
   comparable winds.

## Open questions / out of scope

- `f-plane` air Coriolis (`2·Ω·sinφ` instead of flat `2·Ω`): still deferred.
  Earlier measurement showed `sinφ` *worsened* dt-independence while the
  advection/noise artifact dominated. Revisit now that noise is scaled.
- Architectural air continuity / pressure-solve (diagnostic `Pl` from `Tl`
  today): long-term, out of scope.
- Air subcycling (`airSubDt`) would also kill time-integration error in
  `stepAir`, at the cost of extra passes. Not needed for the 1.3× gate
  once noise is scaled; leave it off the default path.
- White-noise vs a frozen spatial symmetry-break pattern: the current hash
  is time-varying on purpose. We only fix its amplitude, not its spectrum.
