# planet-climate performance plan 40 — WebGPU port, smoothness, soak

Continues `archive/30-improvement-plan-final.md` (archived 2026-09-12 with
P0–P4 complete and its evidence gate closed on owner-GPU captures `30-00`…`30-04`).
Everything from Phase 5 onward of that plan lives here, unchanged in intent, plus
the carry-over items that plan 30 could not close. Nothing in P0–P4 is re-opened
except where a measurement is listed in §2 — those were closed on cells that the
timer could not resolve (see `docs/BENCH.md` → *Capture 30-04*).

Split of responsibility, unchanged from plan 30's third update: the sandbox
authors code and runs `gate.sh` / `bench_backend.js` (SwiftShader-relative);
the **owner machine** produces every absolute number, because the sandbox has
neither a GPU nor WebGPU (`harness/probe_webgpu.js` → `navigator.gpu` undefined
on the `@sparticuz/chromium` 152 build).

## 1. Rules (every phase)

1. Ends with before/after numbers from both benchmarks vs the previous phase's
   committed baseline + `harness/gate.sh <tag>` (L5/L6/L7).
2. Bit-identical by default; float-order/cadence changes ⇒ `--allow-drift`
   **and** re-proved stats (meanT / sstMean / ice area / CO₂ over the gate run).
3. **L6 floor**, in its measured form: *L6 within 2 % of the committed
   owner-GPU ×128 baseline, median-of-3*. The original "L6 160 fps" predates any
   measurement on this project; the owner rig measures L6 explicit ×128 at
   17.0–18.0 ms (56–59 fps). `planet/bench.html` now has a **Runs** field —
   set 3 for any run that has to adjudicate this rule.
4. Baselines are files: `harness/logs/climate-<phase>-<bench>-<hw>.txt`
   (backend = SwiftShader-relative; visual must name the GPU).
5. Every reported number carries its device string; SwiftShader is relative-only.
6. **No sub-tick evidence** *(new, from the 30-04 analysis)*. A timing claim must
   come from a measurement whose resolution is stated next to it:
   - visual: `bench.html` batch-averaged values (span/n with n in the
     `n/batch` column, `# timer:` line in the copied log). A value marked `*`
     hit the batch cap — it is a ceiling, never a magnitude.
   - headless: `bench_backend.js` forced differencing (K repeats + 1 px readback
     of the pass target, `(T2−T1)/(K2−K1)`), closure-checked.
   - Chrome ≥ 91 clamps `performance.now()` to 0.1 ms on any page that is not
     cross-origin isolated (a `file://` page never is; Firefox/Safari clamp to
     1 ms), so a single-shot `t0; work(); finish(); t1` sample cannot support
     any claim below ~1 ms. Acceptances may no longer be closed as
     "floor documented" on such cells.

## 2. Carry-over from plan 30 (close these first — all need the owner GPU)

| # | Item | Why it is open | Close by |
|---|---|---|---|
| **C1** | Re-measure **P3** (tracers) and **P4** (draw sweep) acceptances | Both were closed as *"floor documented"* on cells under the timer tick (`30-03`: `draw ms` 0.00 at every level; `30-04`: draw 0.02, tracers 0.02–0.04 ms). **Half done:** the batched page now returns real values (draw 0.069–0.172 ms, tracers 0.095–0.754 ms, sweep 0.021–0.687 ms in `40-00`/`40-01`), but two runs of the same config still disagree up to 6× and the s15−s0 delta flips sign, because those captures predate the forcing readback. | One owner run on the current page (batches now end in a 1 px forcing readback); P4 wants "L7 draw ≥ 20 % reduced **or** a real floor", P3 wants "L7 tracers ≥ 25 % reduced, 64k ≤ 2× 16k". Accept only a run whose two repeats agree. |
| **C2** | Median-of-3 for the rule-3 L6 baseline | Two same-machine captures disagree by **+32 %** on the cheapest heavy row (L5 explicit ×128: 4.00 → 5.28 ms) while agreeing within ±1.4 % on the five others — single runs cannot resolve 2 %. | `bench.html` with `Runs = 3`; commit the median log under `harness/logs/`. |
| **C3** | Reconcile the disputed owner reference "L6 implicit ×128 = 60 fps" | Measured 39.2–41.7 ms (≈ 25 fps) in four captures; both cannot be true on one machine. | Read the GUI fps HUD at that config once; correct either the reference list in `docs/BENCH.md` or the measurement. |
| **C4** | **P0.5** owner toggle matrix | Never run: substeps 1 vs 8, flow on/off, co2 on/off, scheme 0 vs 2, globe vs equirect as visual-bench row pairs. | One owner run; record beside the backend table it is meant to cross-check. |
| **C5** | Owner-driver **L7 gate baseline** | `harness/baselines/` holds `L5.json` and `L6.json` only (the SwiftShader dir has all three). | One `gate.sh` run on the owner driver with `BASELINES_DIR=baselines`. |
| **C6** | Per-pass attribution | `Planet.trace` failed closure by 1.9–3.9× and reported `ice` *cheaper* at L7 than L5 (absorber artifact of one `finish()` per pass). The first fix (batch isolation) failed too, and `40-00`/`40-01` prove it: `ocean` read 0.001–0.029 ms at L7 (impossible) while `step` read 17.15 ms where the whole ×10 frame is 5.99 ms — closure 0.00–0.86. Now fixed in code: a 1 px forcing readback ends every batch on **all** renderers, and each pass is re-timed from a `serializeState()` snapshot restored per batch (n ≤ 32). | One owner run; the acceptance is `closure` ≈ 1.00 ± 0.1 at every level, and no pass below the tick reported as a magnitude. |
| **C8** | **L7 visual numbers do not reproduce** | `40-00` vs `40-01`, same machine and input: L7 explicit ×128 = 61.27 vs 85.93 ms, L7 implicit ×128 = 119.25 vs **50.38** ms — and 50.38 < 85.93 is impossible, since implicit adds the Jacobi solve to everything explicit does. Both also sit far from the single-shot captures (37.2–37.7 / 243.5–244.0). Suspected, **not verified**: nothing equilibrates L7 — `planet/planet_state.js` is not tracked in this repository and, where present, only applies at L5 — so L7 is measured on a freely drifting state whose cost depends on how much simulation ran first. | Either `node harness/mksave.js --level=7` and apply it at L7, or add a documented spin-up before L7 measurement; then `Runs = 3`. An L7 row where implicit < explicit is invalid evidence and must be rejected by the log reader. |
| **C7** | ~~Forced-completion batches for the visual bench~~ **done** | Every batch now ends in a 1 px `readPixels` on **every** renderer (the owner captures proved a real GPU does not force a batch of one small pass either). The sandbox smoke run went from "explicit 0.100 / implicit 0.100 ms — one tick, no information" to explicit 110.2 ms < implicit 135.1 ms, the physically correct order. | Nothing required. `bench_backend.js` stays the committed headless evidence because it additionally differences two batch sizes and closure-checks. |

## 3. Phase 5 — WebGPU port (3–5 d)

- **P5.1** Port the A/B group to WebGPU compute: SoA float buffers (or textures
  where neighbour access is cheaper), **one command encoder per step**,
  dispatches mirroring the WebGL pass list exactly (same math, same order →
  parity checkable). Layout goal: per-dispatch working set small enough to stay
  in L1/L2 — the direct fix for the implicit-scheme L6→L7 jump plan 30 measured
  (5.7× cost for 4× cells, +42 % ns/cell).
- **P5.2** **Timestamp query ring** (4-buffer resolve, 2 Hz) feeding the same
  pass table. Under rule 6 this is the *primary* per-dispatch instrument on the
  new engine, not a nicety: WebGPU has no `gl.finish()` to batch against, so
  wall-clock batching cannot attribute cost to a dispatch — GPU timestamps can,
  and they are immune to the `performance.now()` clamp entirely. Feature-detect
  (`timestamp-query`); fall back to encoder-span batching when absent.
- **P5.3** No per-frame readback (globals at the Phase-1 cadence); engine
  **toggle** in UI (WebGL default until parity passes); `bench.html` engine
  column — which must keep the batch protocol of rule 6, not revert to
  single-shot timing.
- **P5.4** Parity harness `harness/parity_webgpu.js`: same seed/params/steps in
  both engines, per-field max-abs-diff + hash against the **WebGL reference**;
  tolerance documented (bit-identical if op order is preserved, else a fixed ε
  re-verified at stats level).
- **P5.5** Persistence on the GPU engine: validated binary blob v2 (buffer
  export via `mapAsync`); keep the 8-texture base64 codec for old saves; port
  `mksave`.
- **P5.6** Memory/layout audit: confirm per-cell ms no longer inflates at L7
  (query ring), SoA memory budget at L7 (~40 MB × 2 sets — fine).
- **Acceptance**: L7 ms/step (WebGPU) ≤ 0.5× L7 ms/step (WebGL) at the same
  substeps; L5/L6 no worse; parity gate green; no per-frame readback; L6 floor
  per rule 3. The WebGL side of that ratio is measured on the owner GPU:
  L7 implicit ×128 ≈ 243–249 ms, explicit ≈ 37–39 ms (`30-03`, `30-04`), i.e.
  the WebGPU target is ≤ ~120 ms/frame implicit at ×128.

## 4. Phase 6 — Smoothness: nothing on the rAF path (1 d)

- **P6.1** Audit the rAF loop for awaits/syncs (readbacks, stalls, in-loop
  rebuilds).
- **P6.2** Remaining sync work moves to background cadence (one-cycle-late
  application; the loop only enqueues).
- **P6.3** `bench.html` smooth mode: per-rAF frame gaps → median / p95 / max +
  **hitch count** (gaps > 2× median) per level. Frame gaps are ≥ 16 ms, so this
  one metric is clamp-safe by construction — but the *hitch* comparison must use
  the same batch rules for any sub-frame work it attributes.
- **Acceptance**: p95 ≤ 2× median at L7 (auto) and L6; hitch count ~0 at L6
  default; throughput from Phases 2–5 unchanged.
- P6's rAF hygiene rides along with the P5 integration (as plan 30 specified);
  its smoothness acceptance is measured against the repaired visual baseline.

## 5. Phase 7 — Polish, docs, soak (0.5 d)

- `docs/BENCH.md`: new baselines, pass table, engine column, auto@60 semantics,
  smooth columns; archive phase logs; README performance section (current
  L5/L6/L7 numbers, what "auto" means, GPU needed for WebGPU).
- **Equilibrium soak**: 1,500-day stationary run on the final defaults vs
  baseline (field-RMS drift gate) — the long tail of rule 2. Sandbox-runnable
  in principle (`harness/loadsave_test.js` pattern, SwiftShader-relative), but
  the meaningful soak is the owner-GPU one on the final engine.
- **Acceptance**: docs match committed baselines; `gate.sh L5/L6/L7` green
  (bit-identical or documented `--allow-drift` re-approvals); numbers
  reproducible from the commands in the docs.

## 6. Phase 8 — Stretch (optional, later)

- **P8.1** CPU JS kernel graph (SoA `Float32Array`s) as oracle + no-WebGPU
  fallback; port harness tests (co2, ice, loadsave, mobility, dti) to a
  `node tests/run-all.js` style rig on Node built-ins; parity then runs
  CPU↔WebGPU directly.
- **P8.2** L8 support (bounds fixed in P1.4; memory budget; auto substeps carry
  it).
- **P8.3** Findings/pitfalls doc for the new engine; dt range validation;
  sealed params.

## 7. Cross-borrow (union, both directions)

**planet-climate ← planet-geotectonics**
1. Timestamp query ring, feature-detected (P5.2).
2. 2 Hz "report, never allocate in the frame" perf pattern (P2.1, P5.2, HUD).
3. Event-cadence readback discipline + async one-cycle-late round trips (P1.2,
   P5.3, P6.2).
4. Parity-with-tolerance methodology; bit-identity as an acceptance criterion,
   statistics drift = plan failure (P5.4).
5. Bounded-kernel audit (their `loserRank` lesson → climate's serial O(V)
   reductions, fixed Jacobi counts) (P1.3, P1.4).
6. Checkpoint ring + validated single-blob persistence pattern (P5.5).
7. Test discipline: Node-builtins run-all, structural WGSL check, long-run soak,
   one-factor sweeps, committed baseline logs with device strings (Phase 7, P8.1).
8. Small: dt validation, sealed params, findings/pitfalls doc (P8.3).
9. **Timer-resolution discipline** *(new)*: geotectonics' query ring is the
   clamp-immune instrument; any wall-clock path there should batch the same way
   `bench.html` now does.

**planet-geotectonics ← planet-climate**
1. Standalone `bench.html` GUI: batch-averaged timing with a stated resolution,
   60 fps highlight, `?fast=1` / `?noauto=1`, auto-run, copy-to-clipboard log
   with a device header; and the two-benchmark convention (portable backend vs
   real-GPU visual).
2. Resolution-ladder UX: live L5/L6/L7 rebuild + seed + presets with per-slider
   bounds overrides.
3. Particle-tracer flow-viz technology (persistent tracers, trail conveyor,
   birth/death envelope, vertical-flux sublayer transitions, EMA de-noise,
   mass-consistent recycling) — port it to mantle plumes and crustal drift.
4. 3D globe + cloud shell + equirect display, incl. the per-vertex 1-ring
   pre-blend trick — a 3D plate view.
5. Plain-JS save file for `file://` (complements their binary blob).
6. Per-parameter `tip` metadata (self-documenting sliders).

## 8. Risks & handling

| Risk | Handling |
|---|---|
| Float reordering shifts the tuned equilibrium | Rule 2 (re-prove stats per phase) + Phase 7 soak; the scheme-0 hash baseline stays the arbiter for "unchanged" claims |
| WebGPU availability | UI engine toggle; WebGL stays the reference + fallback until P5 parity passes. Sandbox has no WebGPU at all — `probe_webgpu.js` is the gate |
| Two engines drifting | Parity harness in every Phase 5+ gate; bit-identity as acceptance criterion |
| Save compatibility | Blob v2 with a version header; the old 8-texture base64 codec kept (P5.5) |
| L6 regression during work | Rule 3 (2 % of the committed owner baseline, median-of-3), per-phase bench before merge |
| **Measurement lies** *(new)* | Rule 6. Every phase's evidence must state its resolution; `n/batch` + `# timer:` travel in the copied log; `closure` exposes per-pass attribution that does not add up. The 30-0x history is the cautionary tale: two acceptances were closed on cells the timer could not resolve |
| Scope creep | Phase 8 explicitly optional; Phases 0–4 already bought ≥ 30 fps at L7 via auto substeps |
