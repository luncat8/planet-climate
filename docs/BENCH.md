# Benchmarks

Two complementary benchmarks measure the two halves of the per-frame cost:

| Benchmark | Measures | Where it runs | Tool |
|---|---|---|---|
| **Backend** | calc engine only — one `step()` of ocean + air dynamics, no drawing | headless / sandbox (SwiftShader OK) | `harness/bench_backend.js` |
| **Visual** | whole system — `substeps × step()` + flow-viz passes + globe/streamline draw | a real GPU browser (open the file) | `planet/bench.html` |

A GUI frame runs `substeps` calc-engine steps, then the flow-viz update, then one
draw. The backend tool isolates the first part (portable, CPU-friendly); the
visual tool times the entire frame the way the user actually sees it.

Every reported number carries its device string; SwiftShader (software GL) numbers
are **relative-only** — scaling ratios, pass shares, and the ns/cell ladder are
the portable results.

---

## Backend (physics) — `harness/bench_backend.js`

```
cd harness
./setup_chrome.sh                  # once: installs deps without a CDN download, inflates Chromium
node bench_backend.js              # default matrix: L5,L6,L7 × explicit,implicit
node bench_backend.js --levels=5,6 # subset
node bench_backend.js --flow=0     # skip flow-viz passes
node bench_backend.js --kscale=2   # 2x batch sizes (tighter confidence)
```

**What it does.** Builds the planet at each level (loads the bundled L5
equilibrium where the grid matches; a fresh init elsewhere — representative for
timing), sets the ocean integrator, then measures with **forced differencing**:
run K repeats of the unit, force completion with a 1px `readPixels` of that
unit's OWN output target (FBO rebound every measurement), and difference two
batch sizes — `per-unit = (T(K2) − T(K1)) / (K2 − K1)`, min of 2 reps — so the
forcing readback and any fixed overhead cancel. Batch sizes shrink with level
(L5: 10/30, L6: 4/12, L7: 2/6) to hold each measurement near ~0.1–2.5 s.

**Why not `gl.finish()`?** On SwiftShader-Vulkan, GL execution is fully
asynchronous and `finish()` does **not** block for it: submit+finish measures
only command submission (~0.03 ms/step, identical at every level — physically
impossible, pure vapor). Only a `readPixels` of a texture the measured work
wrote forces true completion (verified: 1px read == full-texture read, and the
state hash evolves). See [Driver artifacts](#driver-artifacts-swiftshader-vulkan)
for the full story, including the two ways naive batching permanently degrades
the context.

**Reported columns**

- `ms/step` — wall time of one ocean+air step, execution-inclusive.
- `steps/s` — `1000 / ms`.
- `sub@60fps` — how many substeps/frame fit a 60 fps (16.67 ms) budget if the
  frame were *physics only*. The max “Substeps / frame” the calc engine alone
  can sustain at 60 fps (on this device).
- `days/s` — simulated days per wall second at 60 fps with autoN substeps.
- `ns/cell` — ms/step normalized by cell count (P0.6 ladder: flat = perfect
  scaling; a jump = per-fragment cliff).
- `closure` — sum-of-passes ÷ whole-step. Must be ~1.0 (validity band
  0.8–1.25); outside it the run is flagged as suspect. Lone-pass batches read
  fixed input (hotter cache), so expect ~0.9–1.0, not exactly 1.
- Pass/flow tables — per-pass ms, same differenced method.
- Jacobi lines (implicit) — early-exit iterations + residual history with the
  harness-only `trackResidual` probe (the UI uses fixed iterations).

**⚠ Absolute numbers are CPU-relative.** The sandbox has no GPU, so WebGL runs on
SwiftShader (software). The *relative* scaling is the portable result; use the
visual benchmark on real hardware for absolute fps.

### Baseline (P0, 2026-09-11 — committed as `harness/bench-swvk.json`)

Device: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`

```
level scheme        cells   ms/step  steps/s  sub@60fps  autoN  ns/cell  closure
---------------------------------------------------------------------------------
L5    explicit      10242     10.81     92.5       1.54      1   1055.5    0.946
L5    implicit      10242     26.96     37.1       0.62      1   2632.3    0.945
L6    explicit      40962     46.65     21.4       0.36      1   1138.9    0.882
L6    implicit      40962  103.0625      9.7       0.16      1   2516.1    1.051
L7    explicit     163842    198.25        5       0.08      1   1210.0    0.951
L7    implicit     163842   427.125      2.3       0.04      1   2606.9    0.942

Pass breakdown (ms per pass):
                ocean      air     cplO     cplA      ice      sum
L5 explicit     3.345    3.410    0.860    0.755    1.860   10.230
L5 implicit    17.765    4.160    0.865    0.715    1.985   25.490
L6 explicit    13.725   13.788    3.213    2.938    7.463   41.125
L6 implicit    76.300   18.363    3.213    2.850    7.588  108.313
L7 explicit    63.575   64.625   12.925   12.200   35.250  188.575
L7 implicit   285.050   59.475   13.525   12.025   32.350  402.425

Flow-viz passes (ms per call, once per frame — not per substep):
               smooth    vflow     flow      sum
L5 explicit     0.615    1.630   21.510   23.755
L6 explicit     1.600    6.600   20.838   29.037
L7 explicit     5.975   28.275   22.200   56.450

Jacobi convergence (implicit, harness early-exit ≤1e-6):
  L5: iters/step=6  residual=[1.1e-3 … 3.4e-7]
  L6: iters/step=6  residual=[2.3e-3 … 7.5e-7]
  L7: iters/step=7  residual=[5.6e-3 … 3.3e-7]
```

Repeat check (L6, 2× batches): explicit 45.51 (−2.4%), implicit 100.54 (−2.4%),
closures 0.91/0.98 — the method repeats to ±2.5%.

Takeaways that carry to real hardware:

- **Implicit costs a flat ~2.2–2.5×/step vs explicit at every level** (not the
  ~3–6× growing penalty the old vapor-based table suggested). The gap is the
  fixed-iteration Jacobi solve — and only **6–7 iterations reach 1e-6**, so the
  fixed iteration budget is the P1.3 opportunity (implicit ocean 17.8 ms → ~3 ms
  at L5 if the iteration count follows convergence).
- **Level scaling is clean ~4.3×/level**, i.e. cell-proportional: 10.81 →
  46.65 → 198.25 ms explicit. The ns/cell ladder is flat (1055 → 1139 → 1210
  explicit; 2632 → 2516 → 2607 implicit), which **revises P0.6: no L2
  working-set cliff on this driver** — the L6→L7 step cost is 4.25× for 4× the
  cells (the residual +6%/level is mild cache pressure, not a cliff).
- **Pass shares (explicit)** are level-stable: ocean ~31%, air ~32%, cplO ~8%,
  cplA ~7%, **ice ~17%** — the cryosphere pass costs more than both couplers
  combined and is the cheapest per-ms target after the dynamics pair.
- **Flow-viz `flow` ≈ 21 ms/call at every level** — particle-count-bound, not
  grid-bound (exceeds a whole L5 physics step; but it runs once per frame, not
  per substep). `smooth`/`vflow` scale with the grid (~4×/level).
- On SwiftShader-CPU, physics alone allows ~1.5 substeps/frame at L5 explicit —
  this is the CPU-relative truth, not a GPU prediction (real GPUs run this
  workload ~100× faster; the owner reference is L6 implicit ×128 @ 60 fps).

### Driver artifacts (SwiftShader-Vulkan) — read before trusting a number

Three driver behaviors, each verified by controlled probe, make naive GL timing
here measure vapor or permanently damage the context. The committed bench
protocol avoids all three; this section exists so nobody re-discovers them.

1. **`gl.finish()` doesn't block; execution is fully async.** Submit+finish of
   any batch measures ~0.03 ms/step at every level (L7's 16× pixels cost the
   same as L5's — impossible). Only `readPixels` of a written texture forces
   completion: 30 L5 steps + full readback = 358 ms (~12 ms/step, hashes
   evolve); timer queries (`EXT_disjoint_timer_query_webgl2`) exist but return
   0 — dead instrument on this driver.
2. **The ~300-finish backpressure cliff.** Step+finish per step is fast for
   ~300 iterations, then every iteration costs ~12 ms (the true L5 execution
   rate) permanently per context: the renderer outruns the async workers until
   the queue saturates, then each submit blocks on drain. The stall lands in
   whatever timer is active (or outside all), which is why per-pass
   finish-bracketed traces show a wandering "absorber" pass and sums ≪ total.
3. **The ~10M cell-pass queue collapse.** One batch + one finish is safe only
   while the queued work stays small (L5: fine ≤300 steps, 10× slow at 1000,
   275× at 3000 — and the context stays degraded afterwards). Batches here are
   sized to stay ~100× under it.
4. **The stale-FBO trap (probe bug, not driver bug).** `readPixels` reads the
   *currently bound* framebuffer. Forgetting to rebind your own FBO after the
   engine ran silently reads the engine's leftover binding — the numbers look
   plausible and are meaningless. The bench rebinds + attaches before every
   forcing read.

Consequences: the backend bench uses forced differencing (above); the engine's
`traceStart/traceStop` (finish-per-pass) is kept for quick diagnosis **on real
GPUs only**, where `finish()` blocks properly; `harness.js` gate `ms` covers
submit+finish only (submission cost, not execution — the gate's purpose is the
hash, which comes from post-timer readbacks and is exact).

---

## Visual (draw) — `planet/bench.html`

**Open `planet/bench.html` in a normal browser** (Chrome/Firefox/Safari) on the
machine whose GPU you want to measure. It auto-runs on load; edit the fields and
press **Run** to re-run. **Real GPU only** — under headless SwiftShader,
`finish()` doesn't block (see above), so the page would report submission cost
(≈10 000 fps vapor), not GPU time. For headless numbers use the backend bench.

The benchmark constructs `Planet` with `autoStart:false`: it owns all simulated
frames and its explicit `frame()` is the only work submitted while a sample is
timed. The normal app keeps its rAF loop; this prevents a second, interactive
rAF loop from advancing the benchmark state or submitting unmeasured work between
samples.

After a successful run, the sticky top bar reads **done** and offers **copy to
clipboard**. The copied TSV has every displayed table plus UTC completion time,
WebGL renderer/vendor, DPR, browser, and input settings. Save that complete
text as the visual log: it is the device evidence required for performance
claims and makes a SwiftShader result unambiguous.

**When a run ends the page stops all simulation work.** The benchmark planet
is disposed and the GL context is dropped, so the GPU process cannot keep
burning CPU on queued frames — on software renderers `gl.finish()` doesn't
block, so an unfinished teardown would leave a deep command backlog draining
long after "done" (the canvas goes blank on purpose). **Run benchmark** swaps
in a fresh canvas/context and measures again; the copied report keeps the
device strings captured at the start of the run. If the renderer string
matches a software implementation (SwiftShader/llvmpipe/…), the status line
and the copied payload carry a `WARNING: SOFTWARE RENDERER` line, so a
headless capture can never be mistaken for GPU wall-clock evidence.

- **Levels** / **Substeps** / **Particles(k)** — the matrix to sweep.
- For every `level × scheme × substeps` it times the full frame
  (`substeps × step()` + `stepSmooth`+`stepVFlow`+`stepFlow` + `render`) with a
  `gl.finish()` per frame, plus a per-level **draw-only** figure (globe +
  tracers, no stepping).
- **Per-pass breakdown table** (P0.1): each level at explicit × first-substeps,
  split by pass via `Planet.trace` (median of 5 time-boxed rounds). `draw` is
  the draw-only measurement (the draw path doesn't go through the traced
  helper). Pass timers serialize with `finish()`, so the sum slightly overstates
  a real overlapped frame.

**Columns**

- `frame ms` — full-frame work time. **Under ~16.7 ms ⇒ sustains 60 fps** (those
  rows are highlighted).
- `draw ms` — draw cost alone (isolates the rendering half from the physics).
- `max fps` — `1000 / frame ms`, compute-limited. On a vsync display the GUI
  still caps at the refresh rate (usually 60).

Sampling is time-boxed (~1.2 s/config, capped at 90 frames) so cheap configs get
a stable median while a very heavy one (e.g. L7 ×128 implicit) still returns in
bounded time. A `?fast=1` URL flag shrinks the sample counts for a quick pass on
slow/software renderers; `?noauto=1` suppresses the auto-run (used by the smoke
test).

#### Historical visual logs

`archive/30-00-log-9755c73.txt`, `archive/30-01-log-6b92890.txt`, and
`archive/30-02-log-69292b4-bench.html.txt` are retained as historical
captures only — **none is GPU wall-clock evidence**, and none may be used to
accept or reject any phase.

- `30-00` / `30-01` pre-date benchmark isolation and omit a renderer string;
  in addition, the old page's live rAF loop could submit frames between timed
  samples.
- `30-02` comes from the repaired page (autoStart isolation, tracers column,
  draw sweep, auto@60 rows are all present) but still carries the
  SwiftShader submission-time signature, and it was NOT saved via the
  done/copy control: it has no `# renderer:` header (rule 5 violation — every
  reported number must carry a device string).
- Shared signature of all three: **draw = 0.00 ms in every row**, tracers =
  0.00 (30-02), the whole draw sweep = 0.00 (30-02), and 0.10 ms / 10 000-fps
  low-work rows — physically impossible on a real GPU; this is command
  submission cost while `gl.finish()` runs async (see driver artifacts). The
  larger frame-ms rows (e.g. L7 implicit ×128 ≈ 241–249 ms) are the
  documented ~300-finish backpressure cliff where submits start blocking on
  queue drain — submission regime mixing, not execution timing.
- Cross-capture stability (explicit ×128 frame ms):
  L5 3.60/3.90/3.80, L6 16.60/18.00/17.10, L7 37.00/38.60/36.70 across
  `9755c73` → `6b92890` → `69292b4`. All three sit within ±8% of each other
  across commits that include the whole P0–P4 change set — consistent with
  one headless submission regime, i.e. these logs cannot distinguish code
  changes and must not be read as a performance trend.
- 30-02's per-pass table (ocean 0.035–0.436 ms, draw 0.000) is the same
  regime: finish-per-pass traces measure submission on software GL — kept for
  structure only, exactly as the `traceStart/traceStop` real-GPU-only note
  warns.

The repaired page now flags software renderers itself (status line +
`# WARNING: SOFTWARE RENDERER` in the copied payload), so a fourth headless
capture is self-identifying. The Phase-5 evidence gate still stands: run the
matrix on a real GPU, three repeats, archive the copied (header-bearing,
warning-free) TSVs under `harness/logs/`.

### Reference GUI performance (real GPU, from the project owner)

These are the targets the visual benchmark should reproduce on comparable
hardware:

- calc engine **Implicit ×128 substeps @ L6 = 60 fps**
- calc engine **Implicit ×10 substeps @ L6 = 60 fps**
- **explicit ≈ 2× faster** than implicit
- **L7 ≈ 4× slower** than L6

(That both ×10 and ×128 hit 60 fps at L6 means the per-frame budget there is
draw-bound, not step-bound — the extra 118 substeps still fit under 16.7 ms. The
backend table above is the tool to confirm where that stops being true.)

### Owner cross-check (P0.5, on real hardware — not runnable in the sandbox)

Substeps 1 vs 8, flow on/off, co2 on/off, scheme 0 vs 2, globe vs equirect —
each as a visual-bench row pair. Expected from the backend table: scheme 0 vs 2
≈ 2.2–2.5× on the physics portion; flow-off removes the ~level-independent flow
cost; co2-on adds one `computeGlobals` per frame (see audit below).

---

## Readback audit (P0.3) — every GPU→CPU sync in the engine

`Planet.readbackCount` cumulatively counts `readPixels` calls (audit + cadence
checks). Costs are SwiftShader-relative (self-forcing calls, so TRUE cost on
this device; portable as ratios).

| Call site (`planet/engine.js`) | Readbacks | Size each | Cadence | Cost (L5 / L6 here) |
|---|---|---|---|---|
| `computeGlobals` (two-level reduction: tile partials + `reduce4` FBO) | ×1 | 64 B (4 px) | **per sim day while `co2On`** (`loop()` → `stepCO2`); never at defaults (`co2On: 0`) | **0.8 / 2.7 ms** (L5/L6; L7 9.7 ms) — one full-pipeline drain after parallel tile reduction |
| `serializeState` → `readTex` ×9 (A[0..7] + ice) | ×9 | W×H RGBA32F (L5: 164 KB; L7: 2.6 MB) | on demand only (save / mksave / harness) | 4.8 / 11.5 ms for all 9 |
| `_maxResidual` (1px: `maxRes` FBO) | ×1 | 16 B | per Jacobi iteration **only when `trackResidual`** (harness scheme-2 validation; off in UI) | negligible; ~60/step in the gate's scheme-2 runs |
| `screenshot.js` (`canvas.toDataURL`) | 0 (compositor) | PNG | user action | — |
| `harness.js` gate (`read` ×8 + cells) | ×10+ | W×H RGBA32F | per gate run, after the timer (correctness, not perf) | untimed; forces full execution |

Notes:

- At defaults (`co2On: 0`, fixed Jacobi iterations) the frame loop performs
  **zero** readbacks. With the carbon cycle on, P1.2 holds globals between
  sim-day refreshes and P1.4 performs one 4-pixel readback per refresh, rather
  than three full-pipeline drains every frame.
- `serializeState` packs ice into A[3].zw (free channels the dynamics
  overwrite), so saves stay 8 textures + 1 ice read; the JS pack loop is
  included in the cost above.
- Gate `ms`/`msPerStep` in `harness/baselines*/L*.json` cover submit+finish
  only (see driver artifacts); they are **not** execution timings. Backend
  perf baselines live in `harness/bench-swvk.json`.

---

## Optimization log — Phase 1 (kill the dead and the stalling)

### P1.1 pass audit at defaults (scheme 0, iceOn 1, co2On 0, rigidLid 0)

Executed passes per `step()`: ocean, air, cplO, cplA, ice = **5 draws** (the
bench breakdown confirms all five do real work; shares 31/32/8/7/17%).
Feature guards verified — every optional pass early-outs before any GL work:

| Feature | Guard | Location |
|---|---|---|
| `projectBarotropic` | `P.rigidLid > 0.5` | `step()` |
| `stepIce` | `P.iceOn > 0.5` | `step()` |
| `stepOceanB` (Jacobi) | `oceanScheme === 2` | `step()` |
| `stepCO2` (+ `computeGlobals`) | `P.co2On > 0.5` | `loop()` |
| `stepVFlow` while paused | `!vflowInit` (once) | `loop()` |

No dead passes found; feature uniforms (ice/noise/etc.) feed coherent uniform
branches, not dead draws. Draws/frame at subs=8, scheme 0: 5×8 + smooth 4→**1**
(P1.5) + vflow 1 + flow 4 + render = **46 + render (was 49)**; scheme 2:
19→**17 draws/step** (P1.3).

### P1.2 `computeGlobals` at sim-day cadence

`stepCO2` refreshes the GPU reduction only when `simTime` advances
`P.globalsEvery` (default 86400 = 1 sim-day; the plan's literal "1 s" is
sub-step at dt=60 and would be a no-op — the intent, kill the per-frame stall
with a held value, is preserved) and holds `this.globals` between refreshes.
The ODE still advances every frame (its clock jumps geo-centuries/frame, so a
day-stale climate input is exact to ~1e-6). Sim-time-based, so co2On runs stay
deterministic; `reset()`/`applyState()` invalidate the cache. Verified:
1 readback on first call, 0 on held calls, refresh at exactly the 86400
boundary (a falsy-`0` bug in the first version — `lastGlobalsT || -1e30` at
simTime 0 — was caught by this probe and fixed).
Effect with co2On: 3 readbacks/frame → **1 readback per ~180 frames**
(at dt=60/subs=8). At defaults (co2On 0): never called, zero change.

### P1.3 Jacobi budget 12 → 10

Convergence data over full transient-inclusive runs (500 L5 + 200 L6 steps from
reset, harness early-exit ≤1e-6): max 6 (L5) / 7 (L6/L7) iterations, mean
5.9/6.4, rate ×0.2/iter — rock-stable. Budget 10 keeps 43% headroom over the
observed max and tolerates 2.5× rate degradation before missing 1e-6; high-dt
users keep the exposed tunable (max 40). The gate's scheme-2 runs exit before
10, so s2 hashes are unchanged (verified: identical).
Back-to-back effect (same box): implicit ocean −15.7% L5 / −16.1% L6 (≈ −2/12
as predicted), implicit step −15% / −10% / −5% (L5/L6/L7; batch-noise widens at
small K).

### P1.4 two-level parallel reduction

`computeGlobals`: 3 single-fragment O(V) draws + 3 readbacks → tile partials
(T = ceil(V/256) fragments × 256 cells, 3 MRT outputs) + one 4×1 final with
**1 readback**. `MAX_FS` loop cap raised 200k → 700k (L8 safety; bounds were
already `uCount`-driven). Summation order differs: worktree A/B on identical
states agrees to ~1e-5 relative (4 mK on meanT — float32 reorder over 10k
terms, as expected), not bitwise. Cost (self-forcing, TRUE): L5 3.9→0.8 ms,
L6 14.3→2.7 ms, L7 ~57→**9.7 ms** (~6×). The <1 ms @ L7 bar is **missed on
SwiftShader-CPU** — 660k texelFetches ≈ the CPU fetch ceiling; on a real GPU
the 641 tile fragments run in parallel (≈ µs). Owner-verify on hardware.

### P1.5 smooth ×4 → 1 MRT pass

One draw, 4 MRT outputs, same `mix()` per texel per channel — worktree A/B
hashes of all 4 smooth textures **bit-identical** (L5 `21232a76`, L6
`1fd4c617`). 8 single-target FBOs → 2 MRT FBOs. Effect: flow.smooth L5
0.62→0.40 ms, L6 1.44→1.25 ms, L7 6.0→4.55 ms.

### P1 matrix (back-to-back A/B, same box — the honest comparison)

Old code re-run minutes apart (box drift between the P0 and P1 sessions reached
10% at L6/L7 — shared-CPU memory pressure; <10% claims need back-to-back A/B):

```
                old-now      P1        Δ        note
L5 explicit     11.175    10.560    -5.5%   untouched path (run jitter)
L5 implicit     28.195    23.860   -15.4%   P1.3 (ocean -16.4%)
L6 explicit     41.900    41.638    -0.6%   untouched ✓
L6 implicit     98.775    88.650   -10.3%   P1.3 (ocean -16.1%)
L7 explicit    172.050   177.150    +2.9%   untouched (in band)
L7 implicit    393.700   372.725    -5.3%   P1.3 (ocean -7.2%, small-K noise)
```

Gate `p1-final`: s0 L5/L6/L7 IDENTICAL, s1/s2 hashes unchanged from P0 —
**no `--allow-drift` needed**. Committed baseline `harness/bench-swvk.json`
updated to P1 (P0 preserved in git + the table above).

Acceptance: readbacks/frame 0 at defaults, ≤1 per sim-day refresh with co2On ✓;
passes/step reduced (Jacobi 12→10, smooth 4→1, reduce 3→2 draws + 3→1
readbacks) ✓; reduce <1 ms @ L7 missed on CPU (9.7 ms), GPU-scoped ✗/pending
owner-verify; L6 explicit back-to-back −0.6% (within 2%) ✓.

## Optimization log — Phase 2 (adaptive substep budget)

- **P2.1 “Auto” substeps** (`engine.js` `loop()` + `effSubsteps()`): physics
  wall time per frame feeds a 2 Hz EMA of ms/step (same tick as the fps
  counter); `autoN = clamp(floor(16.667/ema), 1, 128)` — the largest n with
  ms/step × n ≤ 16.7. Always measured (enabling auto mid-run picks sanely
  immediately); the `substepsAuto` checkbox (default off) selects it.
  `stepCO2` uses the effective n. Flow/draw overhead is deliberately NOT
  reserved — on draw-bound rigs fps lands under 60, visible in the readout.
  Verified headless: manual/auto selection, EMA blend, 1/128 clamps, stats
  fields, co2On subs.
- **P2.3 days/s honesty**: UI stats line shows `×n · Y d/s` (`auto×n` when
  auto); `bench.html` gains a `days/s` column (subs × dt × fps / 86400).
- **P2.2 `auto@60` rows** in `bench.html`: per level × scheme, fits
  frame(subs) = base + subs×stepMs through the extreme subs points and reports
  the largest N with frame ≤ 16.7 (days/s capped at 60 fps = vsync-delivered
  rate). Needs ≥ 2 subs values. Smoke-tested headless (rows render; vapor
  stepMs clamps to 128 as designed).

Gate `p2-final`: s0 IDENTICAL (harness never calls `loop()`; manual path
byte-identical behavior). Owner acceptance pending on hardware: L7 auto ≥ 30
fps at default dt; L6 auto n at max, fps unchanged.

## Optimization log — Phase 3 (tracers & flow pools)

- **P3.1 tracers columns** in `bench.html`: `tracers ms` = flow update
  (smooth+vflow+flow, no render) + tracer draw (render with streamline 15
  minus render with 0), measured once per level (subs/scheme-independent
  work); optional `tracers ms @Bk` column rebuilds pools at the second count
  (`Particles B(k)`, default 64), measures, and restores A. Smoke-tested
  headless (columns render; values are vapor here as documented).
- **P3.2 skip invisible work**: `loop()` freezes smooth+flow when the
  streamline mask is 0 (nothing drawn — their only consumer is the tracer
  advection); vflow still runs when modes 18–21 display it. Verified:
  mask=15 → all advance; mask=0 → all frozen; mask=0 + mode 18 → vflow
  fresh, pools/smooth frozen. Paused-skip (`vflowInit`) and the
  `MAX_TEXTURE_SIZE` pool clamp pre-existed (particle-cap scaling audit:
  no change needed).
- **P3.3a trail shift limit** `min(PT, K+2)`: slots above the drawn prefix
  are never read; raising `flowSegs` refills them within ~14 frames.
  `flow` **−30% at every level** (L5 21.0→14.4, L6 20.8→14.3, L7 22.2→15.2
  ms — level-independent, as predicted since pool size ⊥ grid level).
- **P3.3b indexed line draw**: K verts/particle + 2(K−1) indices (was 2(K−1)
  duplicated verts); shared slot verts shade once via the xform cache; same
  segment pairs in the same order. IBO rebuilt only when K/n change.
  Worktree screenshot A/B **pixel-identical in all 12 configs**
  (segs 24/40/2 × lines/dots × globe/equirect) — the P3.3 pair changes
  nothing visible.
- **P3.4**: defaults unchanged (`flowSegs` 24, 16k/pool); L6 draw
  pixel-identical ⇒ within 2% trivially (less work, same pixels).

`bench-swvk.json` rule (established): the file updates only when step math
changes (P1); P2/P3 leave it (P3 flow numbers live in this section). P3
session box episode noted: L7 *step* batches inflated +25–50% with closures
degrading to 0.84 (shared-CPU neighbor) — the run was discarded for steps;
flow numbers stayed clean (short level-independent batches cross-validate
across levels).

Acceptance: gate `p3-final` s0/s1/s2 all unchanged ✓. Owner-hardware items:
L7 tracers −25% (flow-update part −33% CPU-measured; draw part needs the
P3.1 column on GPU — combined plausibly ≥25% as flow dominates); `64k@L7 ≤
2× 16k@L7` **predicted likely miss** — STATE/TRAIL/draw scale ~linearly with
Np (expect ~2.3–4×) — owner-measure and document the floor (P0.6-style
revision if confirmed).

---

## Optimization log — Phase 4 (render: sweep, dpr, stride, 1-ring bake)

- **P4.1 draw sweep** in `bench.html`: per level, draw-only ms over modes
  {13, 0, 18} × streamline {0, 15} (warmed medians, `stepVFlow + render`;
  restores mode 13/s15 after). Third table (`tbl3`); the per-pass breakdown
  order gains the P4.3 `blend` key. Smoke-tested headless (`?fast=1`, L5:
  6 rows render, no errors; values vapor as documented).
- **P4.2a dpr cap**: 1.5 at L7 (4× the cells already — full-dpr fragments
  are pure fill cost), 2 elsewhere. No-op at headless dpr 1 (proven by the
  matrix below); GPU-measurable via the P4.1 sweep on owner hardware.
- **P4.2b tracer stride 2 at L7**: dots via `uStride` (`pid = vid*stride`),
  lines via strided pids baked into `_tracerIbo` (VS decode unchanged).
  Stride joins the IBO cache key — required, because pool size `n` is
  level-independent, so a level 6→7 switch would otherwise reuse a
  stride-1 IBO. Intended visible change (sparser trails at the densest
  grid only); L5/L6 draw identically.
- **P4.2c mvp/eye cache** keyed on `theta|phi|dist|w|h`: static scenes skip
  the trig + matrix chain (µs-level, behavior-preserving). Path-independence
  probe: gradual cam moves vs direct set → identical pixels (`de8d3f2a` both;
  1-ulp theta accumulation diff, sub-texel).
- **P4.3 1-ring bake** for V > 80k: `BLEND_BAKE_FS(m)` evaluates the exact
  globe v-loop + cloud c/r-loop once per cell into `blendTex` (RGBA32F:
  vVal, cloud c, rain r); `GLOBE_VS`/`CLOUD_VS` read one texel when
  `uUseBake=1`. Re-bake key is `level|mode|stepCount` (steps are the only
  in-place mutators; `reset`/`applyState`/`build` null it); paused frames
  skip the bake entirely. `blendTex` joins `destroyGrid` cleanup.
  Debugging note: the first version left `fbo.blend` bound, so the globe
  drew into its own bake source (GL feedback loop, void draw — caught
  because all L7 modes hashed identically); `_bakeBlend` now restores the
  null FBO + canvas viewport + depth state.
- **`harness/screenshot.js`** (new committed tool; unrelated to the in-app
  capture UI in `planet/screenshot.js`): render-path regression matrix. One
  seeded trajectory per level (substeps 1, 45 frames — trails developed),
  then every mode×mask combo rendered from the same state and hashed from
  raw canvas pixels (fnv1a-32, gate-style). `--baseline` compares with drift
  exit code; `--png=dir` writes clipped PNGs for eyeball. Deterministic:
  repeat runs hash-identical.

18-config pre-P4↔P4 matrix (levels 5/6/7 × modes 13/0/18 × masks 0/15;
pre-P4 tree = P4 hunks reverse-applied, syntax-checked):

| config | result |
|---|---|
| L5/L6 all 12 (either mask) | IDENTICAL |
| L7 s0 all 3 modes (bake path, globe+cloud) | IDENTICAL → bake bit-exact |
| L7 s15 all 3 modes | DRIFT (intended: stride-2 tracers) |

Bake-lifecycle probe (L7): render → BAKED; paused re-render → skipped, key
unchanged; step → BAKED; mode switch → BAKED. L7 s15 PNG eyeball: globe
identical, tracer dots visibly sparser, no artifacts. Gate `p4-final` s0
IDENTICAL all levels (`f3f718e5`/`50cbc2ae`/`23806737`, nan 0) — no sim math
touched. `bench-swvk.json` untouched per the step-math-only rule.

Acceptance: P4 render work is draw-side, so wall-clock proof needs the
owner's GPU: P4.1 sweep (L7 s15−s0 = tracer-draw cost; L7 vs L6 per mode),
dpr-cap effect at L7, and the L6 160fps floor. Analytic expectation at L7:
globe VS drops ~7 sampleVal evaluations + ~14 texelFetches per vertex per
frame while paused (bake skipped), replaced by 1 bake/field-change +
1 texelFetch/vertex — the vertex stage's dominant term.

---

## Sandbox note

`bench.html` is GPU-oriented; under headless SwiftShader its absolute timings are
submission-cost vapor (see driver artifacts). The page is smoke-tested headless
with `node harness/bench_visual_smoke.js` after `harness/setup_chrome.sh`:
`?fast=1&noauto=1`, a scripted matrix, the `done` control, and the complete
copied payload must populate without JS/GL errors. This is a functional test,
not a source of performance numbers. All committed headless numbers come from
`bench_backend.js` (forced differencing, closure-checked).

---

## WebGPU availability (Phase-5 readiness probe)

`harness/probe_webgpu.js` reports `navigator.gpu`, the adapter, and runs a tiny
compute dispatch end-to-end. Phase 5 (P5.1–P5.6) needs it green on the machine
that develops the engine.

**Sandbox result (2026-09-12, Chromium 152.0.7977.0 headless,
`@sparticuz/chromium` build, `--enable-unsafe-swiftshader` from
`chrome-launch.js`): `navigator.gpu` is UNDEFINED** — also with
`--enable-features=WebGPU,…`. This build ships no WebGPU implementation, so the
P5 parity harness (`harness/parity_webgpu.js`) and the WebGPU acceptance
numbers (L7 WebGPU ≤ 0.5× L7 WebGL) cannot be produced in the sandbox. Until a
WebGPU-capable browser is in play, the WebGL engine + `bench_backend.js` +
`gate.sh` remain the sandbox-verifiable surface; P5 implementation and
verification move to the owner machine (the probe runs there unchanged).

## Gate re-validation log

Committed-state gate runs (rule 1 evidence; scheme 0 = regression-gated vs
`harness/baselines-swvk`, schemes 1/2 = NaN-checked):

| date | tag | tree | result |
|---|---|---|---|
| 2026-09-12 | `p4-teardown-check` | post-P4 + bench.html teardown/warning (no sim-math change) | s0 L5/L6/L7 **IDENTICAL** (`f3f718e5`/`50cbc2ae`/`23806737` = P4 gate hashes); s1/s2 hashes reported, nan=0 |
