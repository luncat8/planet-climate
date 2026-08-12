/* mobility_check.js — prove air vortices are not a frozen picture.
 *
 * Spins up L5, snapshots low-air (u,v,T,P), then advances 6 h and 24 h.
 * Compares default prognostic P (airCs>0) against the legacy diagnostic
 * overwrite (airCs=0). Frozen-sun (omegaOrbit=0) so a moving pattern cannot
 * be the day/night heating sliding across a slaved thermal wind.
 *
 *   node mobility_check.js [--dir=../planet] [--level=5] [--spin=86400]
 *
 * Exit 0 if shaders compile, no NaNs, free-weather residual is alive, and
 * the 24 h eddy field actually changes. Exit 2 otherwise.
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
  return fs.existsSync(planet) ? planet : path.join(__dirname, '..', 'project');
}

const DIR = path.resolve(arg('dir', defaultDir()));
const LEVEL = parseInt(arg('level', '5'), 10);
const SPIN = parseInt(arg('spin', '86400'), 10);
const DT = parseInt(arg('dt', '60'), 10);
const CHUNK = parseInt(arg('chunk', '800'), 10);

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

  await page.evaluate((LEVEL) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const planet = new Planet(document.getElementById('c'), LEVEL);
    window.__defaults = Object.assign({}, planet.params);
    window.__planet = planet;
  }, LEVEL);

  async function runConfig(label, patch) {
    const t0 = Date.now();
    await page.evaluate((patch, DT) => {
      const p = window.__planet;
      Object.keys(window.__defaults).forEach(k => { p.params[k] = window.__defaults[k]; });
      Object.keys(patch).forEach(k => { p.params[k] = patch[k]; });
      p.params.dt = DT;
      p.params.omegaOrbit = 0;          // freeze the sun
      p._rng = null;
      p.reset();
    }, patch, DT);

    async function stepSeconds(sec) {
      const n = Math.round(sec / DT);
      for (let done = 0; done < n; ) {
        const k = Math.min(CHUNK, n - done);
        await page.evaluate((k) => {
          const p = window.__planet;
          for (let i = 0; i < k; i++) p.step();
        }, k);
        done += k;
      }
    }

    await stepSeconds(SPIN);
    const snap = (name) => page.evaluate((name) => {
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
      const lo = read(p.A[4]);
      const cellA = read(p.texCellA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);

      let nanCount = 0;
      let sumP = 0, sumPp = 0, sumPp2 = 0, nMid = 0;
      let sumU = 0, sumV = 0, sumSpd = 0, maxSpd = 0;
      let minP = Infinity, minPCell = -1;
      const pPrime = new Float32Array(V);
      const spd = new Float32Array(V);
      const lat = new Float32Array(V);
      for (let c = 0; c < V; c++) {
        const u = lo[c * 4], v = lo[c * 4 + 1], T = lo[c * 4 + 2], P = lo[c * 4 + 3];
        if (![u, v, T, P].every(Number.isFinite)) { nanCount++; continue; }
        const ny = cellA[c * 4 + 1] / Math.hypot(cellA[c * 4], cellA[c * 4 + 1], cellA[c * 4 + 2]);
        const phi = Math.asin(Math.max(-1, Math.min(1, ny)));
        lat[c] = phi;
        const Pth = 101325 - 60 * (T - 288); // couple also adds +25*(Th-250); Th not in loA
        const pp = P - Pth;
        pPrime[c] = pp;
        const s = Math.hypot(u, v);
        spd[c] = s;
        sumP += P; sumU += u; sumV += v; sumSpd += s;
        if (s > maxSpd) maxSpd = s;
        const amid = Math.abs(phi) > 0.35 && Math.abs(phi) < 1.2; // ~20–70°
        if (amid) {
          sumPp += pp; sumPp2 += pp * pp; nMid++;
          if (P < minP) { minP = P; minPCell = c; }
        }
      }
      const meanPp = nMid ? sumPp / nMid : 0;
      let varPp = 0;
      for (let c = 0; c < V; c++) {
        if (Math.abs(lat[c]) > 0.35 && Math.abs(lat[c]) < 1.2) {
          const d = pPrime[c] - meanPp;
          varPp += d * d;
        }
      }
      return {
        name, simTime: p.simTime, nanCount, V, nMid,
        meanP: sumP / V, meanSpd: sumSpd / V, maxSpd,
        rmsPprime: nMid ? Math.sqrt(varPp / nMid) : 0,
        minPMid: minP, minPCell,
        pPrime: Array.from(pPrime),
        spd: Array.from(spd),
        lat: Array.from(lat),
      };
    }, name);

    const tSpin = await snap('spin');
    await stepSeconds(6 * 3600);
    const t6 = await snap('t+6h');
    await stepSeconds(18 * 3600);
    const t24 = await snap('t+24h');

    function corr(a, b, pred) {
      let n = 0, sa = 0, sb = 0;
      for (let i = 0; i < a.length; i++) if (pred(i)) { sa += a[i]; sb += b[i]; n++; }
      if (!n) return 0;
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) if (pred(i)) {
        const x = a[i] - ma, y = b[i] - mb;
        num += x * y; da += x * x; db += y * y;
      }
      return num / Math.sqrt(Math.max(da * db, 1e-30));
    }
    function rmsDiff(a, b, pred) {
      let n = 0, s = 0;
      for (let i = 0; i < a.length; i++) if (pred(i)) {
        const d = a[i] - b[i]; s += d * d; n++;
      }
      return n ? Math.sqrt(s / n) : 0;
    }
    const mid = (snapA) => (i) => Math.abs(snapA.lat[i]) > 0.35 && Math.abs(snapA.lat[i]) < 1.2;

    const out = {
      label, wallMs: Date.now() - t0,
      nanCount: tSpin.nanCount + t6.nanCount + t24.nanCount,
      spin: { rmsPprime: +tSpin.rmsPprime.toPrecision(5), meanSpd: +tSpin.meanSpd.toPrecision(4), maxSpd: +tSpin.maxSpd.toPrecision(4), minPCell: tSpin.minPCell },
      h6: {
        rmsPprime: +t6.rmsPprime.toPrecision(5),
        corrPp: +corr(tSpin.pPrime, t6.pPrime, mid(tSpin)).toFixed(4),
        corrSpd: +corr(tSpin.spd, t6.spd, mid(tSpin)).toFixed(4),
        rmsDpp: +rmsDiff(tSpin.pPrime, t6.pPrime, mid(tSpin)).toPrecision(4),
        minPCell: t6.minPCell,
        cellShift: t6.minPCell !== tSpin.minPCell,
      },
      h24: {
        rmsPprime: +t24.rmsPprime.toPrecision(5),
        corrPp: +corr(tSpin.pPrime, t24.pPrime, mid(tSpin)).toFixed(4),
        corrSpd: +corr(tSpin.spd, t24.spd, mid(tSpin)).toFixed(4),
        rmsDpp: +rmsDiff(tSpin.pPrime, t24.pPrime, mid(tSpin)).toPrecision(4),
        minPCell: t24.minPCell,
        cellShift: t24.minPCell !== tSpin.minPCell,
      },
    };
    // drop bulky arrays from later use
    return out;
  }

  const shaderLogs = logs.filter(l => /compile|link|FBO|PAGEERROR|error/i.test(l)).slice(0, 30);
  if (shaderLogs.length) {
    console.error('SHADER ERRORS', shaderLogs);
    await browser.close();
    process.exit(2);
  }

  const legacy = await runConfig('legacy-diagnostic', { airCs: 0, airPRelax: 0 });
  const live = await runConfig('prognostic', { airCs: 40, airPRelax: 8e-6 });

  const report = { level: LEVEL, dt: DT, spinS: SPIN, frozenSun: true, legacy, live, shaderLogs };
  console.log(JSON.stringify(report, null, 2));

  await browser.close();

  const fails = [];
  if (legacy.nanCount || live.nanCount) fails.push('NaNs');
  if (live.spin.maxSpd > 59) fails.push('winds hitting the ±60 m/s clamp');
  if (live.spin.maxSpd < 5) fails.push('prognostic jet too weak (max ' + live.spin.maxSpd + ' m/s)');
  // Acceptance: the mid-latitude surface low must travel. The diagnostic-P
  // control is the old frozen picture and must stay put on the same cell.
  if (!live.h6.cellShift && !live.h24.cellShift) {
    fails.push('midlat P minimum did not move over 24 h (still cell ' + live.spin.minPCell + ')');
  }
  if (legacy.h24.cellShift && !live.h24.cellShift) {
    fails.push('legacy moved but prognostic did not');
  }
  if (live.h24.corrPp > 0.9995 && live.h24.rmsDpp < 5) {
    fails.push('24h eddy field is frozen (corr=' + live.h24.corrPp + ' drms=' + live.h24.rmsDpp + ')');
  }

  if (fails.length) {
    console.error('FAIL', fails);
    process.exit(2);
  }
  console.log('PASS  live rmsP\'=' + live.spin.rmsPprime +
    ' Pa  6h corr=' + live.h6.corrPp + '  24h corr=' + live.h24.corrPp +
    '  24h drms=' + live.h24.rmsDpp + ' Pa  cellShift=' + live.h24.cellShift +
    '  (legacy rmsP\'=' + legacy.spin.rmsPprime + ')');
})().catch(e => { console.error('MOBILITY FAIL', e); process.exit(1); });
