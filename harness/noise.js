/* noise.js -- quantify grid-scale (2dx) noise and where it lives.

   For every wet cell we form the 1-ring roughness
       r(c) = x(c) - mean_j x(j)
   which is exactly the discrete high-pass / checkerboard detector: a smooth
   field gives r ~ 0, a cell-to-cell alternating mode gives |r| ~ amplitude.
   We report RMS(r) globally and binned by |latitude|, for h_top, speed and
   eta, plus the smooth-field magnitude for scale.

   usage: node noise.js --level=5 --steps=500 [--params='{...}'] [--series]
*/
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const DIR = path.resolve(arg('dir', '/home/user/project'));
const LEVEL = parseInt(arg('level', '5'), 10);
const STEPS = parseInt(arg('steps', '500'), 10);
const PATCH = JSON.parse(arg('params', '{}'));
const SERIES = process.argv.includes('--series');
// --marks=0,100,200,...  custom sampling points for the series
const MARKS_ARG = (process.argv.find(a => a.startsWith('--marks=')) || '').split('=')[1];
const MARKS = MARKS_ARG ? MARKS_ARG.split(',').map(Number) : null;
const OUT = arg('out', '');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
           '--use-angle=swiftshader', '--disable-gpu-sandbox',
           '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
    protocolTimeout: 0,   // long step loops run inside one evaluate() call
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  page.setDefaultTimeout(0);
  const res = await page.evaluate(async (LEVEL, STEPS, PATCH, SERIES, MARKS) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    const planet = new Planet(document.getElementById('c'), LEVEL);
    Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });
    if ('seed' in planet.params) planet.params.seed = 12345;
    planet.build(LEVEL);
    planet._rng = null;
    if (planet.seedRand) planet.seedRand = () => 0.5;
    planet.reset();

    const gl = planet.gl;
    const W = planet.grid.W, H = planet.grid.H, V = planet.grid.V;
    const fbo = gl.createFramebuffer();
    const read = (tex) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const b = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, b);
      return b;
    };
    const cellA = read(planet.texCellA);
    const cellB = read(planet.texCellB);
    const cellC = planet.texCellC ? read(planet.texCellC) : null;
    const nbrA = planet.grid.nbrA;

    // latitude from the cell normal (y is the spin axis in this code)
    const lat = new Float64Array(V);
    for (let c = 0; c < V; c++) {
      const x = cellA[c*4], y = cellA[c*4+1], z = cellA[c*4+2];
      const r = Math.hypot(x, y, z) || 1;
      lat[c] = Math.asin(Math.max(-1, Math.min(1, y / r))) * 180 / Math.PI;
    }

    function measure() {
      const topS = read(planet.A[0]);
      const topV = read(planet.A[1]);
      // bins of 15 deg in |lat|
      const NB = 6;
      const acc = [];
      for (let b = 0; b < NB; b++) acc.push({ n:0, h2:0, s2:0, e2:0, hmag:0, smag:0 });
      let gh = 0, gs = 0, ge = 0, n = 0;
      let worst = { r: 0, lat: 0 };
      let ge2 = 0, gemax = 0, gsmax = 0, gspd2 = 0, nAll = 0;
      for (let c = 0; c < V; c++) {
        if (cellB[c*4+3] > 0.5) continue;           // skip land
        const D = cellC ? cellC[c*4] : planet.params.hTotal;
        const hRef = cellC ? cellC[c*4+1] : planet.params.hTop;
        let sh = 0, su = 0, sv = 0, se = 0, k2 = 0, allWet = true;
        for (let k = 0; k < 6; k++) {
          const base = (c + k*W*H)*4;
          if (nbrA[base+3] < 0.5) continue;
          const j = nbrA[base] | 0;
          if (cellB[j*4+3] > 0.5) { allWet = false; break; }
          sh += topS[j*4]; su += topV[j*4]; sv += topV[j*4+1];
          se += topS[j*4] - (cellC ? cellC[j*4+1] : hRef);
          k2++;
        }
        {   // global (all wet cells) amplitude, independent of the interior filter
          const eG = topS[c*4] - hRef;
          const sG = Math.hypot(topV[c*4], topV[c*4+1]);
          ge2 += eG*eG; gspd2 += sG*sG; nAll++;
          if (Math.abs(eG) > gemax) gemax = Math.abs(eG);
          if (sG > gsmax) gsmax = sG;
        }
        if (!allWet || k2 === 0) continue;          // interior cells only
        const rh = topS[c*4] - sh/k2;
        const ru = topV[c*4] - su/k2, rv = topV[c*4+1] - sv/k2;
        const rs = Math.hypot(ru, rv);
        const re = (topS[c*4] - hRef) - se/k2;
        const spd = Math.hypot(topV[c*4], topV[c*4+1]);
        const al = Math.abs(lat[c]);
        const b = Math.min(5, Math.floor(al/15));
        const a = acc[b];
        a.n++; a.h2 += rh*rh; a.s2 += rs*rs; a.e2 += re*re;
        a.hmag += Math.abs(topS[c*4]-hRef); a.smag += spd;
        gh += rh*rh; gs += rs*rs; ge += re*re; n++;
        if (Math.abs(rh) > worst.r) worst = { r: Math.abs(rh), lat: +lat[c].toFixed(1) };
      }
      const bins = acc.map((a,i) => ({
        lat: (i*15) + '-' + (i*15+15),
        n: a.n,
        rmsH: a.n ? +Math.sqrt(a.h2/a.n).toPrecision(4) : 0,
        rmsSpd: a.n ? +Math.sqrt(a.s2/a.n).toPrecision(4) : 0,
        meanEtaMag: a.n ? +(a.hmag/a.n).toPrecision(4) : 0,
        meanSpd: a.n ? +(a.smag/a.n).toPrecision(4) : 0,
      }));
      return {
        n,
        rmsH: +Math.sqrt(gh/n).toPrecision(4),
        rmsSpd: +Math.sqrt(gs/n).toPrecision(4),
        rmsEta: +Math.sqrt(ge/n).toPrecision(4),
        // global amplitude over every wet cell: this is what "waves on the
        // whole map" shows up in, and it is NOT a high-pass residual.
        gRmsEta: nAll ? +Math.sqrt(ge2/nAll).toPrecision(4) : 0,
        gMaxEta: +gemax.toPrecision(4),
        gRmsSpd: nAll ? +Math.sqrt(gspd2/nAll).toPrecision(4) : 0,
        gMaxSpd: +gsmax.toPrecision(4),
        worst, bins,
      };
    }

    const series = [];
    if (SERIES) {
      const marks = MARKS || [0, 50, 100, 200, 400, 800, 1600, 3200];
      let done = 0;
      for (const m of marks) {
        if (m > STEPS) break;
        while (done < m) { planet.step(); done++; }
        const s = measure();
        series.push({ step: m, rmsH: s.rmsH, rmsSpd: s.rmsSpd,
                      polar: s.bins[5].rmsH, equat: s.bins[0].rmsH,
                      gRmsEta: s.gRmsEta, gMaxEta: s.gMaxEta,
                      gRmsSpd: s.gRmsSpd, gMaxSpd: s.gMaxSpd });
      }
      while (done < STEPS) { planet.step(); done++; }
    } else {
      for (let i = 0; i < STEPS; i++) planet.step();
    }
    const final = measure();
    return { series, final, dt: planet.params.dt, spacingKm: null };
  }, LEVEL, STEPS, PATCH, SERIES, MARKS);

  const out = { level: LEVEL, steps: STEPS, params: PATCH, ...res, errors: logs };
  console.log(JSON.stringify(out, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  await browser.close();
})();
