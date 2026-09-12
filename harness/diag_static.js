/* diag_static.js — measure whether the velocity field actually MOVES over time
 * for a loaded saved state, and whether it responds to dt / Coriolis / scheme.
 *
 *   node diag_static.js [--dir=../planet] --steps=400
 */
const puppeteer = require('puppeteer');
const { launchBrowser } = require('./chrome-launch');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const DIR = path.resolve(arg('dir', path.join(__dirname, '..', 'planet')));
const SAVE = arg('save', path.join(DIR, 'planet_state.js'));
const STEPS = parseInt(arg('steps', '400'), 10);

(async () => {
  const browser = await launchBrowser(puppeteer, { protocolTimeout: 600000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await page.setContent('<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas></body></html>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  const PATCH = JSON.parse(arg('params', '{}'));

  const res = await page.evaluate(async (txt, STEPS, PATCH) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const enc = readPlanetStateJS(txt);
    const planet = new Planet(document.getElementById('c'), enc.level);
    const gl = planet.gl;
    while (gl.getError() !== gl.NO_ERROR) {}
    planet.applyState(decodePlanetState(enc));
    Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });

    function snap() {
      // return copy of air + ocean velocity fields (live cells)
      const la = Float32Array.from(planet.readTex(planet.A[4]));
      const ha = Float32Array.from(planet.readTex(planet.A[6]));
      const ot = Float32Array.from(planet.readTex(planet.A[1]));
      const od = Float32Array.from(planet.readTex(planet.A[3]));
      const cellB = planet.readTex(planet.texCellB);
      return { la, ha, ot, od, cellB };
    }
    function rmsVel(s) {
      const V = planet.grid.V;
      let sum = 0, cnt = 0;
      for (let c = 0; c < V; c++) {
        if (s.cellB[c * 4 + 3] >= 0.5) continue;
        sum += s.la[c*4]*s.la[c*4] + s.la[c*4+1]*s.la[c*4+1];
        sum += s.ha[c*4]*s.ha[c*4] + s.ha[c*4+1]*s.ha[c*4+1];
        sum += s.ot[c*4]*s.ot[c*4] + s.ot[c*4+1]*s.ot[c*4+1];
        sum += s.od[c*4]*s.od[c*4] + s.od[c*4+1]*s.od[c*4+1];
        cnt += 4;
      }
      return cnt > 0 ? Math.sqrt(sum / cnt) : 0;
    }
    function diffRMS(a, b) {
      const V = planet.grid.V;
      let sum = 0, cnt = 0, maxd = 0;
      for (let c = 0; c < V; c++) {
        if (a.cellB[c * 4 + 3] >= 0.5) continue;
        for (const key of ['la','ha','ot','od']) {
          let d = a[key][c*4] - b[key][c*4];
          sum += d*d; if (Math.abs(d) > maxd) maxd = Math.abs(d);
          d = a[key][c*4+1] - b[key][c*4+1];
          sum += d*d; if (Math.abs(d) > maxd) maxd = Math.abs(d);
          cnt += 2;
        }
      }
      return { rms: cnt > 0 ? Math.sqrt(sum / cnt) : 0, maxd };
    }

    const s0 = snap();
    for (let i = 0; i < STEPS; i++) planet.step();
    const s1 = snap();
    return {
      P: { dt: planet.params.dt, omegaSpin: planet.params.omegaSpin, oceanScheme: planet.params.oceanScheme, omegaOrbit: planet.params.omegaOrbit },
      rmsVel0: +rmsVel(s0).toPrecision(6),
      rmsVel1: +rmsVel(s1).toPrecision(6),
      diff: diffRMS(s0, s1),
      simTimeDays: +(planet.simTime / 86400).toPrecision(6),
    };
  }, fs.readFileSync(SAVE, 'utf8'), STEPS, PATCH);

  await browser.close();
  console.log('PATCH', JSON.stringify(PATCH));
  console.log('  params', JSON.stringify(res.P));
  console.log('  rmsVel start=' + res.rmsVel0 + '  after=' + res.rmsVel1);
  console.log('  field-change over ' + STEPS + ' steps (dt=' + res.P.dt + '): rms=' + res.diff.rms.toPrecision(5) + '  maxCell=' + res.diff.maxd.toPrecision(5));
  console.log('  simTime ' + res.simTimeDays + ' days');
  if (errs.length) console.log('  PAGE ERRORS:', errs);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
