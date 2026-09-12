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
press **Run** to re-run. **Real GPU required for evidence** — under headless
SwiftShader, `finish()` doesn't block (see above), so the page would measure
submission cost, not GPU time. For headless numbers use the backend bench.

**How every number on the page is measured (batch-averaged, since the 30-04
analysis).** `performance.now()` is clamped to **0.1 ms resolution** on any page
that is not cross-origin isolated (Chrome ≥ 91; a `file://` page never is —
measured in this sandbox: smallest positive delta over 200 000 consecutive reads
= 0.09999999986 ms, `crossOriginIsolated = false`). The page therefore never
times a single call. Each measurement is a **batch**: n calls, one
`gl.finish()`, value = span/n, with n grown on a ×4 ladder until the batch spans
≥ 100 timer ticks (≥ 10 ms on a 0.1 ms clock ⇒ ≤ 1 % quantization error). The
copied log states the resolution it measured (`# timer:`) and the protocol
(`# method:`); the `n/batch` column is the n used; `*` marks a value whose batch
hit the n cap before spanning the target (error > 1 %) and is therefore a
ceiling, not a magnitude. Sub-tick *values* are legitimate now — the batch span,
not the tick, sets the error bar — so a 0.021 ms draw measured over a 10 ms
batch is a real number.

Batching also fixes a second, independent defect the earlier captures show: with
one call in flight, `gl.finish()` on the owner driver returns before execution
completes for small batches, so **×10 rows under-reported by 1.7×–12.2×**
against the ×128 slope (L6 explicit 0.11 ms measured vs 1.34 predicted; L7
explicit 0.26 vs 2.95). With n calls queued, the final `finish()` has to absorb
the whole backlog, so span/n converges on the real throughput cost.

**Reading the pre-batching captures (`30-00`…`30-04`)** — they were produced by
the single-shot page, so:

- read **per-step cost from the ×128 rows** (or the auto-fit slope), never from
  a ×10 row;
- `draw ms`, `tracers ms`, and draw-sweep values of `0.00`/`0.02` mean
  **"< ~0.1 ms"**, i.e. unresolved — not "free";
- the software-renderer indicator is the `# renderer:` string / the
  `# WARNING: SOFTWARE RENDERER` line — **never** the row values (the 0.00 /
  0.10 ms / "10 000 fps" rows are the timer floor, which a real GPU produces
  exactly like software GL).

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
  (`substeps × step()` + `stepSmooth`+`stepVFlow`+`stepFlow` + `render`) as a
  batch (n frames, one `gl.finish()` + 1 px forcing readback, value = span/n),
  plus a per-level **draw-only** figure (globe + tracers, no stepping).
- **Per-pass breakdown table** (P0.1): each level at explicit × first-substeps,
  each pass timed in **batch isolation** (n repeats of that one stepper, one
  finish + readback, n ≤ 32) from a `serializeState()` snapshot restored before
  every batch, so no pass is timed on fields a previous isolated pass wrecked.
  `step` is one whole `step()` the same way; **`closure`** = Σ(ocean, air, cplO,
  cplA, ice) / `step` and must be ≈ 1 — the `30-05-00`/`30-05-01` captures show what
  it looks like when it is not (0.00–0.86). `Planet.trace` is still in the
  engine for ad-hoc work but the benches no longer use it: one `finish()` per
  pass per frame quantizes every pass to the tick and produces absorber
  artifacts (`ice` reading cheaper at L7 than L5).

**Columns**

- `frame ms` — full-frame work time. **Under ~16.7 ms ⇒ sustains 60 fps** (those
  rows are highlighted).
- `draw ms` — draw cost alone (isolates the rendering half from the physics).
- `max fps` — `1000 / frame ms`, compute-limited. On a vsync display the GUI
  still caps at the refresh rate (usually 60).

Sampling is time-boxed (~1.2 s/config, ≥ 3 batches, ≤ 24) so cheap configs get a
stable median while a very heavy one (e.g. L7 ×128 implicit) still returns in
bounded time; the calibration batch that sizes n is a warm-up and is **not**
sampled. **Runs** (default 1) repeats the whole matrix and reports each cell's
median — rule 3's 2 % test needs 3. A `?fast=1` URL flag shrinks the sample counts for a quick pass on
slow/software renderers; `?noauto=1` suppresses the auto-run (used by the smoke
test).

#### Owner-GPU visual logs (`archive/30-00` … `30-05-01`) — corrected analysis (2026-09-12)

**Correction of record.** An earlier analysis pass classified all archived
visual captures as headless SwiftShader output carrying a "submission-time
signature" and disqualified them as evidence. **That was wrong** — a
hallucinated diagnosis, since withdrawn by the owner: all four captures were
run on the **owner's RTX GPU** (Chrome 151, dpr 1.25 — not the sandbox's
headless Chromium 152 build). The "signature" reasoning was unsound end to end:

- the 0.00 / 0.10 ms / 10 000-fps rows it leaned on are the **0.1 ms
  `performance.now()` clamp** (see *Reading the numbers*), produced by real
  GPUs and software GL alike;
- the large frame-ms rows (e.g. L7 implicit ×128 ≈ 244 ms) are real
  `gl.finish()`-bracketed wall time — `finish()` blocks properly on the owner
  driver, exactly as this page's design assumes for real GPUs;
- the "~300-finish backpressure cliff" invoked to explain those rows is a
  SwiftShader-specific behavior documented in the *backend* section; applying
  it to owner-GPU captures was unfounded.

The seven logs are owner-GPU evidence, subject to the reading rules above:

| capture | commit | page state | contents |
|---|---|---|---|
| `30-00` | `9755c73` | pre-P0 (live rAF loop during sampling) | matrix |
| `30-01` | `6b92890` | P4 | matrix, auto rows, tracers column |
| `30-02` | `69292b4` | post-P4 + teardown | + draw sweep, per-pass |
| `30-03` | `3e8e57b` | post-P4 (repaired page), **single-shot timing** | full matrix; owner trimmed header "noise" (the `# renderer:` line went with it — owner confirms same RTX GPU) |
| `30-04` | `3e8e57b` | same page, re-run, **single-shot** | full matrix; timer *not* 0.1 ms-clamped (analysis below); `harness/logs/climate-p4-visual-2-rtx.txt` |
| `30-05-00` | this tree | **batch-averaged**, served over http | full matrix, `crossOriginIsolated=true`, timer 0.005 ms; `harness/logs/climate-p5-visual-1-rtx-http.txt` |
| `30-05-01` | this tree | **batch-averaged**, `file://` | same machine/input, `crossOriginIsolated=false`, timer 0.100 ms; `harness/logs/climate-p5-visual-2-rtx-file.txt` |

`30-03` is the reference capture for the pre-batching page, archived verbatim as
`harness/logs/climate-p4-visual-1-rtx.txt` (rule 4 layout). Future captures
should keep the `# renderer:` header (rule 5) and, where a < 2 % claim must be
adjudicated (rule 3), set **Runs = 3** and use the median.

#### Capture `30-04` — the sub-millisecond measurement defect (2026-09-12)

`archive/30-04-log-bench.html.txt` is a second full-matrix capture from the same
machine (Chrome 151, dpr 1.25), taken with the single-shot page. Analysed cell by
cell it confirms the ×128 physics numbers and shows that **everything under
~0.3 ms in those logs is measurement, not physics** — the finding that produced
the batch-averaged protocol above.

**1. `30-04`'s timer was finer than 0.1 ms; `30-03`'s was not.** In `30-03`,
**24/24** frame-ms and draw-ms cells are exact multiples of 0.1 ms — the
signature of the clamp. In `30-04` only **2/24** are (0.12, 0.11, 0.26, 5.28,
0.02 …). A median of clamped deltas cannot be 0.12, so that run's
`performance.now()` was not 0.1 ms-clamped; `30-05-00` later showed how (serving the
page over http makes it cross-origin isolated: 0.005 ms). Which of the old
captures were clamped is therefore unknowable from the logs — read the numbers,
not the assumption.

**2. The ×10 rows under-reported by 1.7×–12.2×** — a second defect, independent
of the clamp. Each ×10 row against `subs × (frame₁₂₈/128)`:

| config | ×10 measured | ×10 from the ×128 slope | under-report |
|---|---:|---:|---:|
| L5 explicit | 0.12 ms | 0.41 ms | 3.4× |
| L5 implicit | 0.67 ms | 1.15 ms | 1.7× |
| L6 explicit | 0.11 ms | 1.34 ms | **12.2×** |
| L6 implicit | 0.70 ms | 3.07 ms | 4.4× |
| L7 explicit | 0.26 ms | 2.95 ms | **11.3×** |
| L7 implicit | 23.31 ms | 19.02 ms | 0.8× |

A 10× error is not 0.1 ms rounding: with one frame in flight, `finish()` returned
early and the row measured submission. The error vanishes exactly where a frame
is long enough to fill the queue (L7 implicit, 23 ms) — the condition batching
now creates deliberately. **Fixed:** in `30-05-00`/`30-05-01` the same rows read
0.738–0.800 (L5 explicit ×10) and 3.79–5.99 (L7 explicit ×10), i.e. slightly
*above* the pure-slope prediction, which is the correct shape (the slope omits
the per-frame flow + draw overhead).

**3. The ×128 rows reproduce; the cheapest of them does not.**

| config | `30-03` | `30-04` | Δ |
|---|---:|---:|---:|
| L5 explicit ×128 | 4.00 ms | 5.28 ms | **+32.0 %** |
| L5 implicit ×128 | 14.90 ms | 14.78 ms | −0.8 % |
| L6 explicit ×128 | 17.00 ms | 17.16 ms | +0.9 % |
| L6 implicit ×128 | 39.20 ms | 39.30 ms | +0.3 % |
| L7 explicit ×128 | 37.20 ms | 37.73 ms | +1.4 % |
| L7 implicit ×128 | 244.00 ms | 243.46 ms | −0.2 % |

Five of six agree inside ±1.4 %; the cheapest heavy row (4–5 ms) swings +32 %.
Variance is worst where the frame is shortest — exactly where rule 3's 2 % test
lives (⇒ carry-over **C2**, `Runs = 3`).

**4. Every sub-tick cell was unresolved, and two acceptances were closed on such
cells.** Frame rows under 0.35 ms (L5/L6/L7 explicit ×10) print "8696 / 9091 /
3922 max fps" — timer artifacts. `draw ms` read 0.02 at *every* level, the whole
P4.1 sweep 0.01–0.05 ms, tracers 0.02 (16 k) / 0.04 (64 k). A 460×460 globe +
cloud shell + 32 k tracer draw in 0.02 ms is not credible, and `s15 − s0` — the
delta P4.1 exists to isolate — was the difference of two quantized numbers.
**P4's and P3's "floor documented" closures rest on cells the timer could not
resolve** ⇒ carry-over **C1**.

**5. The `Planet.trace` per-pass table did not close.** Σ(dynamics passes)
against the frame it decomposes (explicit ×10): `30-03` 0.312 vs 0.10 (L5),
0.393 vs 0.10 (L6), 0.593 vs 0.30 (L7); `30-04` 0.294 vs 0.12, 0.401 vs 0.11,
0.495 vs 0.26. Closure 1.9–3.9×, and `ice` read 0.037–0.053 ms at L7 against
0.141–0.149 ms at L5 — a pass touching 16× the cells cannot get 4× cheaper. That
is the absorber artifact of a `finish()` per pass ⇒ carry-over **C6**.

#### Captures `30-05-00` / `30-05-01` — the batched page on the owner GPU (2026-09-12)

Two runs of the batch-averaged page, same machine, same input
(`levels=5,6,7; substeps=10,128; particles 16/64 k`), differing only in origin:
`30-05-00` served over **http** (`crossOriginIsolated=true`, timer **0.0050 ms**),
`30-05-01` from **`file://`** (`crossOriginIsolated=false`, timer **0.1000 ms**).
That pair is the cleanest available instrument check: same GPU, two timer
resolutions 20× apart.

**What the fix bought.**

- **The clamp is escapable, and the page now says which one you got.** Serving
  the page over http with cross-origin isolation gives a 5 µs timer; `file://`
  gives 0.1 ms. Both headers record it, so no future log has to be guessed at.
- **The ×10 under-report is gone.** 8 of 12 frame rows agree between the two
  runs within 8 %, including all four L5/L6 ×128 rows (0.96–1.03×) — and the
  ×10 rows now sit *above* the ×128 slope instead of 3–12× below it.
- **Sub-tick columns carry real values.** `draw ms` = 0.069–0.172, tracers
  0.095–0.754 (16 k) / 0.072–0.674 (64 k), draw-sweep cells 0.021–0.687 with
  n = 256–1024. No 0.00 column anywhere.

**What is still broken (found by these two runs, fixed in code afterwards).**

- **The per-pass breakdown does not measure passes.** `ocean` reads
  0.001–0.029 ms at L7 — impossible for a 163,842-cell pass with ~50 dependent
  `texelFetch`es per cell — while `step` reads **17.15 ms** at L7 in `30-05-00`
  where the whole ×10 frame is 5.99 ms (10 steps cannot cost 171 ms). Closure:
  0.74 / 0.86 / **0.00** (`30-05-00`), 0.28 / 0.06 / 0.11 (`30-05-01`). Two causes,
  both now fixed: (a) `gl.finish()` does not force a batch of *one small pass*,
  so every batch ends with a 1 px `readPixels` on **all** renderers (the
  `bench_backend.js` forcing trick); (b) repeating one stepper alone drives the
  fields off the manifold, so every later pass was timed on garbage — each pass
  is now re-timed from a `serializeState()` snapshot restored per batch, with
  n capped at 32.
- **The draw sweep does not reproduce.** Same config, two runs: L5 m13 s0
  0.021 vs 0.125 ms (6×), L6 m18 s0 0.227 vs 0.064 (0.28×), and the s15−s0
  tracer delta flips sign at L5/L6/L7 m13 (+0.056/−0.049, +0.060/−0.046,
  +0.509/−0.082). Same cause as (a) — unsynchronized batches — so C1 stays open
  until a forced-completion run reproduces.
- **Two frame rows are physically impossible.** Implicit must cost more than
  explicit (it adds the Jacobi solve); `30-05-01` reports L7 ×128 explicit 85.93 ms
  vs implicit **50.38 ms**, and `30-05-00` reports L6 ×10 explicit 5.33 ms vs
  implicit 3.27 ms. L7 ×128 also disagrees 1.4–2.4× between the runs
  (explicit 61.27/85.93, implicit 119.25/50.38) and no longer matches the
  single-shot captures at all (37.2–37.7 / 243.5–244.0). Suspected cause,
  **not verified**: at L7 nothing is equilibrated — `planet/planet_state.js` is
  not tracked in this repository and, even where present, only applies at L5 —
  so L7 is measured on a freely drifting state whose cost depends on how much
  simulation ran beforehand. ⇒ carry-over **C8**.
- **Header bug (cosmetic, fixed):** the optional `tracers ms @Bk` header was
  inserted before `mh.lastChild`, which is the trailing whitespace *text node*,
  so it landed after `n/batch` while the cells stayed in
  (tracers, tracers@B, n) order. Both logs carry a note; `30-05-00`'s
  "0.205 0.237 16" is 16 k = 0.205 ms, 64 k = 0.237 ms, n = 16.

**Still standing from all seven captures:** L5/L6 ×128 physics costs (5.7–5.9
explicit, 14.8–15.3 implicit at L5; 17.2–17.3 explicit, 38.9–39.4 implicit at
L6), the implicit/explicit ratio (2.3–2.7×), and the historical P2 `auto@60`
benchmark rows (L6 auto→122/53, L7 auto→32/8, all ≥ 60 fps). These rows do not
validate the replaced interactive checkbox controller.

**What the owner GPU measures.** Per-step costs from the ×128 rows of the
single-shot captures `30-00`…`30-04` (linear-in-substeps fits; those four agree
within ±8 %). The batched captures `30-05-00`/`30-05-01` reproduce L5/L6 to within
4 % but not L7 — see the `30-05-00`/`30-05-01` section before reusing L7 numbers:

| level | scheme | frame ms @×128 (4 captures) | ms/step | ns/cell |
|---|---|---|---:|---:|
| L5 | explicit | 3.60 – 4.00 | 0.033 | 3.2 |
| L6 | explicit | 16.60 – 18.00 | 0.143 | 3.5 |
| L7 | explicit | 36.70 – 38.60 | 0.313 | 1.9 |
| L5 | implicit | 14.80 – 15.60 | 0.120 | 11.7 |
| L6 | implicit | 39.00 – 41.70 | 0.326 | 8.0 |
| L7 | implicit | 241.10 – 248.90 | 1.870 | 11.4 |

Reading these (with `30-03`'s auto rows and per-pass table):

- **P0.6 revised — no uniform L2 cliff.** Explicit scales *sub*-linearly: L6→L7
  costs 2.2× for 4× cells and ns/cell *drops* at L7. Implicit pays a
  super-linear L6→L7 jump (5.7× for 4× cells, +42 % ns/cell) — consistent with
  the Jacobi solve's random-access working set (5.9 → 23.6 MB per pass)
  outgrowing L2, as hypothesized, but only for that pass family. End to end,
  implicit L5→L7 is 16× for 16× cells: the "16×" that motivated the plan is
  plain linear cell scaling on implicit, not an extra per-cell factor. The
  WebGPU port remains the fix (dependent fetches, fixed overhead, implicit
  cache misses), but the original uniform 2–4×/level per-fragment cliff is
  **refuted for explicit, confirmed only for implicit**.
- **The draw half is under the tick at every level.** `draw ms`, the entire
  P4.1 sweep, and both tracers columns read 0.00 (= < ~0.1 ms) at L5/L6/L7 —
  globe + cloud + tracers including the P4.3 bake and P4.2 stride. P4's "L7
  draw ≥ 20 % reduced **or floor documented**" closes via the documented
  floor: no draw-side work can register below 0.1 ms on this rig. P3's
  `64k ≤ 2× 16k` likewise closes as *floor documented* (both counts < tick).
- **Historical P2 benchmark acceptance.** `30-03` offline rows: L7 explicit
  auto→53 @ 60 fps, L7 implicit auto→6 @ ~63 fps; L6 explicit auto→116,
  implicit auto→51. These are benchmark-model results, not the new interactive
  controller. Throughput honesty remains visible: at L7 explicit, full ×128
  delivers 2.389 d/s vs the historical auto@60 2.208 d/s.
- **P4 before/after is legitimate owner evidence (single-run variance ~±5–8 %).**
  L6 explicit ×128 across `9755c73`→`6b92890`→`69292b4`→`30-03`:
  16.60 → 18.00 → 17.10 → 17.00 ms; L7 implicit 244.7 → 248.9 → 241.1 → 244.0.
  The earlier alarm over "L6 +8.4 %" was computed from *valid* numbers but
  over-read single runs (the post-P4 captures return to baseline); the ×3
  median (follow-up, non-blocking) adjudicates the 2 % rule.
- **Per-pass table**: finish-serialized and tick-quantized — pass sums exceed
  the whole-frame time and passes under ~0.2 ms are noise. Above-tick signals
  worth keeping: ocean dominates L7 explicit (0.28 ms), cplA is the second
  L7 pass (0.155); the L7 `ice` ≈ 0.05 ms reading is a below-tick absorber
  artifact (ice runs the full grid; it cannot be cheaper than L5's 0.149).
- **Trust ladder for this page on this rig:** ×128 rows ≥ auto fits >
  ×10 rows ≈ per-pass table > draw/tracers/sweep columns. Sub-tick values are
  ceilings ("< 0.1 ms"), never magnitudes.

**Open discrepancy with the owner reference below.** The GUI reference says
L6 implicit ×128 = 60 fps; the bench measures 39–42 ms (≈ 25 fps) for exactly
that config, consistently across four captures. Both cannot be true on one
machine. Owner follow-up: read the GUI fps HUD at L6 implicit ×128 once and
reconcile (the reference may have been noted from a vsync-capped HUD, a lighter
earlier build, or a different config). Ratios that *did* reproduce from the
reference: explicit ≈ 2.3× faster than implicit at ×128 ✓; L7 vs L6 = 2.2×
explicit / 5.7–6.2× implicit (the flat "≈ 4×" holds for neither scheme
exactly).

### Reference GUI performance (real GPU, from the project owner)

These are the targets the visual benchmark should reproduce on comparable
hardware (2026-09-12: the ×128 figure conflicts with the measured 39–42 ms —
see the owner-GPU logs section above; owner re-check pending):

- calc engine **Implicit ×128 substeps @ L6 = 60 fps** *(disputed by measurement)*
- calc engine **Implicit ×10 substeps @ L6 = 60 fps** (measured 0.70 ms — easily ✓)
- **explicit ≈ 2× faster** than implicit (measured 2.3× at ×128 ✓)
- **L7 ≈ 4× slower** than L6 (measured 2.2× explicit / 5.7× implicit — scheme-dependent)

(That both ×10 and ×128 were reported at 60 fps at L6 would mean the per-frame
budget there is draw-bound, not step-bound — the extra 118 substeps still fit
under 16.7 ms. The backend table above is the tool to confirm where that stops
being true; the visual ×128 rows above are the tool to confirm whether it was
ever true.)

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

- **P2.1 “Auto” substeps** (`engine.js` `loop()` + `effSubsteps()`): the old
  single checkbox and physics-only `16.667 ms / EMA(ms/step)` controller were
  removed. They could spend the whole frame budget on physics, ignore draw/flow
  cost, and then miss the user's actual delivered FPS target.
- Auto is now two independent one-way controls:
  - **keep ≥50 fps (decrease only)** — checked by default; when delivered FPS
    drops below 50, reduce the effective substep count, never increase it;
  - **fill rAF (increase only)** — unchecked by default; increase only when
    delivered FPS is at the measured rAF/display ceiling (60/120/144/180 Hz),
    never merely because a 70-fps frame is below a 144-Hz ceiling.
  The manual **Substeps / frame** slider remains the seed. With both checkboxes
  off, it is the only source of N. The controller uses delivered FPS, so draw
  and flow work are included; `stepCO2` uses the effective N.
- **P2.3 days/s honesty**: UI stats line shows `×n · Y d/s` (`auto×n` when
  auto); `bench.html` retains a `days/s` column (subs × dt × fps / 86400).
- **P2.2 `auto@60` rows** in `bench.html` remain an offline benchmark model,
  not the interactive controller: per level × scheme, they fit
  `frame(subs) = base + subs×stepMs` through the extreme subs points and report
  the largest N with frame ≤ 16.7. This keeps archived benchmark logs
  comparable while the UI now targets an actual rAF ceiling and a 50-fps floor.

Gate `p2-final`: manual path remains unchanged because the harness does not call
`loop()`; re-run the visual acceptance on the owner GPU after this UI-only
controller change. The old capture's auto→N rows are historical `auto@60`
benchmark results, not proof that the old interactive checkbox worked.

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

Acceptance: gate `p3-final` s0/s1/s2 all unchanged ✓. **Re-opened 2026-09-12.**
The "closes as *floor documented*" verdict (capture `30-03`: both tracers
columns < the 0.1 ms tick) was reached on cells the timer could not resolve, and
`30-05-00`/`30-05-01` show the half is not under-tick at all — tracers read
0.095–0.754 ms at 16 k and 0.072–0.674 ms at 64 k once batched. The two
acceptance tests ("L7 tracers ≥ 25 % reduced", "64k ≤ 2× 16k") are measurable
but not yet measured on a run whose batches are forced to complete: in
`30-05-00` 64 k < 16 k at L5/L6/L7 (0.237 vs 0.205, 0.074 vs 0.151, 0.674 vs
0.402 — the last one *super*-linear the wrong way), which is the
unsynchronized-batch artifact, not physics. Carry-over **C1** in
`40-improvement-plan-webgpu.md`. The −33 % flow-update CPU-relative gain from
P3.3a stands as the portable evidence.

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

Acceptance: **re-opened 2026-09-12** (it had been closed as *MET via the
documented floor* on capture `30-03`). The floor was a timer artifact: batched,
the same sweep reads 0.021–0.687 ms (`30-05-00`) and 0.021–0.547 ms (`30-05-01`), and
`draw ms` 0.069–0.172 ms. So "L7 draw ≥ 20 % reduced" *is* measurable — but the
two runs do not yet agree (L5 m13 s0 0.021 vs 0.125 ms; the s15−s0 tracer delta
flips sign at all three levels), because those captures ran before batches were
forced to complete. Carry-over **C1**.
The P4.3 bake / P4.2 stride remain correctness-proven (18-config pixel matrix
above); their wall-clock value is bounded above by "< 0.1 ms total draw" —
which was the point (draw was never the expensive half). Analytic expectation
at L7: globe VS drops ~7 sampleVal evaluations + ~14 texelFetches per vertex
per frame while paused (bake skipped), replaced by 1 bake/field-change +
1 texelFetch/vertex — the vertex stage's dominant term. The "L6 160 fps floor"
predates owner data; on the measured rig L6 explicit ×128 sustains 59 fps and
auto honestly fills the 16.7 ms budget at n=116/51 — re-base rule 3 to "L6
within 2 % of the committed owner-GPU ×128 baseline (median-of-3)" once the
disputed ×128 reference figure is reconciled (see the visual section).

---

## Sandbox note

`bench.html` is GPU-oriented. Since the batch rewrite it is **less** vapor under
headless SwiftShader than it used to be: every batch ends in a 1 px forcing
readback, so spans now track real software-GL execution and the page reproduces
physical ordering (smoke config L5 ×1: explicit 110.2 ms < implicit 135.1 ms,
where the single-shot page reported 0.100 / 0.100 — one tick, no information).
It still is not the headless number source: no differencing, no closure check
against `bench_backend.js`, and a 2-CPU box. `bench_backend.js` (forced
differencing, closure-checked) remains the committed headless evidence.

The page is smoke-tested headless with `node harness/bench_visual_smoke.js`
after `harness/setup_chrome.sh`: `?fast=1&noauto=1`, a scripted matrix, the
`done` control, and the complete copied payload must populate without JS/GL
errors, **and** the log must state the measured timer resolution and the
batch-averaged method, every draw-sweep cell must resolve (value > 0, n ≥ 1),
and at least one measurement must have batched (max n > 1). That last assertion
is the regression guard for the sub-ms defect: the pre-fix page passed the
functional part while printing 0.00 for the entire draw column.

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
| 2026-09-12 | `p4-evidence-fix` | owner-GPU log correction (docs + bench.html text/comments + `harness/logs/climate-p4-visual-1-rtx.txt`; no engine code) | s0 L5/L6/L7 **IDENTICAL** (`f3f718e5`/`50cbc2ae`/`23806737`); s1/s2 reported, nan=0. Visual smoke test green |
| 2026-09-12 | `bench-timing-fix` | batch-averaged timing + forcing readback + batch-isolation breakdown + `Runs` median-of-N (`planet/bench.html`, `harness/bench_visual_smoke.js`; no engine/shader change) | s0 L5/L6/L7 **IDENTICAL** (`f3f718e5`/`50cbc2ae`/`23806737`, nan=0), `GATE_EXIT=0`. Visual smoke test green: `ERRORS []`, timer resolution reported, max n/batch 4, all six draw-sweep cells resolved, explicit 164.8 ms < implicit 168.9 ms |
