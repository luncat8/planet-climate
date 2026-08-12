/* mksave.js — generate a pre-equilibrated simulation state and write it to a
 * .sav file (JSON: params + 8 base64-encoded float textures).
 *
 * Purpose: let tests (and the app's Import button) start from a state that has
 * already run for many simulated days, instead of waiting for the sim to reach
 * equilibrium every time.
 *
 *   node mksave.js --dir=/media/sf_1/planet242/planet --level=5 --days=20 \
 *                  --out=/media/sf_1/planet242/harness/saves/equilibrium_L5.sav
 *
 * The page context builds the Planet, runs `days` of simulated time, serializes
 * + encodes the state, then round-trips it (decode+apply) to prove the codec
 * works before the file is written.
 */
const puppeteer = require('/media/sf_1/planet242/harness/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const DIR = arg('dir', '/media/sf_1/planet242/planet');
const LEVEL = parseInt(arg('level', '5'), 10);
const DAYS = parseFloat(arg('days', '20'));
const OUT = arg('out', path.resolve(__dirname, 'saves', 'equilibrium_L' + LEVEL + '.sav'));

(async () => {
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    if (!fs.existsSync(path.join(DIR, f))) throw new Error('missing engine source ' + f);
  }
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

  const res = await page.evaluate(async (LEVEL, DAYS) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const planet = new Planet(document.getElementById('c'), LEVEL);
    const gl = planet.gl;
    while (gl.getError() !== gl.NO_ERROR) {}

    function airRMS() {
      const la = planet.readTex(planet.A[4]), ha = planet.readTex(planet.A[6]);
      const V = planet.grid.V, cellB = planet.readTex(planet.texCellB);
      let sum = 0, cnt = 0;
      for (let c = 0; c < V; c++) {
        if (cellB[c * 4 + 3] >= 0.5) continue; // skip land
        for (const a of [la, ha]) {
          const u = a[c * 4], v = a[c * 4 + 1];
          if (!isFinite(u) || !isFinite(v)) continue;
          sum += u * u + v * v; cnt++;
        }
      }
      return cnt > 0 ? Math.sqrt(sum / cnt) : 0;
    }

    const N = Math.round(DAYS * 86400 / planet.params.dt);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) planet.step();
    const ms = performance.now() - t0;

    const rmsBefore = airRMS();
    const enc = encodePlanetState(planet.serializeState());

    // round-trip: decode + apply back, confirm state survives the codec
    const st = decodePlanetState(enc);
    planet.applyState(st);
    const rmsAfter = airRMS();

    return { level: LEVEL, days: DAYS, steps: N, msPerStep: +(ms / N).toFixed(4),
             rmsBefore: +rmsBefore.toPrecision(5), rmsAfter: +rmsAfter.toPrecision(5), enc };
  }, LEVEL, DAYS);

  await browser.close();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res.enc));

  console.log('generated', OUT);
  console.log('  level', res.level, 'days', res.days, 'steps', res.steps, 'ms/step', res.msPerStep);
  console.log('  air rms wind  before=' + res.rmsBefore + '  after round-trip=' + res.rmsAfter);
  console.log('  file size', (fs.statSync(OUT).size / 1e6).toFixed(2), 'MB');
  if (Math.abs(res.rmsBefore - res.rmsAfter) > 1e-3)
    console.log('  WARN: round-trip mismatch');
  if (errs.length) console.log('  PAGE ERRORS:', errs);
})().catch(e => { console.error('MKSAVE FAIL', e); process.exit(1); });
