# planet-climate — engine & performance improvement plan (agent draft)

Written **before** reading `30-performance-plan.md`. All numbers below are either
measured from this tree (shader source counts, grid sizes, BENCH.md baselines) or
marked *inferred*.

## 0. Baseline facts (from this tree)

Grid (geodesics.js): `W = 256` fixed, `H = ceil(V/256)`, `V = 10·4^s + 2`.

| level | cells V | sim texture | px/pass | RGBA32F tex |
|---|---|---|---|---|
| L5 | 10,242 | 256×41 | 10,496 | 0.17 MB |
| L6 | 40,962 | 256×161 | 41,216 | 0.66 MB |
| L7 | 163,842 | 256×641 | 164,096 | 2.62 MB |

Default frame (params.js defaults: `substeps=8`, `oceanScheme=0`, `iceOn=1`,
`co2On=0`, `flowParticles=16k/pool`, `flowLines=1`, `flowSegs=24`, PT=40, 2 pools):

| work | count/frame | scales with level? |
|---|---|---|
| grid-res passes: 8×(ocean+air+cplO+cplA+ice) | 40 | yes, ×4/level |
| SMOOTH_FS ×4 (one per source) + VFLOW_FS ×1 | 5 | yes |
| pool STATE 128² + TRAIL 128×5120, ×2 pools | ~1.34M px | no |
| globe + cloud vertex draws (V verts, 16–21 dependent fetches/vert — 1-ring pre-blend) | 2×V verts | yes, ×4 |
| tracers: 2×16,384×2×(24−1) line verts | ~1.5M verts | no |
| screen fill (canvas × dpr²) | — | no |
| CO₂ (if on): 3× REDUCE single-fragment loop over V + 3× readPixels(1×1) | — | yes + 3 pipeline stalls |

Dependent `texelFetch` count per fragment (source-audited, incl. 6-neighbor loops):
ocean ≈ 50, air ≈ 30, couple ≈ 11 each, ice ≈ 40, vflow ≈ 35 → **≈ 1,100/cell/frame**
at substeps 8** (L7: ≈ 186 M dependent fetches/frame).

Reference points:
- Owner's real-GPU references (BENCH.md): L6 implicit ×128 substeps = 60 fps;
  explicit ≈ 2× implicit; **L7 ≈ 4× slower than L6**.
- **Observed (this report's subject): L6 160 fps, L7 10 fps = 16× for 4× cells.**
- SwiftShader step baselines (BENCH.md): explicit 1.42 / 2.02 / 3.08 ms (L5/L6/L7);
  implicit 3.97 / 5.95 / 18.61 ms.

## 1. Why is L7 so slow? (diagnosis)

The frame is **not** draw-bound at L7 — the 16× vs the expected 4× decomposes as:

- **D1 — ×4 cells.** 45 grid-res passes/frame each cost 4× pixels; globe/cloud
  vertex stage 4× verts. Intrinsic, expected.
- **D2 — ×2–4 per-fragment cost cliff (*inferred*, the main extra factor).** Each
  dynamics pass touches ~9 textures (2 nbr + 3 cell + 4 state). Per-pass working
  set: L6 ≈ 5.9 MB, **L7 ≈ 23.6 MB**. Typical GPU L2 is 1–10 MB, so L6 mostly
  lives in L2 while L7 is DRAM-bandwidth-bound; with ~1,100 dependent fetches per
  cell per frame, the per-fragment cost inflates several-fold. 4× cells × ~3–4×
  per-fragment ≈ the observed 16×.
- **D3 — no pass batching.** 45 separate FBO binds + program switches + uniform
  sets + draws per frame; N substeps pay N× the fixed overhead. Nothing amortizes.
- **D4 — vertex-stage pre-blend at L7.** Globe + cloud VS do a 1-ring blend with
  16–21 dependent `texelFetch` per vertex (≈ 4.4 M dependent fetches at L7, ×2
  draws). Plus the 1.5 M-vertex line draw (level-independent, but it makes the
  draw half of the frame non-trivial).
- **D5 — CO₂ readback pattern (if enabled).** 3 single-fragment reductions that
  each serially loop all 163,842 cells + 3 `readPixels(1×1)` → 3 full
  GPU→CPU pipeline stalls *every frame*, cost ×4 at L7.
- **D6 — implicit scheme (if enabled).** Jacobi iters × 4× pixels; BENCH shows the
  implicit penalty grows with level (×3 at L5/L6, ×6 at L7), so an implicit
  L6→L7 comparison widens the gap further.

**Verification protocol** (to confirm on the owner's GPU with bench.html before
touching code): substeps 1 vs 8 (linear ⇒ sim-bound), flow lines/particles
on-off (draw half), co2 on/off (D5), scheme 0 vs 2 (D6), globe vs equirect (D4).
Each toggle isolates one term; results go to `experiments/` with the device string.

## 2. What we can pick from each other

### planet-climate ← planet-geotectonics
1. **Dual-engine parity architecture** — a CPU JS kernel graph as the reference,
   the GPU engine verified bit-identical (same device) + 1000-frame ensemble
   within declared floors + frame-2 clone test + determinism test. Climate has
   *no CPU reference*: its physics exists only as GLSL, so headless verification
   is slow SwiftShader and there is no cheap oracle.
2. **WebGPU compute + SoA storage buffers** (no textures, no FBO ping-pong, no
   dependent texture fetches) and **one encoder per rAF carrying N substeps**
   (their 0.3-plan Phase III) — directly attacks D2+D3.
3. **Perf strip module** (perf.js): EMA + p95/max frame gap over a 1 s
   preallocated ring, per-kernel ms, event round-trip timings, text rebuilt at
   2 Hz with zero allocation in the frame loop. Climate's HUD shows only fps.
4. **GPU timestamp query sets** for per-kernel GPU ms with feature-detected
   fallback (their Phase I1).
5. **Async one-cycle-late round trips** for anything the CPU mirror needs (their
   Phase II) — the exact fix for climate's D5 readback stalls.
6. **Bounded-kernel discipline** — their `loserRank` O(losers×n) lesson. Climate
   analogues to audit: the O(V)-serial single-fragment REDUCE/MAX loops, fixed
   Jacobi iteration counts.
7. **Persistence**: one validated binary blob + 20 Myr checkpoint ring (climate:
   base64 over 8 full readbacks).
8. **Verification tooling**: `node tests/run-all.js` on Node built-ins only,
   WGSL structural check, long-run release profile, one-factor calibration
   sweeps, committed baseline logs with device string, "SwiftShader = relative
   only" convention (already climate's convention in BENCH.md — formalize).
9. Small: dt range validation (RangeError), sealed params, findings/pitfalls doc.

### planet-geotectonics ← planet-climate
1. **Resolution ladder UX** — L5/L6/L7 live rebuild + seed + presets with
   per-slider bounds overrides (geotectonics grid supports 0–7; UI is L5, L6
   planned in their 0.3-plan V).
2. **Particle tracer flow-viz technology** — persistent tracers, trail
   conveyor, birth/death envelope, vertical-flux sublayer transitions, EMA
   de-noise, mass-consistent recycling. Generic: it would visualize mantle
   plumes and crustal drift.
3. **3D globe + cloud shell + equirect display** incl. the per-vertex 1-ring
   pre-blend trick — a 3D plate view is on the table.
4. **Bench split convention** (backend vs visual, `sub@60fps` column, vsync
   notes) as a template for their I3 in-page bench.
5. **Plain-JS save file** for `file://` (complements the binary blob).
6. **Per-parameter `tip` metadata** in the UI (self-documenting sliders).

## 3. Improvement plan (phased)

### Phase 0 — instrument, then believe the numbers (1–2 d)
- **0.1** per-pass timing in `bench.html`: group {ocean, air, couple, ice,
  smooth, vflow, pools, globe, clouds, tracers, reduce}; `gl.finish()`
  sandwiches (or `EXT_disjoint_timer_query_webgl2` when exposed).
- **0.2** HUD: p95/max frame gap (1 s ring) + per-group ms, 2 Hz rebuild,
  preallocated buffers (port perf.js pattern).
- **0.3** run the §1 verification matrix on owner hardware; commit logs with
  device string. SwiftShader runs stay relative-only.
- **Gate:** per-pass tables for L5/L6/L7 × substeps {1,8} × {flow, co2, scheme}
  reproduce the 160 fps / 10 fps observation.

### Phase 1 — cut the current frame (WebGL2 only; goal: L7 ≤ ~6× L6)
- **1.1 adaptive substeps** — auto-fit n to a 16.7 ms budget (estimate from
  rolling per-pass cost), manual override retained; report "N substeps fit".
- **1.2 smooth ×4 → 1 MRT pass** (4 attachments, one draw) — or fold the EMA
  into the dynamics passes where a free channel exists.
- **1.3 flow-viz cost** — VFLOW only when pools are live; shift only
  `min(PT, drawnSegs+2)` trail slots; default particles 16k→8k; indexed lines
  (K verts + indices) instead of 2(K−1) duplicated line verts.
- **1.4 globe pre-blend gate** — for V > ~80 k skip the VS 1-ring blend (or do
  it once into a texture, fragment-parallel) — targets D4.
- **1.5 CO₂** — single reduce pass (one draw, 4×1 target, merged uWhich),
  **two-level parallel reduction** (tile partial sums → final over ≤ 4 k tiles)
  replacing the O(V)-serial single-fragment loop, and readback **every N frames**
  (N from the CO₂ ODE clock), one pipeline stall instead of three, none per
  substep — targets D5.
- **1.6 implicit** — keep warm-started φ; budget Jacobi iters per level; residual
  early-exit stays harness-only (readback stalls the UI, per existing comment).
- **1.7 draw hygiene** — cache uniform sets, skip no-op viewport/binds, one VAO
  per pass type.
- **Gate:** L7/L6 frame ratio ≤ 6 on owner GPU; L6 implicit ×128 still 60 fps;
  equilibrium re-proven (harness stationary check) for the numerical changes
  (1.2/1.5) with a declared tolerance; hash gate otherwise.

### Phase 2 — WebGPU compute engine (the structural fix; ~1–2 w)
- **2.1 CPU reference graph** — port ocean/air/couple/ice/vflow/reduce to pure-JS
  kernels over SoA `Float32Array`s. Becomes the oracle, the headless test rig,
  and the no-WebGPU fallback.
- **2.2 WGSL twin** — same kernels as compute shaders over storage buffers
  (SoA per field family; 6-neighbor loads by ring index; one workgroup per
  cell or 2×2 tiles). Kills dependent texture fetches and FBO ping-pong (D2).
- **2.3 one encoder per frame** for all N substeps (their Phase III pattern) +
  CO₂ reduction as `atomicAdd` buffer with async `mapAsync` (one cycle late) —
  zero stalls in the frame path (D3, D5).
- **2.4 render bridge** — keep the WebGL2 globe renderer initially; feed it from
  a once-per-frame state texture. Then port the globe to a WebGPU render pass
  reading storage buffers directly (their render-gpu.js pattern, fullscreen
  triangle + lookup) so *nothing* leaves the GPU per frame.
- **2.5 persistence** — validated binary blob v2 (header + SoA fields) + keep the
  8-texture base64 codec for old saves; port mksave.
- **2.6 parity gates** — same-device bit-identical CPU↔GPU (or declared floors),
  frame-2 clone, determinism; structural WGSL check (borrow `wgsl-struct.js`);
  port climate harness tests (co2, ice, loadsave, mobility, dti, gate hash) to
  the CPU graph in `node tests/run-all.js` style (Node built-ins only).
- **Gate:** L7 step time ≈ 4× L6 ± bandwidth (no extra cliff); one submit per
  frame; no per-frame readback; parity + determinism green; SwiftShader numbers
  recorded as relative-only.

### Phase 3 — levels & soak
- **3.1 L8 readiness** — replace the hardcoded `200000`/`700000` loop bounds in
  MAX_FS/REDUCE_FS with `uCount`-driven loops (or the parallel reduction);
  memory budget check (SoA ≈ 40 MB at L7 ×2 sets — fine).
- **3.2 soak** — long stationary-equilibrium run on the new engine vs baseline
  (field-RMS drift gate), the climate analogue of their release profile.
- **3.3** extend the one-factor sweep (air_dt_sweep pattern) to the new engine;
  refresh BENCH.md; commit baselines with device string.

### Phase 4 — UX & docs
- per-kernel strip + p95/max in the UI; "N substeps fit" indicator; level/scheme
  quick buttons; `findings-pitfalls-skills.md` for the new engine; AGENTS.md
  update (feature-detect order, parity commands, save format v2).

## 4. Risks & handling
- **Float reordering shifts the tuned equilibrium** → tolerance gates + soak
  (Phase 3.2); scheme-0 hash baseline stays the arbiter for anything claimed
  "unchanged".
- **WebGPU availability** → feature-detect; CPU graph fallback; WebGL2 renderer
  kept for the CPU path until 2.4 lands.
- **Two engines drifting** → parity in run-all, bit-identity as an acceptance
  criterion per phase (their model: any statistics drift is a plan failure, not
  a tunable).
- **Save compat** → version field; old codec kept.
- **Scope** → Phases 0–1 are days and already buy L7 back to ~6× L6; Phase 2 is
  the structural step.

## 5. Deliberately untouched
Physics tuning, grid construction, seeded RNG, parameter schema (additions only),
the no-build `file://` design, the 8-texture meaning for old saves.
