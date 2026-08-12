/* dti_check.js — air dt-independence regression.
 *
 * Runs the same physical time at several timesteps and asserts that the
 * surface / upper-air wind extrema stay within a ratio tolerance.
 *
 *   node dti_check.js [--dir=../planet] [--level=5] [--simt=259200]
 *                     [--dts=10,30,60,120,300] [--tol=1.3]
 *                     [--params='{"bathyMode":1}'] [--air-advect=0]
 *                     [--quick]
 *
 * --quick  → 1-day SIMT and dts=10,60,300 (sandbox-friendly).
 *
 * Exit 0 if both loA and hiA component-extrema ratios are ≤ tol.
 * Exit 2 if a ratio exceeds tol or a run produced NaNs / a fatal error.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function defaultDir() {
  const planet = path.join(__dirname, '..', 'planet');
  const project = path.join(__dirname, '..', 'project');
  return fs.existsSync(planet) ? planet : project;
}

const QUICK = process.argv.includes('--quick');
const DIR = path.resolve(arg('dir', defaultDir()));
const LEVEL = parseInt(arg('level', '5'), 10);
const SIMT = parseInt(arg('simt', QUICK ? '86400' : '259200'), 10);
const DTS = (arg('dts', QUICK ? '10,60,300' : '10,30,60,120,300'))
  .split(',').map(Number).filter(x => x > 0);
const TOL = parseFloat(arg('tol', '1.3'));
const PATCH = JSON.parse(arg('params', '{}'));
if (process.argv.find(a => a.startsWith('--air-advect='))) {
  PATCH.airAdvect = parseInt(arg('air-advect', '0'), 10);
}
const CHUNK = parseInt(arg('chunk', '800'), 10);
const SEED = 12345;

function compMax(s) {
  return Math.max(Math.abs(s.min[0]), Math.abs(s.max[0]),
                  Math.abs(s.min[1]), Math.abs(s.max[1]));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 0,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
           '--use-angle=swiftshader', '--disable-gpu-sandbox', '--enable-webgl',
           '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));

  await page.setContent('<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas></body></html>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  await page.evaluate((LEVEL, PATCH, SEED) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const planet = new Planet(document.getElementById('c'), LEVEL);
    Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });
    if ('seed' in planet.params) planet.params.seed = SEED;
    planet.build(LEVEL);
    planet._rng = null;
    window.__planet = planet;
  }, LEVEL, PATCH, SEED);

  const rows = [];
  for (const dt of DTS) {
    const steps = Math.round(SIMT / dt);
    const t0 = Date.now();
    await page.evaluate((dt, PATCH) => {
      const p = window.__planet;
      Object.keys(PATCH).forEach(k => { p.params[k] = PATCH[k]; });
      p.params.dt = dt;
      p._rng = null;
      p.reset();
    }, dt, PATCH);

    for (let done = 0; done < steps; ) {
      const n = Math.min(CHUNK, steps - done);
      await page.evaluate((n) => {
        const p = window.__planet;
        for (let i = 0; i < n; i++) p.step();
      }, n);
      done += n;
    }

    const stats = await page.evaluate(() => {
      const p = window.__planet, gl = p.gl;
      gl.finish();
      const W = p.grid.W, H = p.grid.H, V = p.grid.V;
      const fbo = gl.createFramebuffer();
      function read(tex) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const buf = new Float32Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
        return buf;
      }
      function ext(a) {
        const mn = [Infinity, Infinity, Infinity, Infinity];
        const mx = [-Infinity, -Infinity, -Infinity, -Infinity];
        let maxSpd = 0, nanCount = 0;
        for (let c = 0; c < V; c++) {
          for (let k = 0; k < 4; k++) {
            const v = a[c * 4 + k];
            if (!isFinite(v)) { nanCount++; continue; }
            if (v < mn[k]) mn[k] = v;
            if (v > mx[k]) mx[k] = v;
          }
          const s = Math.hypot(a[c * 4], a[c * 4 + 1]);
          if (s > maxSpd) maxSpd = s;
        }
        return {
          min: mn.slice(0, 2), max: mx.slice(0, 2),
          maxSpd, nanCount,
        };
      }
      const lo = ext(read(p.A[4]));
      const hi = ext(read(p.A[6]));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      return { lo, hi, simTime: p.simTime };
    });

    const loComp = compMax(stats.lo);
    const hiComp = compMax(stats.hi);
    const row = {
      dt, steps, wallMs: Date.now() - t0, simTime: stats.simTime,
      loA: { comp: +loComp.toPrecision(6), maxSpd: +stats.lo.maxSpd.toPrecision(6) },
      hiA: { comp: +hiComp.toPrecision(6), maxSpd: +stats.hi.maxSpd.toPrecision(6) },
      nanCount: stats.lo.nanCount + stats.hi.nanCount,
    };
    rows.push(row);
    console.log(
      '  dt=' + String(dt).padStart(4) +
      ' steps=' + String(steps).padStart(6) +
      '  loA ' + row.loA.comp.toFixed(3) + ' (spd ' + row.loA.maxSpd.toFixed(3) + ')' +
      '  hiA ' + row.hiA.comp.toFixed(3) + ' (spd ' + row.hiA.maxSpd.toFixed(3) + ')' +
      '  ' + (row.wallMs / 1000).toFixed(1) + 's'
    );
  }

  const shaderLogs = logs.filter(l => /compile|link|FBO|PAGEERROR|error/i.test(l)).slice(0, 20);
  function ratioOf(key, field) {
    const vs = rows.map(r => r[key][field]);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    return { lo, hi, ratio: hi / Math.max(lo, 1e-12) };
  }
  const loR = ratioOf('loA', 'comp');
  const hiR = ratioOf('hiA', 'comp');
  const loS = ratioOf('loA', 'maxSpd');
  const hiS = ratioOf('hiA', 'maxSpd');
  const nans = rows.reduce((s, r) => s + r.nanCount, 0);

  const report = {
    simt: SIMT, level: LEVEL, dts: DTS, tol: TOL,
    airAdvect: PATCH.airAdvect === undefined ? 0 : PATCH.airAdvect,
    rows,
    ratio: {
      loA_comp: +loR.ratio.toFixed(4),
      hiA_comp: +hiR.ratio.toFixed(4),
      loA_spd: +loS.ratio.toFixed(4),
      hiA_spd: +hiS.ratio.toFixed(4),
    },
    nanCount: nans,
    shaderLogs,
  };
  console.log(JSON.stringify({ ratio: report.ratio, tol: TOL, nanCount: nans }, null, 2));

  await browser.close();

  const fail = nans > 0 || shaderLogs.length > 0 ||
    loR.ratio > TOL || hiR.ratio > TOL;
  if (fail) {
    if (loR.ratio > TOL) console.error('FAIL loA comp ratio ' + loR.ratio.toFixed(3) + ' > ' + TOL);
    if (hiR.ratio > TOL) console.error('FAIL hiA comp ratio ' + hiR.ratio.toFixed(3) + ' > ' + TOL);
    if (nans) console.error('FAIL nanCount ' + nans);
    if (shaderLogs.length) console.error('FAIL shaderLogs', shaderLogs);
    process.exit(2);
  }
  console.log('PASS  loA ' + loR.ratio.toFixed(3) + '×  hiA ' + hiR.ratio.toFixed(3) + '×  (tol ' + TOL + ')');
})().catch(e => { console.error('DTI FAIL', e); process.exit(1); });
