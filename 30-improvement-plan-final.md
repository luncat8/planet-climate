# planet-climate performance improvement plan — FINAL (best-of)

Supersedes `archive/30-performance-plan.md` (repo draft) and `archive/30-improvement-plan-agent.md`
(agent draft, written independently **before** reading the repo draft).
Each phase below cites `[R]` = repo draft, `[A]` = agent draft, `[B]` = both.

Facts re-verified against the tree for this merge:
- `this.fullscreen(` call sites: 21 (+ the prototype definition; repo says 22).
- Committed gate baselines: `harness/baselines/L5.json`, `L6.json` — **no L7 baseline exists** (repo P0.4 catch confirmed).
- `serializeState` = 9 full-texture `readPixels` (A[0..7] + ice).
- After P1.2/P1.4, `computeGlobals` = 1 `readPixels(4×1)` at the sim-day cadence while `co2On` (zero at default `co2On: 0`); the original 3-per-frame path is retired.
- Per-pass working set (9 textures touched per dynamics pass): L6 ≈ 5.9 MB, L7 ≈ 23.6 MB.
- Dependent `texelFetch` per fragment (source-audited, incl. 6-neighbour loops):
  ocean ≈ 50, air ≈ 30, couple ≈ 11 each, ice ≈ 40, vflow ≈ 35 → ≈ 1,100/cell/frame
  at the default 8 substeps.

## 1. Comparison chart (repo draft vs agent draft)

| # | Topic | Repo draft (`30-performance-plan.md`) | Agent draft (`30-improvement-plan-agent.md`) | Best-of decision |
|---|---|---|---|---|
| 1 | Goal / gates | L7 ≥ 30 fps; **L6 160 fps hard floor, 2 % regression rule**; every phase: before/after numbers + `gate.sh`; bit-identical default, drift ⇒ `--allow-drift` + re-proved stats | L7 within ~4–6× of L6; tolerance gates + equilibrium soak | **Repo**: numeric gates are stronger and enforceable; keep agent's L7/L6-ratio as a sanity check |
| 2 | Root cause of 16× | "physics-bound, not draw-bound" — accepted, not explained | D1–D6 decomposition; **D2 = L2/DRAM cliff** (5.9 → 23.6 MB per-pass working set ⇒ per-fragment cost ×2–4 on top of ×4 cells) | **Agent** analysis is the missing "why"; repo's WebGPU acceptance (≤ 0.5× L7 WebGL) is exactly what D2 predicts — keep both |
| 3 | Instrumentation | P0.1 pass-level `Planet.prototype.trace` in bench.html; P0.2 same in bench_backend; P0.3 readback audit table; P0.4 create missing L7 baseline | Per-pass groups + p95/max HUD; toggle-matrix bisect (substeps 1/8, flow, co2, scheme, view) | **Repo** (direct measurement) + agent's toggle matrix as cross-check + agent's p95/max HUD |
| 4 | Dead/gated passes | P1.1 pass audit at defaults, early-returns when feature off | — | **Repo** (agent had no explicit audit) |
| 5 | CO₂ readback | P1.2: 1 s simulation cadence, hold last value | Every-N-frames cadence **+ single-pass 4×1 reduce + two-level parallel reduction** (tile partials → final over ≤ 4 k tiles) replacing the single-fragment O(V) loop | **Both**: cadence removes 3 stalls/frame; parallel reduction removes the serial 164 k-iteration hitch *per tick* (a hitch P6 would otherwise catch) |
| 6 | Jacobi (scheme 2) | P1.3 verify warm-start actually skips sweeps; report sweeps/step | Budget iterations per level | **Repo first** (measure); budget only if data says so |
| 7 | Adaptive substeps | P2: "Auto" substeps, 2 Hz EMA of ms/step, `auto@60` bench row, days/s always shown | 1.1 same idea | **Identical intent** — take repo's UI/bench details |
| 8 | SMOOTH passes (4/frame) | not addressed | 1.2: merge 4 full-res draws into **1 MRT pass** (4 attachments, legal in WebGL2) | **Agent** (4 draws → 1; repo audit may find more no-ops but not this) |
| 9 | Flow-viz/tracers | P3: tracers-ms column, level-scaled particle cap (L7 ≤ 32 k), skip vflow while paused, pick defaults keeping L6 draw flat | 1.3: vflow gating, shift only `min(PT, drawnSegs+2)` trail slots, **indexed lines** (K verts + indices instead of 2(K−1) duplicated verts), default 16 k→8 k | **Both**: repo's knobs/bench + agent's implementation levers (indexed lines ≈ halves the 1.5 M line-vert draw; slot budgeting cuts the 1.34 M-px trail shift) |
| 10 | Render pass | P4: draw-only sweep over all `P.mode` × streamlines; **dpr cap 1.5 at L7**; streamline density by level; uniform recompute on-change | 1.4: gate globe/cloud **VS 1-ring pre-blend** at V > 80 k (16–21 dependent fetches/vertex × 2 draws × 164 k = D4); 1.7 draw hygiene | **Both** — the two attack different halves (fill/vertices vs dependent fetches) |
| 11 | WebGPU port | P5: SoA buffers, one encoder per step, mirror the WebGL pass list (same math/order → checkable parity), **WebGL engine stays as parity reference + fallback**, UI engine toggle, bench engine column | 2.x: **CPU JS kernel graph as oracle + fallback**, WGSL twin, parity vs CPU | **Repo's parity direction** (vs existing WebGL engine): far less work, headless SwiftShader rig already runs it, WebGL2 stays the no-WebGPU fallback. Demote agent's CPU graph to **Phase 8 stretch** |
| 12 | Per-kernel GPU timing | P5.2: timestamp query ring (4-buffer resolve, 2 Hz) feeding the pass table | query sets, feature-detected | **Repo** design (already feature-detect fallback in geotectonics) |
| 13 | Persistence on the new engine | **gap** — `serializeState` (9 readbacks) and the 8-texture codec are not addressed once state lives in buffers | Binary validated blob v2 + keep base64 codec for old saves + mksave port | **Agent** — required, not optional, once Phase 5 lands |
| 14 | Smoothness (hitches) | P6: rAF audit, background cadence, smooth mode reporting median/p95/max + **hitch count (gap > 2× median)** | p95/max HUD + async one-cycle-late round trips | **Both** (same intent); repo's hitch metric + agent's async pattern |
| 15 | Bench conventions | auto@60 row, tracers column, engine column, smooth columns, BENCH.md refresh | — | **Repo** |
| 16 | L8 / latent bounds | not addressed | MAX_FS bound `200000` (< L8's 655 k; L7 headroom only 22 %), REDUCE `700000` — make `uCount`-driven | **Agent** (small, real latent bug; also flagged in `29_review.txt`) |
| 17 | Soak | rule 2: re-prove stats (meanT/sstMean/ice/CO₂) on any drift phase | long stationary-equilibrium soak (1,500 d) with field-RMS drift gate | **Both**: per-phase re-proof (repo) + one extended soak at the end (agent) |
| 18 | Cross-borrow *from* geotectonics | query ring, 2 Hz non-allocating perf pattern, event-cadence readback, parity-with-tolerance | + p95/max gap ring, async round trips, bounded-kernel audit, checkpoint/blob pattern, WGSL structural test, Node-builtins run-all, findings/pitfalls doc, dt validation | **Union** |
| 19 | Cross-borrow *to* geotectonics | bench.html GUI + two-benchmark convention | + resolution-ladder UX (live L5/L6/L7 rebuild + presets w/ bounds), particle-tracer flow-viz tech (for plumes/crustal drift), 3D globe + pre-blend display tech, plain-JS `file://` save, per-param `tip` metadata | **Union** |
| 20 | Effort | ~8–12 d (WebGPU 3–5 d, no CPU port) | ~1–2 wk (CPU port in core) | **Repo schedule** (Phase 8 is optional) |

Net: the drafts converge on the same spine — **instrument → kill stalls/dead
passes → adaptive substeps → budget the draw half → WebGPU port → smoothness →
docs**. The repo draft is stronger on gates, cadence fixes and the WebGPU
parity strategy; the agent draft is stronger on root-cause (L2 cliff), the
SMOOTH-MRT merge, tracer implementation levers, the VS pre-blend gate, the
CO₂ parallel reduction, the save-format gap and L8 bounds. The final plan below
is the union, in the repo's phase numbering.

## 2. Final plan

**Rules (every phase)** `[B]`
1. Ends with before/after numbers from both benchmarks vs the previous phase's
   committed baseline + `harness/gate.sh <tag>` (L5/L6/L7).
2. Bit-identical by default; float-order/cadence changes ⇒ `--allow-drift` **and**
   re-proved stats (meanT / sstMean / ice area / CO₂ over the gate run).
3. **L6 160 fps is a hard floor** — > 2 % L6 cost is reverted or compensated.
4. Baselines are files: `harness/logs/climate-<phase>-<bench>-<hw>.txt`
   (backend = SwiftShader-relative; visual must name the GPU).
5. Every reported number carries its device string; SwiftShader is relative-only.

### Progress checkpoint and revised entry gate (2026-09-12)

P0–P4 implementation work is recorded in `docs/BENCH.md`; P4 has the screenshot
correctness gate described there. Its **owner-GPU wall-clock acceptance is still
open**. The two newly archived visual captures are useful history, but not a
valid before/after performance comparison:

| config | `9755c73` (prior capture) | `6b92890` (P4) | nominal change |
|---|---:|---:|---:|
| L5 explicit ×128 | 3.60 ms | 3.90 ms | +8.3% |
| L6 explicit ×128 | 16.60 ms | 18.00 ms | +8.4% |
| L7 explicit ×128 | 37.00 ms | 38.60 ms | +4.3% |
| L5 implicit ×128 | 15.60 ms | 14.80 ms | −5.1% |
| L6 implicit ×128 | 41.70 ms | 41.30 ms | −1.0% |
| L7 implicit ×128 | 244.70 ms | 248.90 ms | +1.7% |

Both files lack a GPU/device header, report 0.00 ms draw cost, and have 0.10 ms
low-work rows. Those are the documented headless SwiftShader submission-time
signature, not render execution timing. More importantly, the pre-fix benchmark
constructed `Planet` with its normal live rAF loop, while also advancing and
timing manual frames; that loop could submit extra frames between samples. Thus
neither the apparent L6 +8.4% nor the other small deltas is evidence of a P4
regression or gain, and the files stay in `archive/` as historical raw logs only.

**P0.7 / P4.4 — benchmark evidence repair (completed in code; owner run pending).**
`Planet` now supports `autoStart:false`; `bench.html` uses it, so its manual
`frame()` is the only frame submitted during sampling. Successful runs expose a
sticky `done` / `copy to clipboard` control. Its TSV includes the input values,
UTC completion time, WebGL renderer/vendor, DPR, browser, and every result table.
The smoke test asserts both the isolated run and copied payload. `setup_chrome.sh`
also exports `CHROME_DIR`, so the documented local smoke setup works.

**Next required evidence before Phase 5:** run the repaired visual benchmark on
the owner GPU at L5/L6/L7 with the normal `10,128` substep matrix (and the P4
mode × streamline sweep), repeat it three times, and archive each copied TSV
under `harness/logs/` with the exact renderer header. Use the median of the three
for the L6 160 fps floor and the P2/P3/P4 targets. This becomes the WebGL parity
and performance baseline for P5. Do not manufacture a visual baseline from the
two old logs.

Phase 5 remains the next implementation phase after that evidence gate; it is
not complete, and neither are P6/P7, so this active plan must **not** move to
`archive/`. P6's rAF hygiene can be applied during the P5 integration, but its
smoothness acceptance must be measured against the repaired visual baseline.

### Phase 0 — Instrument & baseline (0.5–1 d) `[R]`+`[A]`
- **P0.1** `[R]` Pass-level timing in `bench.html` via a `Planet.prototype.trace`
  toggle (ocean / air / cplO / cplA / proj / ice / smooth / vflow / flow / draw),
  time-boxed median like the existing rows.
- **P0.2** `[R]` Same breakdown in `bench_backend.js` (portable, sandbox-usable).
- **P0.3** `[R]` Readback audit table: `computeGlobals` ×3 (per frame when
  co2On), `serializeState` ×9 (on demand), screenshot, loadsave. Committed.
- **P0.4** `[R]` Baselines: `gate.sh` L5/L6/**L7 (new)**; backend matrix
  L5/L6/L7 × explicit/implicit; visual on the owner GPU.
- **P0.5** `[A]` Cross-check toggle matrix on owner hardware: substeps 1 vs 8,
  flow on/off, co2 on/off, scheme 0 vs 2, globe vs equirect.
- **P0.6** `[A]` Record the root-cause hypothesis to test with P0.1 data:
  per-pass **ms/cell** should jump ~2–4× from L6→L7 (L2 working-set cliff:
  5.9 → 23.6 MB per pass) on top of the ×4 cell count — i.e. the 16×.
- **Acceptance** `[B]`: pass ms visible in both benches; L7 gate baseline exists;
  baselines committed; gates bit-identical; ms/cell table localizes the extra
  factor (validates or revises P0.6).

### Phase 1 — Kill the dead and the stalling (1 d) `[R]`+`[A]`
- **P1.1** `[R]` Pass audit at defaults (scheme 0, iceOn 1, co2On 0, rigidLid 0):
  executed passes per step; features must early-return, not run dead uniform math.
- **P1.2** `[R]` `computeGlobals` at a 1 s simulation cadence (hold last value);
  zero per-frame readback at defaults (co2On 0).
- **P1.3** `[R]` Jacobi warm-start check (scheme 2): report sweeps/step at
  convergence; budget iterations only if the data demands it.
- **P1.4** `[A]` CO₂ reduction rework: single reduce pass (one draw, 4×1 target,
  merged uWhich) + **two-level parallel reduction** (tile partials → final over
  ≤ 4 k tiles) replacing the single-fragment O(V) loop; loop bounds in
  MAX_FS/REDUCE_FS become `uCount`-driven (L8 safety).
- **P1.5** `[A]` SMOOTH ×4 → **1 MRT pass** (4 attachments).
- **Acceptance** `[R]`+`[A]`: readbacks/frame ≤ 1 at documented cadence;
  passes/step reduced (documented N); reduce cost < 1 ms at L7; gate hashes
  unchanged or `--allow-drift` with re-proved stats (P1.4/P1.5 change float
  order); L6 ms/frame within 2 %.

### Phase 2 — Adaptive substep budget (0.5 d) `[R]`
- **P2.1** "Auto" substeps: largest n with `ms/step × n ≤ 16.7` from a 2 Hz EMA
  of measured ms/step; show chosen n and simulated days/s (never hide the trade).
- **P2.2** `bench.html` `auto@60` row per level.
- **P2.3** days/s honesty in table + UI.
- **Acceptance**: L7 auto ≥ 30 fps at default dt on the owner rig; L6 auto
  unchanged (160 fps, n at max); gates untouched.

### Phase 3 — Tracers & flow pools (0.5–1 d) `[R]`+`[A]`
- **P3.1** `[R]` `bench.html` **tracers ms** column (smooth + vflow + flow +
  tracer draw) at 16 k and 64 k particles per level.
- **P3.2** `[R]` Quality knobs + measure: trail texture res/length, particle cap
  scaling with level, skip `stepVFlow` while paused/fields unchanged.
- **P3.3** `[A]` Implementation levers: **indexed line draw** (K verts + indices
  instead of 2(K−1) duplicated verts per particle) and trail shift limited to
  `min(PT, drawnSegs + 2)` slots.
- **P3.4** `[R]` Default selection keeps L6 tracers ms ≤ baseline.
- **Acceptance**: L7 tracers ms ≥ 25 % reduced (or floor documented);
  64 k@L7 ≤ 2× 16 k@L7; L6 default draw within 2 %; gates untouched.

### Phase 4 — Render pass (0.5 d) `[R]`+`[A]`
- **P4.1** `[R]` draw-only sweep: all `P.mode` values × streamlines on/off.
- **P4.2** `[R]` dpr cap 1.5 at L7; streamline density scaled by level;
  per-frame uniform/matrix recompute moved to on-change.
- **P4.3** `[A]` Globe/cloud **VS 1-ring pre-blend gate**: for V > 80 k either
  skip it or do it once into a texture (fragment-parallel); re-run P4.1.
- **Acceptance**: L7 draw ms ≥ 20 % reduced (or floor documented); L6 draw
  within 2 %; default-mode screenshot visually unchanged (diff-checked, archived).

### Phase 5 — WebGPU port (3–5 d) `[R]`+`[A]`
- **P5.1** `[R]` Port the A/B group to WebGPU compute: SoA float buffers (or
  textures where neighbour access is cheaper), **one command encoder per step**,
  dispatches mirroring the WebGL pass list exactly (same math, same order →
  parity checkable). Layout goal `[A]`: per-dispatch working set small enough to
  stay in L1/L2 — this is the direct fix for the P0.6 L2 cliff.
- **P5.2** `[R]` Timestamp query ring (4-buffer resolve, 2 Hz) feeding the same
  pass table.
- **P5.3** `[R]` No per-frame readback (globals at the Phase 1 cadence); engine
  **toggle** in UI (WebGL default until parity passes); `bench.html` engine column.
- **P5.4** `[R]` Parity harness `harness/parity_webgpu.js`: same seed/params/
  steps in both engines, per-field max-abs-diff + hash against the **WebGL
  reference**; tolerance documented (bit-identical if op order preserved, else
  fixed ε re-verified at stats level).
- **P5.5** `[A]` Persistence on the GPU engine: validated binary blob v2
  (buffer export via `mapAsync`); keep the 8-texture base64 codec for old saves;
  port `mksave`.
- **P5.6** `[A]` Memory/layout audit: confirm per-cell ms no longer inflates at
  L7 (query ring), SoA memory budget at L7 (~40 MB × 2 sets — fine).
- **Acceptance** `[R]`+`[A]`: L7 ms/step (WebGPU) ≤ 0.5× L7 ms/step (WebGL) at
  same substeps; L5/L6 no worse; parity gate green; no per-frame readback;
  L6 160 fps floor holds.

### Phase 6 — Smoothness: nothing on the rAF path (1 d) `[R]`+`[A]`
- **P6.1** `[R]` Audit the rAF loop for awaits/syncs (readbacks, stalls,
  in-loop rebuilds).
- **P6.2** `[R]`+`[A]` Remaining sync work moves to background cadence
  (one-cycle-late application; the loop only enqueues).
- **P6.3** `[R]` `bench.html` smooth mode: per-rAF frame gaps → median / p95 /
  max + **hitch count** (gaps > 2× median) per level.
- **Acceptance** `[R]`: p95 ≤ 2× median at L7 (auto) and L6; hitch count ~0 at
  L6 default; throughput from Phases 2–5 unchanged.

### Phase 7 — Polish, docs, soak (0.5 d) `[R]`+`[A]`
- `[R]` `docs/BENCH.md`: new baselines, pass table, engine column, auto@60
  semantics, smooth columns; archive phase logs; README performance section
  (current L5/L6/L7 numbers, what "auto" means, GPU needed for WebGPU).
- `[A]` **Equilibrium soak**: 1,500-day stationary run on the final defaults vs
  baseline (field-RMS drift gate) — the long tail of rule 2.
- **Acceptance**: docs match committed baselines; `gate.sh L5/L6/L7` green
  (bit-identical or documented `--allow-drift` re-approvals); numbers
  reproducible from the commands in the docs.

### Phase 8 — Stretch (optional, later) `[A]`
- **P8.1** CPU JS kernel graph (SoA `Float32Array`s) as oracle + no-WebGPU
  fallback; port harness tests (co2, ice, loadsave, mobility, dti) to a
  `node tests/run-all.js` style rig on Node built-ins; parity then runs
  CPU↔WebGPU directly.
- **P8.2** L8 support (bounds already fixed in P1.4; memory budget; auto
  substeps carry it).
- **P8.3** findings/pitfalls doc for the new engine; dt range validation;
  sealed params.

## 3. Cross-borrow (union, both directions)

**planet-climate ← planet-geotectonics**
1. Timestamp query ring, feature-detected (P5.2).
2. 2 Hz "report, never allocate in the frame" perf pattern (P2.1, P5.2, P0.1 HUD).
3. Event-cadence readback discipline + async one-cycle-late round trips (P1.2, P5.3, P6.2).
4. Parity-with-tolerance methodology; bit-identity as an acceptance criterion, statistics drift = plan failure (P5.4).
5. Bounded-kernel audit (their `loserRank` lesson → climate's serial O(V) reductions, fixed Jacobi counts) (P1.3, P1.4).
6. Checkpoint ring + validated single-blob persistence pattern (P5.5).
7. Test discipline: Node-builtins run-all, structural WGSL check, long-run soak, one-factor sweeps, committed baseline logs with device strings (Phase 7, P8.1).
8. Small: dt validation, sealed params, findings/pitfalls doc (P8.3).

**planet-geotectonics ← planet-climate**
1. Standalone `bench.html` GUI: time-boxed medians, 60 fps highlight, `?fast=1` /
   `?noauto=1`, auto-run; and the two-benchmark convention (portable backend vs
   real-GPU visual).
2. Resolution-ladder UX: live L5/L6/L7 rebuild + seed + presets with per-slider
   bounds overrides (their grid supports 0–7; UI is L5 today).
3. Particle-tracer flow-viz technology (persistent tracers, trail conveyor,
   birth/death envelope, vertical-flux sublayer transitions, EMA de-noise,
   mass-consistent recycling) — port it to mantle plumes and crustal drift.
4. 3D globe + cloud shell + equirect display, incl. the per-vertex 1-ring
   pre-blend trick — a 3D plate view.
5. Plain-JS save file for `file://` (complements their binary blob).
6. Per-parameter `tip` metadata (self-documenting sliders).

## 4. Risks & handling (union)

| Risk | Handling |
|---|---|
| Float reordering shifts the tuned equilibrium | Rule 2 (re-proof stats per phase) + Phase 7 soak; scheme-0 hash baseline stays the arbiter for "unchanged" claims |
| WebGPU availability | UI engine toggle; WebGL stays the reference + fallback until P5 parity passes |
| Two engines drifting | Parity harness in every Phase 5+ gate; bit-identity as acceptance criterion |
| Save compatibility | Blob v2 with version header; old 8-texture base64 codec kept (P5.5) |
| L6 regression during work | 2 % hard floor (rule 3), per-phase bench before merge |
| P0.6 hypothesis wrong (L7 16× not cache-cliff) | P0.6 is framed as a hypothesis; the ms/cell table decides; the WebGPU port (P5) is the fix under either diagnosis, P1–P4 scale accordingly |
| Scope creep | Phase 8 explicitly optional; Phases 0–4 are days and already buy ≥ 30 fps at L7 via auto substeps alone |
