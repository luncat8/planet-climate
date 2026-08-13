/* loadsave_test.js — verify the save/load workflow used by the app UI and by
 * tests: load a pre-equilibrated .js state file and confirm the sim starts
 * already evolved (no 20-day wait) and keeps evolving.
 *
 * The .js file is `window.PLANET_STATE = {...}` so it loads via a plain
 * <script> tag (works from file://). Here we read it as text and run it through
 * readPlanetStateJS() (defined in engine.js) — the same path the app uses.
 *
 *   node loadsave_test.js --dir=/media/sf_1/planet242/planet \
 *        --save=/media/sf_1/planet242/harness/saves/equilibrium_L5.js
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const DIR = arg('dir', '/media/sf_1/planet242/planet');
const SAVE = arg('save', path.resolve(__dirname, 'saves', 'equilibrium_L5.js'));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
           '--use-angle=swiftshader', '--disable-gpu-sandbox', '--enable-webgl',
           '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await page.setContent('<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas></body></html>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  const res = await page.evaluate(async (txt) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const enc = readPlanetStateJS(txt);   // same as <script src="planet_state.js"> + window.PLANET_STATE
    const planet = new Planet(document.getElementById('c'), enc.level);
    const gl = planet.gl;
    while (gl.getError() !== gl.NO_ERROR) {}

    function airRMS() {
      const la = planet.readTex(planet.A[4]), ha = planet.readTex(planet.A[6]);
      const V = planet.grid.V, cellB = planet.readTex(planet.texCellB);
      let sum = 0, cnt = 0, nan = 0;
      for (let c = 0; c < V; c++) {
        if (cellB[c * 4 + 3] >= 0.5) continue;
        for (const a of [la, ha]) {
          const u = a[c * 4], v = a[c * 4 + 1];
          if (!isFinite(u) || !isFinite(v)) { nan++; continue; }
          sum += u * u + v * v; cnt++;
        }
      }
      return { rms: cnt > 0 ? Math.sqrt(sum / cnt) : 0, nan };
    }

    // Load the saved state instead of waiting for equilibrium.
    planet.applyState(decodePlanetState(enc));
    const loaded = airRMS();

    // Continue the simulation a little and confirm it keeps evolving.
    for (let i = 0; i < 200; i++) planet.step();
    const after = airRMS();

    return {
      level: enc.level, simTimeDays: +(planet.simTime / 86400).toFixed(2),
      loadedRMS: +loaded.rms.toPrecision(5), loadedNaN: loaded.nan,
      afterRMS: +after.rms.toPrecision(5), afterNaN: after.nan,
    };
  }, fs.readFileSync(SAVE, 'utf8'));

  await browser.close();

  console.log('loaded save', SAVE);
  console.log('  level', res.level, ' simTime', res.simTimeDays, 'days');
  console.log('  air rms wind  loaded=' + res.loadedRMS + ' (no wait)   after +200 steps=' + res.afterRMS);
  console.log('  NaN  loaded=' + res.loadedNaN + '  after=' + res.afterNaN);
  const ok = res.loadedNaN === 0 && res.afterNaN === 0 && res.loadedRMS > 1.0 && isFinite(res.afterRMS);
  console.log('RESULT: ' + (ok ? 'PASS' : 'FAIL'));
  if (errs.length) console.log('  PAGE ERRORS:', errs);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('LOADSAVE TEST FAIL', e); process.exit(1); });
