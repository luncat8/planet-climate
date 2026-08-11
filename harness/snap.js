/* snap.js -- render a PNG of one view mode, so bathymetry can be eyeballed.
   usage: node snap.js --mode=16 --out=/home/user/shots/depth.png [--equi]
*/
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const DIR = path.resolve(arg('dir', '/home/user/project'));
const LEVEL = parseInt(arg('level', '6'), 10);
const MODE = parseInt(arg('mode', '16'), 10);
const STEPS = parseInt(arg('steps', '200'), 10);
const OUT = arg('out', '/home/user/shots/out.png');
const EQUI = process.argv.includes('--equi');
const PATCH = JSON.parse(arg('params', '{"bathyMode":1}'));
const W = parseInt(arg('w', EQUI ? 1024 : 700), 10);
const H = parseInt(arg('h', EQUI ? 512 : 700), 10);

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 0,   // long runs exceed the 180s CDP default

    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.setContent(`<style>body{margin:0;background:#05070d}</style><canvas id="c" width="${W}" height="${H}"></canvas>`);
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }
  const dataUrl = await page.evaluate(async (LEVEL, MODE, STEPS, PATCH, EQUI, W, H) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    const planet = new Planet(document.getElementById('c'), LEVEL);
    Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });
    planet.build(LEVEL);
    planet._rng = null;
    planet.reset();
    for (let i = 0; i < STEPS; i++) planet.step();
    planet.params.mode = MODE;
    planet.mode = MODE;
    if (EQUI) planet.renderEquirect(W, H, planet.sunDir());
    else planet.render();
    const gl = planet.gl;
    gl.finish();
    /* The drawing buffer is discarded once the frame is composited, so pull the
       pixels out in this same task and re-encode through a 2D canvas. */
    const px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const c2 = document.createElement('canvas');
    c2.width = W; c2.height = H;
    const ctx = c2.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {              // GL origin is bottom-left
      const src = (H - 1 - y) * W * 4, dst = y * W * 4;
      for (let x = 0; x < W * 4; x++) img.data[dst + x] = px[src + x];
      for (let x = 3; x < W * 4; x += 4) img.data[dst + x] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c2.toDataURL('image/png');
  }, LEVEL, MODE, STEPS, PATCH, EQUI, W, H);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote ' + OUT);
  await browser.close();
})();
