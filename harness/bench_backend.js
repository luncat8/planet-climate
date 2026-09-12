/* Backend (physics) benchmark — headless, sandbox-friendly.
 *
 * Measures the TRUE cost of ONE calc-engine step (ocean + air dynamics) across
 * grid level and ocean integrator, isolated from all drawing. `planet.step()`
 * advances both fluids one substep; a GUI frame runs `substeps` of these plus
 * the flow-viz passes and a draw. This tool reports:
 *   msStep   - wall time for one step(), GPU-execution-inclusive (see below)
 *   stepsSec - 1000 / msStep
 *   sub@60   - how many substeps/frame fit a 60 fps (16.67 ms) budget
 *   days/s   - simulated days per wall second at 60 fps with autoN substeps
 *   pass ms  - per-pass cost via differenced batch forcing (closure-checked:
 *              the pass sum must ≈ the whole-step time, or the run is flagged)
 *   ns/cell  - ms/step normalized by cell count (P0.6: L2-cliff test — a jump
 *              in ns/cell from L6 to L7 means per-fragment cost inflated).
 *
 * WHY FORCED DIFFERENCING. On SwiftShader-Vulkan, GL execution is fully
 * asynchronous AND gl.finish() does not block for it: submit+finish measures
 * only command submission (~0.03 ms/step at every level — level-independent,
 * physically impossible, pure vapor). Worse, naive batching trips two driver
 * artifacts: >~300 finish() calls OR >~10M queued cell-passes permanently(?)
 * degrades the context to a ~12 ms/step backpressure regime. What DOES force
 * completion is readPixels of a texture the measured work wrote (verified:
 * 1px read of the live target == full-texture read, and hashes evolve).
 * So each measurement is: run K repeats, read back 1px of the pass's OWN
 * output target (rebound every time — a stale FBO binding reads whatever the
 * engine left bound!), and difference two batch sizes (K2-K1) so the forcing
 * readback and any fixed overhead cancel. Closure (sum of passes vs whole
 * step) validates every run. See docs/BENCH.md for the full story.
 *
 * NOTE ON NUMBERS: the sandbox has no GPU — WebGL runs on SwiftShader (CPU),
 * so ABSOLUTE ms are CPU-relative. The RELATIVE scaling (explicit vs implicit,
 * L5->L6->L7, substep budget, pass shares) is the portable result; use the
 * visual benchmark (bench.html) on real hardware for absolute fps.
 *
 *   cd harness && node bench_backend.js            # default matrix
 *   node bench_backend.js --levels=5,6             # subset
 *   node bench_backend.js --flow=0                 # skip flow-viz passes
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { launchBrowser } = require('./chrome-launch');
const DIR = path.resolve(__dirname, '../planet');

function arg(name, def) {
  const m = process.argv.find(a => a.startsWith('--' + name + '='));
  return m ? m.split('=')[1] : def;
}
const LEVELS = arg('levels', '5,6,7').split(',').map(Number);
const SCHEMES = [{ name: 'explicit', v: 0 }, { name: 'implicit', v: 2 }];
const REPS = parseInt(arg('reps', '2'), 10);        // repeats per batch, min wins
const KSCALE = parseFloat(arg('kscale', '1'));      // multiply all batch sizes
const DO_FLOW = arg('flow', '1') !== '0';
// Batch sizes per level: ~4x cost per level, so shrink K to hold each
// measurement near ~0.1-2 s. Differencing (K2-K1) cancels forcing overhead.
const KS = { 5: [10, 30], 6: [4, 12], 7: [2, 6] };

(async () => {
  const b = await launchBrowser(puppeteer, { protocolTimeout: 600000 });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('ERR:' + e.message));
  page.on('console', m => { const t = m.text(); if (/error|NaN/i.test(t)) errs.push(t); });
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  const statePath = path.join(DIR, 'planet_state.js');
  const stateTxt = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
  const device = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });

  const rows = [];
  for (const level of LEVELS) {
    for (const sc of SCHEMES) {
      const ks = KS[level] || [4, 12];
      const k1 = Math.max(1, Math.round(ks[0] * KSCALE));
      const k2 = Math.max(k1 + 1, Math.round(ks[1] * KSCALE));
      const r = await page.evaluate((stateTxt, level, schemeV, k1, k2, reps, doFlow) => {
        window.requestAnimationFrame = () => 0;   // never let loop() self-schedule
        const planet = new Planet(document.getElementById('c'), level);
        planet.build(level);
        try {
          if (stateTxt) (0, eval)(stateTxt);
          if (window.PLANET_STATE && window.PLANET_STATE.level === level)
            planet.applyState(decodePlanetState(window.PLANET_STATE));
        } catch (e) {}
        planet.params.oceanScheme = schemeV;
        const gl = planet.gl;
        const fbo = gl.createFramebuffer();
        const px1 = new Float32Array(4);
        // Force completion: rebind + attach the pass's OWN target(s), read 1px.
        // The rebind is essential — without it readPixels hits whatever FBO
        // the engine left bound (a stale binding silently measures vapor).
        function force(texs) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          for (let i = 0; i < texs.length; i++) {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texs[i], 0);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px1);
          }
        }
        function T(fn, texs, K) {
          const t0 = performance.now();
          for (let i = 0; i < K; i++) fn();
          force(texs);
          return performance.now() - t0;
        }
        function measure(fn, texs) {
          let b1 = Infinity, b2 = Infinity;
          for (let i = 0; i < reps; i++) {
            const a = T(fn, texs, k1);
            if (a < b1) b1 = a;
          }
          for (let i = 0; i < reps; i++) {
            const c = T(fn, texs, k2);
            if (c < b2) b2 = c;
          }
          return { per: (b2 - b1) / (k2 - k1), t1: b1, t2: b2 };
        }
        // warmup (compile + caches) with a FORCED drain so no compilation
        // leaks into the first measurement.
        for (let i = 0; i < 3; i++) planet.step();
        force([planet.A[0]]);

        const stepTex = [planet.A[0]];   // couple writes A last every step
        const step = measure(() => planet.step(), stepTex);
        const per = {};
        const oceanFn = schemeV === 2 ? () => planet.stepOceanB() : () => planet.stepOcean();
        const oceanTex = schemeV === 2 ? [planet.P[0], planet.A[1]] : [planet.B[0]];
        per.ocean = measure(oceanFn, oceanTex);
        per.air = measure(() => planet.stepAir(), [planet.B[4]]);
        per.cplO = measure(() => planet.coupleOcean(), [planet.A[0]]);
        per.cplA = measure(() => planet.coupleAir(), [planet.A[4]]);
        per.ice = measure(() => planet.stepIce(), [planet.ice[0], planet.ice[1]]);
        let flow = null;
        if (doFlow) {
          flow = {};
          const smoothTex = [];
          for (const s of planet.smooth) { smoothTex.push(s.tex[0]); smoothTex.push(s.tex[1]); }
          flow.smooth = measure(() => planet.stepSmooth(), smoothTex);
          flow.vflow = measure(() => planet.stepVFlow(), [planet.texVFlow]);
          const poolTex = [];
          for (const p of planet.pools)
            for (const arr of [p.state, p.trail])
              if (arr) for (const t of arr) poolTex.push(t);
          const dtF = planet.params.dt * planet.params.substeps;
          flow.flow = measure(() => planet.stepFlow(dtF), poolTex);
        }
        // P1.3: Jacobi convergence AFTER timing (readbacks would pollute it).
        // trackResidual enables the harness-only early-exit; UI keeps fixed iters.
        let jac = null;
        if (schemeV === 2) {
          planet.trackResidual = true;
          for (let i = 0; i < 3; i++) planet.step();
          jac = { iters: planet.lastJacobiIters,
                  resid: planet.residualHistory.map(x => +x.toExponential(2)) };
          planet.trackResidual = false;
        }
        return { cells: planet.grid.V, step: step, per: per, flow: flow, jac: jac,
                 dt: planet.params.dt, k1: k1, k2: k2 };
      }, stateTxt, level, sc.v, k1, k2, REPS, DO_FLOW);
      const perMs = {};
      let sum = 0;
      for (const k in r.per) { perMs[k] = +r.per[k].per.toFixed(4); sum += r.per[k].per; }
      const msStep = +r.step.per.toFixed(4);
      const closure = sum / r.step.per;
      const flowMs = {};
      if (r.flow) for (const k in r.flow) flowMs[k] = +r.flow[k].per.toFixed(4);
      const sub60 = 16.667 / msStep;
      const autoN = Math.max(1, Math.floor(sub60));
      rows.push({
        level, scheme: sc.name, cells: r.cells, k1: r.k1, k2: r.k2,
        msStep: msStep,
        stepsSec: +(1000 / msStep).toFixed(1),
        sub60: +sub60.toFixed(2),
        autoN: autoN,
        daysPerSec: +(autoN * r.dt * 60 / 86400).toFixed(3),
        nsPerCell: +(msStep * 1e6 / r.cells).toFixed(1),
        per: perMs, closure: +closure.toFixed(3),
        flow: r.flow ? flowMs : null, jac: r.jac,
      });
      process.stderr.write(`L${level} ${sc.name}: ${msStep} ms/step ` +
        `(K=${r.k1}/${r.k2} T=${r.step.t1.toFixed(0)}/${r.step.t2.toFixed(0)}ms, closure=${closure.toFixed(2)})\n`);
    }
  }
  await b.close();

  // ---- human-readable tables ----
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  let out = 'Backend physics benchmark (ocean + air, one step())\n';
  out += 'Device: ' + device + '\n';
  out += 'Method: forced differencing (K repeats + 1px readback of the pass target; (T2-T1)/(K2-K1)).\n';
  out += 'Renderer: SwiftShader (CPU) — treat ABSOLUTE ms as CPU-relative; scaling is portable.\n\n';
  out += pad('level', 6) + pad('scheme', 10) + padL('cells', 9) + padL('ms/step', 10) +
         padL('steps/s', 9) + padL('sub@60fps', 11) + padL('autoN', 7) + padL('days/s', 9) +
         padL('ns/cell', 9) + padL('closure', 9) + '\n';
  out += '-'.repeat(89) + '\n';
  for (const r of rows)
    out += pad('L' + r.level, 6) + pad(r.scheme, 10) + padL(r.cells, 9) + padL(r.msStep, 10) +
           padL(r.stepsSec, 9) + padL(r.sub60, 11) + padL(r.autoN, 7) + padL(r.daysPerSec, 9) +
           padL(r.nsPerCell, 9) + padL(r.closure, 9) + '\n';
  out += '\nPass breakdown (ms per pass, differenced; closure = sum/step, want ~1.0):\n';
  out += pad('', 16);
  for (const k of ['ocean', 'air', 'cplO', 'cplA', 'ice']) out += padL(k, 9);
  out += padL('sum', 9) + '\n';
  for (const r of rows) {
    out += pad(`L${r.level} ${r.scheme}`, 16);
    let s = 0;
    for (const k of ['ocean', 'air', 'cplO', 'cplA', 'ice']) {
      const v = r.per[k] !== undefined ? r.per[k] : NaN; s += v;
      out += padL(isNaN(v) ? '-' : v.toFixed(3), 9);
    }
    out += padL(s.toFixed(3), 9) + '\n';
  }
  if (DO_FLOW) {
    out += '\nFlow-viz passes (ms per call, differenced):\n';
    out += pad('', 16);
    for (const k of ['smooth', 'vflow', 'flow']) out += padL(k, 9);
    out += padL('sum', 9) + '\n';
    for (const r of rows) {
      if (!r.flow) continue;
      out += pad(`L${r.level} ${r.scheme}`, 16);
      let s = 0;
      for (const k of ['smooth', 'vflow', 'flow']) {
        const v = r.flow[k] || 0; s += v;
        out += padL(v.toFixed(3), 9);
      }
      out += padL(s.toFixed(3), 9) + '\n';
    }
  }
  const jrows = rows.filter(r => r.jac);
  if (jrows.length) {
    out += '\nJacobi convergence (implicit, harness early-exit ≤1e-6):\n';
    for (const r of jrows)
      out += `  L${r.level}: iters/step=${r.jac.iters} residual=[${r.jac.resid.join(', ')}]\n`;
  }
  out += '\nRelative scaling (÷ L' + LEVELS[0] + ' explicit):\n';
  const base = rows.find(r => r.level === LEVELS[0] && r.scheme === 'explicit');
  for (const r of rows)
    out += `  L${r.level} ${pad(r.scheme, 9)} ${(r.msStep / base.msStep).toFixed(2)}x\n`;
  out += '\nns/cell ladder (P0.6: flat = perfect scaling; jump = per-fragment cliff):\n';
  for (const sc of SCHEMES) {
    const rr = rows.filter(r => r.scheme === sc.name);
    out += `  ${pad(sc.name, 9)} ` + rr.map(r => `L${r.level}=${r.nsPerCell}`).join('  ') + '\n';
  }
  const bad = rows.filter(r => r.closure < 0.8 || r.closure > 1.25);
  if (bad.length) out += '\nWARNING: closure out of [0.8, 1.25] for ' +
    bad.map(r => `L${r.level} ${r.scheme} (${r.closure})`).join(', ') + ' — numbers suspect!\n';
  if (errs.length) out += '\nERRORS: ' + JSON.stringify([...new Set(errs)].slice(0, 6)) + '\n';

  console.log(out);
  console.log('JSON ' + JSON.stringify({ device: device, rows: rows }));
})();
