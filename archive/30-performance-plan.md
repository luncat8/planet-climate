# planet-climate plan — performance: L7 usable, L6 untouched

Date: 2026-09-11 (rewritten; the first copy was lost from the shared workspace).
Scope: the WebGL engine in `planet/` and its two benchmarks. Goal-driven
features (CO₂, cryosphere, flow-viz) are treated as subsystems to be
instrumented and budgeted, not rewritten.

## Context and anchors

Owner-rig targets to hold or beat (real GPU, from the project owner):

- **L6 = 160 fps** (default settings) — must not regress in any phase.
- **L7 = 10 fps** (default settings) — the pain point; target **≥ 30 fps**
  at the default dt, or an explicit documented trade (fewer substeps, same
  simulated-days/s).

Reference points already in the repo:

- `docs/BENCH.md`: at L6 the frame is **draw-bound** (×10 and ×128 substeps
  both hit 60 fps), explicit ≈ 2× faster than implicit, L7 ≈ 4× slower.
- `harness/bench_backend.js` SwiftShader baseline: ms/step 1.42 (L5) /
  2.02 (L6) / 3.08 (L7) explicit — on CPU, overhead-bound, so the real-GPU
  L7 number (≈ 8 ms/step at 10 fps ÷ 8 substeps + draw) is physics-bound,
  not draw-bound.
- Engine shape (verified against the current tree): one `step()` is a fixed
  sequence of fullscreen-quad passes — ocean (1, or Jacobi set for scheme 2),
  air (1), `couple` (2: cplO + cplA), optional `projectBarotropic`,
  optional `stepIce` — writing A→B→A textures; the loop runs `substeps ×
  step()` (default 8) + `stepSmooth` + `stepVFlow` + `stepFlow` +
  `render` (globe + streamlines, 16k tracers default). 22 `fullscreen(`
  call sites in `engine.js`. `computeGlobals` does **3 `readPixels`**
  (GPU→CPU sync) and is invoked from the CO₂ loop; `serializeState` reads
  all 8 textures.

## Rules (apply to every phase)

1. Every phase ends with: **before/after numbers** from both benchmarks
   against the baseline committed at the *previous* phase, plus
   `harness/gate.sh <tag>` for L5/L6/L7.
2. Bit-identical by default. A phase that changes float order or cadence
   (not just code shape) gates with `--allow-drift` **and** re-proves the
   statistics (meanT / sstMean / ice area / CO₂ over the gate run).
3. L6 160 fps is a hard floor: any phase that costs L6 more than 2% is
   reverted or compensated before merging.
4. Baselines are files: `harness/logs/climate-0.1-phase<N>-<bench>-<hw>.txt`
   (backend runs are SwiftShader-relative; visual runs must name the GPU).

## Phase 0 — Instrumentation and baseline (0.5–1 d)

Goal: make the per-frame cost visible at pass level before touching anything.

- **P0.1 Pass-level timing in `bench.html`.** Wrap each pass (ocean / air /
  cplO / cplA / proj / ice / smooth / vflow / flow / draw) in
  `performance.now()` deltas inside the bench page (the bench controls the
  loop, so it can wrap `step()`'s parts via a small `Planet.prototype.trace`
  toggle that names the pass). New table: **pass ms/step** per level,
  sampled with the same time-boxed median as the existing rows.
- **P0.2 Same for `bench_backend.js`** (node-side wall around the same
  passes, one `gl.finish()` after each step as today) — this gives a
  portable pass breakdown that works in the sandbox.
- **P0.3 Readback audit.** Inventory of every `readPixels` / `readTex`
  call site and its cadence at default settings (computeGlobals ×3,
  serializeState ×8, screenshot, loadsave). One table, committed.
- **P0.4 Baselines.** `gate.sh` hashes for L5/L6/**L7** (L7 baseline does
  not exist yet — create it), `bench_backend` matrix
  L5/L6/L7 × explicit/implicit, `bench.html` on the owner's GPU.

Acceptance: pass-level ms visible in both benchmarks; L7 gate baseline
exists; baseline logs committed; no behavior change (gates bit-identical).

## Phase 1 — Kill the dead and the stalling (1 d)

Goal: remove pass count and sync points that cost nothing in output.

- **P1.1 Pass audit at defaults** (scheme 0, iceOn 1, co2On 0, rigidLid 0):
  list the passes actually executed per step per level; remove no-op work
  and ensure each feature pass is truly gated (early return, not dead
  uniform math) when its feature is off.
- **P1.2 Readback cadence.** `computeGlobals` at a 1 s simulation cadence
  (hold last value between) instead of per CO₂ tick; the greenhouse write-
  back stays in the same cadence. With co2On 0 (default) verify there is
  **zero** per-frame readback after P1.1. `serializeState` stays on demand.
- **P1.3 Jacobi warm-start check** (scheme 2 only): confirm the warm start
  actually skips settled sweeps; report sweeps/step at convergence.

Acceptance: readbacks/frame ≤ 1 and only at the documented cadence;
L7 passes/step reduced by N (N documented, expected ≥ 1); gate hashes
unchanged, or `--allow-drift` with re-proved stats where cadence changed
float results; L6 ms/frame unchanged within 2%.

## Phase 2 — Adaptive substep budget (0.5 d) — the fast L7 win

Goal: turn "10 fps" into "30–60 fps" today, by spending the frame budget
on substeps instead of a fixed 8.

- **P2.1 "Auto" in Substeps/frame.** UI option that picks the largest
  substep count with `ms/step × n ≤ 16.7`, from a 2 Hz EMA of measured
  ms/step (same pattern as the geotectonics perf strip). Show the chosen
  n and the resulting simulated-days/s.
- **P2.2 `bench.html` auto row.** Per level add an `auto@60` row:
  substeps = `floor(16.7 / ms/step)`, so the table answers "how many
  substeps does this GPU sustain at 60 fps" per level.
- **P2.3 dt honesty.** If auto drops n, the simulated days/frame drops
  with it — the table and UI must show days/s so the trade is visible,
  never hidden.

Acceptance: L7 auto mode ≥ 30 fps at default dt on the owner rig; L6 auto
unchanged (160 fps, n stays at max); gates untouched (UI + bench only).

## Phase 3 — Tracers and flow pools (0.5–1 d)

Goal: budget the draw half (L6 is draw-bound; L7 inherits it).

- **P3.1** New `bench.html` column **tracers ms** (stepSmooth +
  stepVFlow + stepFlow + tracer draw), sampled at 16k and 64k particles
  per level.
- **P3.2** Quality knobs, then measure: trail texture resolution / trail
  length, particle cap that scales with level (L7 default ≤ 32k?), skip
  `stepVFlow` while the camera is static and the flow fields unchanged.
- **P3.3** Pick the default settings that keep L6 tracers ms at or below
  baseline.

Acceptance: tracers ms at L7 reduced ≥ 25% (or the floor documented);
64k@L7 ≤ 2× the 16k@L7 figure; L6 default draw unchanged within 2%;
gates untouched (draw-only paths).

## Phase 4 — Render pass (0.5 d)

Goal: cut the globe/streamline draw itself.

- **P4.1** draw-only sweep per display mode (all `P.mode` values ×
  streamline on/off) in `bench.html` — find which modes cost what.
- **P4.2** dpr cap 1.5 (from 2) at L7; streamline density scaled by level;
  any obvious per-frame uniform/matrix recompute moved to on-change.

Acceptance: draw ms at L7 reduced ≥ 20% (or floor documented); L6 draw
unchanged within 2%; screenshot output visually unchanged for the default
mode (diff-checked by eye, archived).

## Phase 5 — WebGPU port (3–5 d) — the cross-borrow

Goal: the structural fix — replace fullscreen-quad WebGL with WebGPU
compute, borrowing the architecture geotectonics 0.3 already proved on a
coupled grid sim.

- **P5.1** Port the A/B texture group to a WebGPU pipeline: SoA float
  buffers (or textures where neighbor access is cheaper), one command
  encoder per step, per-pass compute dispatches mirroring the WebGL pass
  list exactly (same kernel math, same order → parity is checkable).
- **P5.2** Instrumentation as designed: timestamp query ring (the
  geotectonics 0.3-I1 design, 4-buffer resolve ring, 2 Hz collect) feeding
  the same pass table, so the P0.1 breakdown keeps working.
- **P5.3** No per-frame readback: globals via resolved buffer mapped at
  the Phase 1 cadence. Engine **toggle** in the UI (WebGL default until
  parity passes); `bench.html` gains an engine column.
- **P5.4** Parity harness `harness/parity_webgpu.js`: same seed/params/
  steps in both engines, per-field max-abs-diff + hash on the WebGL
  reference; tolerance documented (bit-identical if the op order is
  preserved, else a fixed ε re-verified at stats level like the geotectonics
  dt 0.01 vs 0.1 long-run).

Acceptance: L7 ms/step (WebGPU) ≤ 0.5× L7 ms/step (WebGL) at the same
substeps; L5/L6 no worse; parity gate green; L6 160 fps floor holds.

## Phase 6 — Smoothness: nothing on the rAF path (1 d)

Goal: hitches, not just throughput — port the geotectonics 0.3-II lesson.

- **P6.1** Audit the rAF loop for anything that awaits or syncs: readbacks,
  `gl.finish`-style stalls, layout/pool rebuilds (rebuildPools on level
  change is fine; in-loop ones are not).
- **P6.2** Move remaining sync work to background cadence (the Phase 1
  pattern); the loop only enqueues.
- **P6.3** `bench.html` smooth mode: record per-rAF frame gaps, report
  median / p95 / max and hitch count (gaps > 2× median) per level.

Acceptance: p95 gap ≤ 2× median at L7 (auto) and L6; hitch count ~0 at
L6 default; throughput numbers from Phases 2–5 unchanged.

## Phase 7 — Polish and docs (0.5 d)

- Update `docs/BENCH.md`: new baselines (backend + owner-GPU visual), pass
  table, engine column, auto@60 semantics, smooth-mode columns.
- Archive phase logs under `harness/logs/`, trim the old baselines that
  the new ones supersede.
- `README.md` performance section: current L5/L6/L7 numbers, what "auto"
  means, the GPU required for the WebGPU engine.

Acceptance: docs match the committed baselines; `gate.sh L5/L6/L7` green
with bit-identical hashes (or documented `--allow-drift` re-provals);
bench numbers reproducible from the commands in the docs.

## Cross-borrow notes

From **planet-geotectonics** (0.3-plan, implemented in that repo 2026-09):
the timestamp-query ring (P5.2), the 2 Hz "report, never allocate in the
frame" perf pattern (P2.1, P5.2), the event-cadence readback discipline
(P1.2, P6.2), and the parity-with-tolerance methodology (P5.4).

From **planet-climate** (implemented in planet-geotectonics the same week):
the standalone `bench.html` GUI — time-boxed median sampling, the 60 fps
highlight, `?fast=1` / `?noauto=1`, auto-run — and the two-benchmark
convention (portable backend bench vs real-GPU visual bench) documented in
`docs/BENCH.md`.
