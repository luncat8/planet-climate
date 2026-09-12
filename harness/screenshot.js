/* Render-path regression matrix — one sim trajectory per level, then every
 * mode x streamline combo rendered from the same state and hashed (raw canvas
 * pixels, fnv1a-32, gate-style). Complements gate.sh (which hashes SIMULATION
 * state): this catches render-path drift (bake, stride, dpr, shaders).
 *
 * Recipe is fixed for determinism: seeded reset, SUBSTEPS=1, FRAMES frames of
 * { step + smooth + vflow + flow }, then render-only combos. FRAMES >= 40 so
 * tracer trails (PT=40 slots) are fully developed in the s15 shots.
 *
 *   node screenshot.js --tag=p4                     # harness/runs/shot-<tag>.json
 *   node screenshot.js --tag=p4 --png=../shots/p4   # + clipped PNGs for eyeball
 *   node screenshot.js --tag=q --baseline=runs/shot-p4.json   # compare, exit 1 on drift
 *   node screenshot.js --levels=7 --modes=13 --masks=0,15     # subset
 *
 * Hashes are driver-specific (same caveat as gate.sh) — compare only within
 * one driver. Canvas is fixed 460x460 @dpr 1, so the P4.2 dpr cap is a no-op
 * here; it still gates bake/stride/shader changes.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { launchBrowser } = require('./chrome-launch');
const DIR = process.env.PLANET_DIR || path.resolve(__dirname, '../planet');
const SIZE = 460, SUBSTEPS = 1, FRAMES = 45;

function arg(name, def) {
  const m = process.argv.find(a => a.startsWith('--' + name + '='));
  return m ? m.split('=')[1] : def;
}
const TAG = arg('tag', 'shot');
const LEVELS = arg('levels', '5,6,7').split(',').map(Number);
const MODES = arg('modes', '13,0,18').split(',').map(Number);
const MASKS = arg('masks', '0,15').split(',').map(Number);
const PNGDIR = arg('png', '');
const BASELINE = arg('baseline', '');

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

(async () => {
  const b = await launchBrowser(puppeteer, { protocolTimeout: 600000 });
  const page = await b.newPage();
  await page.setViewport({ width: SIZE + 20, height: SIZE + 20, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { const t = m.text(); if (/error|warn|NaN|incomplete/i.test(t)) errs.push(t.slice(0, 300)); });
  await page.setContent(`<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>`);
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  const device = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  if (PNGDIR) fs.mkdirSync(PNGDIR, { recursive: true });

  const rows = [];
  for (const level of LEVELS) {
    // One trajectory per level; combos rendered from the same state.
    const b64s = await page.evaluate((lvl, modes, masks, SIZE, SUBSTEPS, FRAMES) => {
      window.requestAnimationFrame = () => 0;
      const planet = new Planet(document.getElementById('c'), lvl);
      planet.build(lvl);
      planet.params.flowParticles = 16;
      planet.rebuildPools();
      planet.params.oceanScheme = 0;
      planet.params.substeps = SUBSTEPS;
      planet.params.running = true;
      const dtF = planet.params.dt * SUBSTEPS;
      for (let f = 0; f < FRAMES; f++) {
        planet.step();
        planet.stepSmooth(); planet.stepVFlow(); planet.stepFlow(dtF);
      }
      const gl = planet.gl, out = {};
      const px = new Uint8Array(SIZE * SIZE * 4);
      for (const m of modes) for (const mask of masks) {
        planet.params.mode = m;
        planet.params.streamline = mask;
        planet.render();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let bin = '';
        for (let i = 0; i < px.length; i += 8192)
          bin += String.fromCharCode.apply(null, px.subarray(i, i + 8192));
        out[m + '|' + mask] = btoa(bin);
      }
      return out;
    }, level, MODES, MASKS, SIZE, SUBSTEPS, FRAMES);
    for (const m of MODES) for (const mask of MASKS) {
      const buf = Buffer.from(b64s[m + '|' + mask], 'base64');
      rows.push({ level, mode: m, mask, hash: fnv1a(buf) });
    }
  }

  // PNG eyeball pass: re-run trajectories (cheap) and capture composited PNGs.
  if (PNGDIR) {
    for (const level of LEVELS) {
      await page.evaluate((lvl, SUBSTEPS, FRAMES) => {
        window.requestAnimationFrame = () => 0;
        const planet = new Planet(document.getElementById('c'), lvl);
        planet.build(lvl);
        planet.params.flowParticles = 16;
        planet.rebuildPools();
        planet.params.oceanScheme = 0;
        planet.params.substeps = SUBSTEPS;
        planet.params.running = true;
        window.__shotPlanet = planet;
        const dtF = planet.params.dt * SUBSTEPS;
        for (let f = 0; f < FRAMES; f++) {
          planet.step();
          planet.stepSmooth(); planet.stepVFlow(); planet.stepFlow(dtF);
        }
      }, level, SUBSTEPS, FRAMES);
      for (const m of MODES) for (const mask of MASKS) {
        await page.evaluate((mm, mk) => {
          const p = window.__shotPlanet;
          p.params.mode = mm; p.params.streamline = mk;
          p.render();
        }, m, mask);
        await page.screenshot({
          path: path.join(PNGDIR, `L${level}_m${m}_s${mask}.png`),
          clip: { x: 0, y: 0, width: SIZE, height: SIZE },
        });
      }
      await page.evaluate(() => { window.__shotPlanet = null; });
    }
  }

  await b.close();
  const report = {
    tag: TAG, device, canvas: SIZE, substeps: SUBSTEPS, frames: FRAMES,
    modes: MODES, masks: MASKS, rows, errors: errs,
  };
  fs.mkdirSync(path.join(__dirname, 'runs'), { recursive: true });
  const outPath = path.join(__dirname, 'runs', `shot-${TAG}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
  for (const r of rows)
    console.log(`  [L${r.level} m${r.mode} s${r.mask}] hash=${r.hash}`);
  if (errs.length) { console.log('ERRORS:'); errs.slice(0, 10).forEach(e => console.log('  ' + e)); }
  if (BASELINE) {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).rows;
    const bh = {};
    base.forEach(r => { bh[`${r.level}|${r.mode}|${r.mask}`] = r.hash; });
    let drift = 0;
    for (const r of rows) {
      const k = `${r.level}|${r.mode}|${r.mask}`;
      if (bh[k] === undefined) { console.log(`  [L${r.level} m${r.mode} s${r.mask}] NEW (no baseline)`); }
      else if (bh[k] !== r.hash) { console.log(`  [L${r.level} m${r.mode} s${r.mask}] DRIFT ${bh[k]} -> ${r.hash}`); drift++; }
    }
    if (drift) { console.log(`screenshot: ${drift} DRIFT(s)`); process.exit(1); }
    console.log('screenshot: all IDENTICAL');
  }
  if (errs.length) process.exit(2);
})().catch(e => { console.error('screenshot FATAL:', e.message); process.exit(3); });
