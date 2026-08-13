/* render.js -- render smoke test.
   The state harness only runs step(); it never exercises the draw path, so a
   broken vertex/fragment program (like the uCellA redefinition that silently
   killed the equirect clouds) would go unnoticed. This walks every layer/view
   mode in both globe and equirect projections, compiles each program, draws a
   frame, and reports any shader log or GL error plus whether the framebuffer
   actually changed (a program that links but renders nothing is still a bug).

   usage: node render.js [--level=5] [--params='{"bathyMode":1}']
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
const PATCH = JSON.parse(arg('params', '{}'));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => { const t = m.text(); if (/error|ERROR|WebGL/.test(t)) logs.push(t); });
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));

  await page.setContent('<canvas id="c" width="512" height="384"></canvas>');
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  const out = await page.evaluate(async (LEVEL, PATCH) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    const canvas = document.getElementById('c');
    const planet = new Planet(canvas, LEVEL);
    Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });
    planet.build(LEVEL);
    planet._rng = null;
    planet.reset();
    for (let i = 0; i < 30; i++) planet.step();

    const gl = planet.gl;
    const res = [];
    const pix = new Uint8Array(512 * 384 * 4);

    const modes = [];
    for (let m = 0; m <= 23; m++) modes.push(m);

    for (const equi of [false, true]) {
      for (const m of modes) {
        /* mode is read from params by both draw paths */
        planet.params.mode = m;
        planet.mode = m;
        let err = null;
        try {
          if (equi && planet.renderEquirect) planet.renderEquirect(512, 384, planet.sunDir());
          else planet.render();
        } catch (e) { err = e.message; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, 512, 384, gl.RGBA, gl.UNSIGNED_BYTE, pix);
        let nz = 0, sum = 0;
        for (let i = 0; i < pix.length; i += 4) {
          if (pix[i] | pix[i + 1] | pix[i + 2]) nz++;
          sum += pix[i];
        }
        const ge = gl.getError();
        res.push({ equi, mode: m, err, nonZero: nz, glError: ge === 0 ? null : ge });
      }
    }
    return { res, progs: Object.keys(planet.prog) };
  }, LEVEL, PATCH);

  // collect shader logs the engine may have printed
  const bad = out.res.filter(r => r.err || r.glError || r.nonZero === 0);
  console.log(JSON.stringify({
    programs: out.progs.length,
    tested: out.res.length,
    failures: bad,
    consoleErrors: [...new Set(logs)].slice(0, 20),
  }, null, 2));

  await browser.close();
  process.exit(bad.length || logs.length ? 2 : 0);
})();
