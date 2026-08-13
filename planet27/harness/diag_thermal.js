/* diag_thermal.js — does the moving sun actually perturb T/pressure/wind? */
const puppeteer = require('/media/sf_1/planet242/harness/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');
function arg(n, d) { const h = process.argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; }
const DIR = arg('dir', '/media/sf_1/planet242/planet');
const SAVE = arg('save', '/media/sf_1/planet242/planet/planet_state.js');

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
    window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};
    const enc = readPlanetStateJS(txt);
    const planet = new Planet(document.getElementById('c'), enc.level);
    const gl = planet.gl; while (gl.getError() !== gl.NO_ERROR) {}
    planet.applyState(decodePlanetState(enc));

    function fieldStats(idx) {
      const a = planet.readTex(planet.A[idx]); const V = planet.grid.V;
      const cb = planet.readTex(planet.texCellB);
      let min = 1e30, max = -1e30, mean = 0, cnt = 0;
      for (let c = 0; c < V; c++) { if (cb[c*4+3] >= 0.5) continue; const v = a[c*4]; if (!isFinite(v)) continue;
        if (v < min) min = v; if (v > max) max = v; mean += v; cnt++; }
      return { min:+min.toPrecision(6), max:+max.toPrecision(6), mean:+(cnt?mean/cnt:0).toPrecision(6) };
    }
    // 4 = loA (Tl in .z, Pl in .w);  report Tl and Pl ranges
    function tlpl() {
      const a = planet.readTex(planet.A[4]); const V = planet.grid.V; const cb = planet.readTex(planet.texCellB);
      let tmin=1e30,tmax=-1e30,pmin=1e30,pmax=-1e30,pcnt=0;
      for (let c=0;c<V;c++){ if(cb[c*4+3]>=0.5)continue; const tl=a[c*4+2], pl=a[c*4+3];
        if(tl<tmin)tmin=tl; if(tl>tmax)tmax=tl; if(pl<pmin)pmin=pl; if(pl>pmax)pmax=pl; pcnt++; }
      return {tmin:+tmin.toPrecision(5),tmax:+tmax.toPrecision(5),pmin:+pmin.toPrecision(6),pmax:+pmax.toPrecision(6)};
    }
    const samples = [];
    samples.push({ step: 0, day:+(planet.simTime/86400).toPrecision(5), tlpl: tlpl(), loS: fieldStats(4) });
    for (let i = 0; i < 12; i++) { for (let k = 0; k < 180; k++) planet.step(); samples.push({ step:(i+1)*180, day:+(planet.simTime/86400).toPrecision(5), tlpl: tlpl(), loS: fieldStats(4) }); }
    return { samples };
  }, fs.readFileSync(SAVE, 'utf8'));
  await browser.close();
  console.log('Tl/Pl range & low-air stats over ~1.7 days (sun moving, default params):');
  res.samples.forEach(s => console.log('  day ' + s.day.toString().padEnd(8) +
    ' Tl[' + s.tlpl.tmin + ',' + s.tlpl.tmax + '] Pl[' + s.tlpl.pmin + ',' + s.tlpl.pmax + ']  loA.mean=' + s.loS.mean));
  if (errs.length) console.log('PAGE ERRORS:', errs);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
