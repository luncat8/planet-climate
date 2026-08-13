# Benchmarks

Two complementary benchmarks measure the two halves of the per-frame cost:

| Benchmark | Measures | Where it runs | Tool |
|---|---|---|---|
| **Backend** | calc engine only — one `step()` of ocean + air dynamics, no drawing | headless / sandbox (SwiftShader OK) | `harness/bench_backend.js` |
| **Visual** | whole system — `substeps × step()` + flow-viz passes + globe/streamline draw | a real GPU browser (open the file) | `planet/bench.html` |

A GUI frame runs `substeps` calc-engine steps, then the flow-viz update, then one
draw. The backend tool isolates the first part (portable, CPU-friendly); the
visual tool times the entire frame the way the user actually sees it.

---

## Backend (physics) — `harness/bench_backend.js`

```
cd harness && npm install          # once (puppeteer + a cached Chromium)
node bench_backend.js              # default matrix: L5,L6,L7 × explicit,implicit
node bench_backend.js --levels=5,6 # subset
```

**What it does.** Builds the planet at each level (loads the bundled L5
equilibrium where the grid matches; a fresh init elsewhere — representative for
timing), sets the ocean integrator, then time-boxes the measurement: it calls
`step()` with a `gl.finish()` after **each** step (so every step is truly
serialized — a real frame's buffer-swap forces the same sync) and keeps going for
~600 ms, reporting the mean.

**Reported columns**

- `ms/step` — wall time of one ocean+air step.
- `steps/s` — `1000 / ms`.
- `sub@60fps` — how many substeps/frame fit a 60 fps (16.67 ms) budget if the
  frame were *physics only*: `16.667 / ms`. i.e. the max “Substeps / frame” the
  calc engine alone can sustain at 60 fps.

**⚠ Absolute numbers are CPU-relative.** The sandbox has no GPU, so WebGL runs on
SwiftShader (software). The *relative* scaling (explicit vs implicit, L5→L6→L7,
substep budget) is the portable result; use the visual benchmark on real hardware
for absolute fps.

### Baseline (this repo, SwiftShader / CPU — scaling is the point, not the ms)

```
level scheme        cells   ms/step  steps/s  sub@60fps
-------------------------------------------------------
L5    explicit      10242    1.4152      707       11.8
L5    implicit      10242    3.9694      252        4.2
L6    explicit      40962    2.0180      496        8.3
L6    implicit      40962    5.9475      168        2.8
L7    explicit     163842    3.0836      324        5.4
L7    implicit     163842   18.6138       54        0.9
```

Takeaways that carry to real hardware:

- **Implicit costs ~2.8–6× a step vs explicit** (the Jacobi free-surface solve),
  and its penalty **grows with level** (≈3× at L5/L6, ≈6× at L7). Explicit is the
  cheaper integrator — consistent with the reference “explicit ~2× faster”.
- **Level scales the cell count ~4×/level** (10k → 41k → 164k). Explicit stays
  fixed-overhead-bound on CPU here (~1.4×/level); on a bandwidth-bound GPU expect
  closer to the reference “L7 ≈ 4× slower”.

---

## Visual (draw) — `planet/bench.html`

**Open `planet/bench.html` in a normal browser** (Chrome/Firefox/Safari) on the
machine whose GPU you want to measure. It auto-runs on load; edit the fields and
press **Run** to re-run.

- **Levels** / **Substeps** / **Particles(k)** — the matrix to sweep.
- For every `level × scheme × substeps` it times the full frame
  (`substeps × step()` + `stepSmooth`+`stepVFlow`+`stepFlow` + `render`) with a
  `gl.finish()` per frame, plus a per-level **draw-only** figure (globe +
  tracers, no stepping).

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

### Sandbox note

`bench.html` is GPU-oriented and vsync/`requestAnimationFrame`-driven; under the
headless SwiftShader sandbox the absolute timings are meaningless (frames are too
fast for the software timer's resolution). `harness/bench_visual_smoke.js` only
smoke-tests that the page builds, rebuilds pools, runs the matrix, and populates
the table without JS/GL errors — not for real numbers.
