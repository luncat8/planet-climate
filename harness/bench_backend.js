/* Backend (physics) benchmark — headless, sandbox-friendly.
 *
 * Measures the cost of ONE calc-engine step (ocean + air dynamics) across
 * grid level and ocean integrator, isolated from all drawing. `planet.step()`
 * advances both fluids one substep; a GUI frame runs `substeps` of these plus
 * the flow-viz passes and a draw. This tool reports:
 *   msStep   - wall time for one step()  (gl.finish() bracketed = real GPU cost)
 *   stepsSec - 1000 / msStep
 *   sub@60   - how many substeps/frame fit a 60 fps (16.67 ms) budget
 *              = the max "Substeps / frame" the physics alone can sustain.
 *
 * NOTE ON NUMBERS: the sandbox has no GPU — WebGL runs on SwiftShader (CPU),
 * so ABSOLUTE ms are much slower than a real GPU. The RELATIVE scaling
 * (explicit vs implicit, L5->L6->L7, substep budget) is the portable result;
 * use the visual benchmark (bench.html) on real hardware for absolute fps.
 *
 *   cd harness && node bench_backend.js            # default matrix
 *   node bench_backend.js --levels=5,6 --steps=40  # override
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const DIR = path.resolve(__dirname, '../planet');

function arg(name, def) {
  const m = process.argv.find(a => a.startsWith('--' + name + '='));
  return m ? m.split('=')[1] : def;
}
const LEVELS = arg('levels', '5,6,7').split(',').map(Number);
const SCHEMES = [{ name: 'explicit', v: 0 }, { name: 'implicit', v: 2 }];
// per-level step counts (fewer at high level so SwiftShader stays under timeout)
const STEPS = { 5: 80, 6: 40, 7: 12 };
const OVERRIDE_STEPS = arg('steps', null);

(async () => {
  const b = await puppeteer.launch({
    headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const page = await b.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('ERR:' + e.message));
  page.on('console', m => { const t = m.text(); if (/error|NaN/i.test(t)) errs.push(t); });
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  const stateTxt = fs.readFileSync(path.join(DIR, 'planet_state.js'), 'utf8');

  const rows = [];
  for (const level of LEVELS) {
    const steps = OVERRIDE_STEPS ? +OVERRIDE_STEPS : (STEPS[level] || 20);
    for (const sc of SCHEMES) {
      const r = await page.evaluate((stateTxt, level, schemeV, steps) => {
        window.requestAnimationFrame = () => 0;   // never let loop() self-schedule
        const planet = new Planet(document.getElementById('c'), level);
        planet.build(level);
        // Load the bundled equilibrium only when the grid matches it (L5),
        // otherwise the fresh reset() state is representative enough for timing.
        try {
          (0, eval)(stateTxt);
          if (window.PLANET_STATE && window.PLANET_STATE.level === level)
            planet.applyState(decodePlanetState(window.PLANET_STATE));
        } catch (e) {}
        planet.params.oceanScheme = schemeV;
        const gl = planet.gl;
        // warmup (compiles/uploads, fills caches)
        for (let i = 0; i < 5; i++) { planet.step(); }
        gl.finish();
        /* Time-boxed, serialized measurement: finish() every step so each is
           truly flushed (a real frame's swap/readback forces the same sync),
           and keep stepping until ~600 ms elapse. Auto-adapts the sample count
           to any speed and stays well above timer resolution — fixed tiny
           counts gave sub-ms noise where implicit spuriously "beat" explicit. */
        const BUDGET = 600;
        let count = 0, el = 0; const t0 = performance.now();
        while (el < BUDGET) { planet.step(); gl.finish(); count++; el = performance.now() - t0; }
        const ms = el / count;
        return { cells: planet.grid.V, W: planet.grid.W, H: planet.grid.H, ms: ms, n: count };
      }, stateTxt, level, sc.v, steps);
      const sub60 = 16.667 / r.ms;
      rows.push({
        level, scheme: sc.name, cells: r.cells,
        msStep: +r.ms.toFixed(4),
        stepsSec: Math.round(1000 / r.ms),
        sub60: +sub60.toFixed(1),
      });
      process.stderr.write(`L${level} ${sc.name}: ${r.ms.toFixed(3)} ms/step over ${r.n} steps (${r.cells} cells)\n`);
    }
  }
  await b.close();

  // ---- human-readable table ----
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  let out = 'Backend physics benchmark (ocean + air, one step())\n';
  out += 'Renderer: SwiftShader (CPU) — treat ABSOLUTE ms as CPU-relative; scaling is portable.\n\n';
  out += pad('level', 6) + pad('scheme', 10) + padL('cells', 9) + padL('ms/step', 10) + padL('steps/s', 9) + padL('sub@60fps', 11) + '\n';
  out += '-'.repeat(55) + '\n';
  for (const r of rows)
    out += pad('L' + r.level, 6) + pad(r.scheme, 10) + padL(r.cells, 9) + padL(r.msStep, 10) + padL(r.stepsSec, 9) + padL(r.sub60, 11) + '\n';
  // relative ratios
  out += '\nRelative scaling (÷ L5 explicit):\n';
  const base = rows.find(r => r.level === LEVELS[0] && r.scheme === 'explicit');
  for (const r of rows)
    out += `  L${r.level} ${pad(r.scheme, 9)} ${(r.msStep / base.msStep).toFixed(2)}x\n`;
  if (errs.length) out += '\nERRORS: ' + JSON.stringify([...new Set(errs)].slice(0, 6)) + '\n';

  console.log(out);
  console.log('JSON ' + JSON.stringify(rows));
})();
