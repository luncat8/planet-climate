/* air_dt_sweep.js — dt-independence verification for the AIR simulation.
 *
 * The air step (AIR_FS) is explicit upwind advection + pressure-gradient +
 * Crank-Nicolson Coriolis + implicit friction. The plan (PLAN_AIR_DT.md) adds a
 * per-face Courant cap (uCourantMax) to the FV advection so large-dt air behaves
 * like small-dt air, plus an opt-in Semi-Lagrangian path (uAirAdvect==1).
 *
 * This harness runs the FULL integrated step (ocean + air + couple) for a fixed
 * simulated time T at several dt values, then measures the air wind field
 * (RMS |v| over wet cells) and checks that it is flat across dt — i.e. the wind
 * magnitude does not depend on dt. It also exercises the SL path for stability.
 *
 * Usage:
 *   node air_dt_sweep.js --dir=/media/sf_1/planet242/planet
 *                          [--level=4] [--time=172800] [--dts=0.5,1,2,4,8]
 *                          [--advects=0,1] [--tol=0.10] [--out=file.json]
 *
 * The --dir flag is REQUIRED (there is no default project symlink).
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const DIR_ARG = arg('dir', '');
const DIR = DIR_ARG
  ? path.resolve(DIR_ARG)
  : path.resolve(__dirname, '..', 'planet');
const LEVEL   = parseInt(arg('level', '4'), 10);
const TIME    = parseFloat(arg('time', '172800'));            // simulated seconds
const DTS     = arg('dts', '0.5,1,2,4,8').split(',').map(Number);
const ADV     = arg('advects', '0,1').split(',').map(Number);
const TOL     = parseFloat(arg('tol', '0.10'));              // |bias| tolerance
const OUT     = arg('out', '');
const PATCH   = JSON.parse(arg('patch', '{}'));              // extra param overrides

(async () => {
  // ---- sanity: dir exists with the four engine sources -----------------------
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    if (!fs.existsSync(path.join(DIR, f)))
      throw new Error('missing engine source ' + path.join(DIR, f));
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 600000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
           '--use-angle=swiftshader', '--disable-gpu-sandbox', '--enable-webgl',
           '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.setContent('<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas></body></html>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  const result = await page.evaluate(async (LEVEL, TIME, DTS, ADV, TOL, PATCH) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};

    const canvas = document.getElementById('c');
    let planet;
    try { planet = new Planet(canvas, LEVEL); }
    catch (e) { return { fatal: 'construct: ' + e.message }; }
    const gl = planet.gl;
    const W = planet.grid.W, H = planet.grid.H, V = planet.grid.V;
    /* The constructor runs one render() via the (stubbed) rAF loop; flush any
       GL error it may have left so our post-run checks start clean. */
    while (gl.getError() !== gl.NO_ERROR) {}

    function glErr(tag) {
      const e = gl.getError();
      return e === gl.NO_ERROR ? null : (tag + ' GL_ERROR=0x' + e.toString(16));
    }

    // Static land mask (WET = land < 0.5) — read once.
    function readTex(tex) {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const buf = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      return buf;
    }
    const cellB = readTex(planet.texCellB);
    const wet = new Uint8Array(V);
    let wetN = 0;
    for (let c = 0; c < V; c++) { wet[c] = cellB[c * 4 + 3] < 0.5 ? 1 : 0; if (wet[c]) wetN++; }

    // Air wind diagnostics: RMS |v| over wet cells, plus max speed & NaN count.
    // Also track the low-air temperature (Tl=loA.z) and pressure (Pl=loA.w)
    // ranges, since Pl-gradient is what actually drives the wind — if Pl range
    // is dt-dependent, the bug is in the coupled thermodynamics, not the air
    // momentum advection.
    function airStats() {
      const loA = readTex(planet.A[4]);
      const hiA = readTex(planet.A[6]);
      let sum2 = 0, cnt = 0, maxSpd = 0, nan = 0;
      let tloMin = Infinity, tloMax = -Infinity, ploMin = Infinity, ploMax = -Infinity;
      for (let c = 0; c < V; c++) {
        if (!wet[c]) continue;
        for (const a of [loA, hiA]) {
          const u = a[c * 4], v = a[c * 4 + 1];
          if (!isFinite(u) || !isFinite(v)) { nan++; continue; }
          const s = Math.hypot(u, v);
          sum2 += s * s; cnt++;
          if (s > maxSpd) maxSpd = s;
        }
        const tl = loA[c * 4 + 2], pl = loA[c * 4 + 3];
        if (isFinite(tl)) { if (tl < tloMin) tloMin = tl; if (tl > tloMax) tloMax = tl; }
        if (isFinite(pl)) { if (pl < ploMin) ploMin = pl; if (pl > ploMax) ploMax = pl; }
      }
      const rms = cnt > 0 ? Math.sqrt(sum2 / cnt) : 0;
      return {
        rms: +rms.toPrecision(6), maxSpd: +maxSpd.toPrecision(5), nan, wetN,
        tloRange: +(tloMax - tloMin).toPrecision(4),
        ploRange: +(ploMax - ploMin).toPrecision(4),
      };
    }

    const runs = [];
    const glErrors = [];
    for (const advect of ADV) {
      for (const dt of DTS) {
        planet.params.dt = dt;
        planet.params.airAdvect = advect;
        planet.params.airCourantMax = 0.5;
        Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });
        planet.reset();                       // re-seed identical IC
        const N = Math.max(1, Math.round(TIME / dt));
        const t0 = performance.now();
        for (let i = 0; i < N; i++) planet.step();
        gl.finish();
        const ms = performance.now() - t0;
        const eLoop = glErr('post-loop dt=' + dt + ' advect=' + advect);
        if (eLoop) glErrors.push(eLoop);
        const st = airStats();
        const e = glErr('post-run dt=' + dt + ' advect=' + advect);
        if (e) glErrors.push(e);
        runs.push({
          advect, dt, steps: N, simTime: +planet.simTime.toFixed(1),
          ms: +ms.toFixed(1), msPerStep: +(ms / N).toFixed(4),
          rmsWind: st.rms, maxWind: st.maxSpd, nan: st.nan, wetN: st.wetN,
          tloRange: st.tloRange, ploRange: st.ploRange,
        });
      }
    }

    // ---- bias analysis ------------------------------------------------------
    function spreadFor(a) {
      const rs = runs.filter(r => r.advect === a).map(r => r.rmsWind).filter(x => isFinite(x) && x > 0);
      if (rs.length < 2) return null;
      const mn = Math.min(...rs), mx = Math.max(...rs), mean = rs.reduce((s, x) => s + x, 0) / rs.length;
      return { min: mn, max: mx, mean, relSpread: (mx - mn) / mean };
    }
    const fv = spreadFor(0), sl = spreadFor(1);

    return {
      level: LEVEL, V, wetN,
      time: TIME,
      runs,
      fvSpread: fv, slSpread: sl,
      glErrors,
    };
  }, LEVEL, TIME, DTS, ADV, TOL, PATCH);

  await browser.close();

  // ---- console report ------------------------------------------------------
  console.log('\n=== AIR dt-sweep ===');
  console.log('level', result.level, ' V', result.V, ' wet', result.wetN, ' T(sim)=', result.time, 's');
  const dts = [...new Set(result.runs.map(r => r.dt))].sort((a, b) => a - b);
  for (const advect of ADV) {
    console.log('\n--- airAdvect=' + advect + ' (FV=' + (advect === 0 ? 'default' : 'opt-in SL') + ') ---');
    console.log('  dt     steps    rmsWind   maxWind   PlRange   TlRange    ms/step');
    result.runs.filter(r => r.advect === advect).forEach(r => {
      console.log('  ' + String(r.dt).padEnd(6) + String(r.steps).padEnd(8) +
        String(r.rmsWind).padEnd(10) + String(r.maxWind).padEnd(10) +
        String(r.ploRange).padEnd(10) + String(r.tloRange).padEnd(10) + r.msPerStep);
    });
    const sp = advect === 0 ? result.fvSpread : result.slSpread;
    if (sp) console.log('  relSpread=' + (sp.relSpread * 100).toFixed(1) + '%  (rms ' +
      sp.min + '..' + sp.max + ', mean ' + sp.mean + ')');
  }
  if (result.glErrors && result.glErrors.length) {
    console.log('\nGL ERRORS:'); result.glErrors.forEach(e => console.log('  ' + e));
  }

  // ---- pass/fail -----------------------------------------------------------
  result.shaderLogs = logs.filter(l => /compile|link|error/i.test(l)).slice(0, 40);
  let pass = true;
  const reasons = [];
  if (result.fatal) { pass = false; reasons.push('fatal: ' + result.fatal); }
  if (result.glErrors && result.glErrors.length) { pass = false; reasons.push('GL errors'); }
  if (result.shaderLogs && result.shaderLogs.length) { pass = false; reasons.push('shader compile/link errors'); }
  const anyNan = result.runs.some(r => r.nan > 0);
  if (anyNan) { pass = false; reasons.push('NaN wind detected'); }
  const fv = result.fvSpread;
  // FV must be dt-flat within tolerance. SL must at least be stable (finite).
  if ( fv && fv.relSpread > TOL) { pass = false; reasons.push('FV wind not dt-flat (relSpread ' + (fv.relSpread * 100).toFixed(1) + '% > ' + (TOL * 100) + '%)'); }
  const sl = result.slSpread;
  if (sl) {
    const unstable = result.runs.filter(r => r.advect === 1).some(r => !isFinite(r.rmsWind) || r.maxWind > 1e3 || r.nan > 0);
    if (unstable) { pass = false; reasons.push('SL path unstable'); }
  }

  const out = Object.assign({ pass, tolerance: TOL, reasons }, result);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('\nRESULT: ' + (pass ? 'PASS' : 'FAIL') + (reasons.length ? '  (' + reasons.join('; ') + ')' : ''));
  console.log('(full JSON' + (OUT ? ' written to ' + OUT : ' available via --out') + ')');
  process.exit(pass ? 0 : (result.fatal || (result.shaderLogs || []).length ? 2 : 1));
})().catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
