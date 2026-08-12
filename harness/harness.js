/* harness.js — headless verification rig for planet_webgl.
   Loads the engine in a real WebGL2 context (SwiftShader), runs a deterministic
   simulation, and reports a bitwise state hash plus physical diagnostics.

   Usage: node harness.js [--dir=../project] [--steps=500] [--level=5]
                          [--out=file.json] [--params='{"bathyMode":1}']
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
const DIR    = path.resolve(arg('dir', defaultDir()));
const STEPS  = parseInt(arg('steps', '500'), 10);
const LEVEL  = parseInt(arg('level', '5'), 10);
const OUT    = arg('out', '');
const PATCH  = JSON.parse(arg('params', '{}'));
const SCHEME_ARG = process.argv.find(a => a.startsWith('--scheme='));
if (SCHEME_ARG) PATCH.oceanScheme = parseInt(SCHEME_ARG.slice('--scheme='.length), 10);
const LEGACY_SEED = process.argv.includes('--legacy-seed');
/* Grid seed. Must be 12345 -- the default the original `new Grid(level)` used
   -- or the continents differ and no comparison against the pristine baseline
   is meaningful. The separate uSeed used for state init is 500 under
   --legacy-seed, matching the old Math.random()->0.5 stub. */
const SEED   = 12345;

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

  // Engine sources, in dependency order. app.js is excluded (DOM/UI only).
  for (const f of ['geodesics.js', 'shader.js', 'params.js', 'engine.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  }

  const result = await page.evaluate(async (STEPS, LEVEL, PATCH, SEED, LEGACY_SEED) => {
    // ---- determinism: freeze Math.random and the rAF loop -------------------
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};

    const canvas = document.getElementById('c');
    let planet;
    try {
      planet = new Planet(canvas, LEVEL);
    } catch (e) {
      return { fatal: 'construct: ' + e.message };
    }
    const gl = planet.gl;

    // Apply parameter overrides, then re-init so state is seed-deterministic.
    Object.keys(PATCH).forEach(k => { planet.params[k] = PATCH[k]; });
    if ('seed' in planet.params) planet.params.seed = SEED;
    /* Bathymetry is baked into uCellC at BUILD time, so params that shape it
       only take effect after a rebuild. The constructor already built the grid
       from defaults, so rebuild now that the overrides are in place. */
    planet.build(LEVEL);
    /* build() consumed RNG draws for particle seeding; restart the stream so
       the state-init seeds match a run that never rebuilt. */
    planet._rng = null;
    /* --legacy-seed reproduces the pre-refactor behaviour exactly, where
       reset() drew uSeed from the Math.random()->0.5 stub. Lets us prove that
       a hash change is caused ONLY by the new deterministic RNG and not by a
       physics regression. */
    if (LEGACY_SEED && planet.seedRand) planet.seedRand = () => 0.5;
    planet.reset();
    /* Enable per-iteration residual readback for scheme B so the early-exit and
       residual history are exercised during validation (off in the interactive
       UI, where the readback stall would dominate frame time). */
    planet.trackResidual = true;

    // ---- run ---------------------------------------------------------------
    // step() only; particles are decoupled from the physical state and use
    // their own RNG, so they are deliberately excluded.
    const t0 = performance.now();
    for (let i = 0; i < STEPS; i++) planet.step();
    gl.finish();
    const ms = performance.now() - t0;

    // ---- readback ----------------------------------------------------------
    const W = planet.grid.W, H = planet.grid.H, V = planet.grid.V;
    const fbo = gl.createFramebuffer();
    function read(tex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const buf = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
      return buf;
    }

    // FNV-1a over the raw bytes of every live cell -> bitwise identity check.
    function hashOf(arrays) {
      let h = 0x811c9dc5;
      for (const a of arrays) {
        const bytes = new Uint8Array(a.buffer, 0, V * 4 * 4); // live cells only
        for (let i = 0; i < bytes.length; i++) {
          h ^= bytes[i];
          h = Math.imul(h, 0x01000193) >>> 0;
        }
      }
      return ('00000000' + h.toString(16)).slice(-8);
    }

    const names = ['topS', 'topV', 'deepS', 'deepV', 'loA', 'loB', 'hiA', 'hiB'];
    const tex = names.map((_, i) => read(planet.A[i]));
    const cellA = read(planet.texCellA);
    const cellB = read(planet.texCellB);
    let cellC = null;
    if (planet.texCellC) cellC = read(planet.texCellC);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);

    // ---- diagnostics -------------------------------------------------------
    const P = planet.params;
    const stats = {};
    let nanCount = 0;
    names.forEach((n, i) => {
      const a = tex[i];
      const mn = [Infinity, Infinity, Infinity, Infinity];
      const mx = [-Infinity, -Infinity, -Infinity, -Infinity];
      for (let c = 0; c < V; c++) {
        for (let k = 0; k < 4; k++) {
          const v = a[c * 4 + k];
          if (!isFinite(v)) { nanCount++; continue; }
          if (v < mn[k]) mn[k] = v;
          if (v > mx[k]) mx[k] = v;
        }
      }
      stats[n] = { min: mn.map(x => +x.toPrecision(7)), max: mx.map(x => +x.toPrecision(7)) };
    });

    // Conservation integrals. h_deep is per-cell derived: D - h_top.
    const cpW = 4000, rhoW = 1027;
    let volume = 0, heat = 0, salt = 0, area = 0;
    let maxTopSpd = 0, maxTopSpdCoast = 0, clampHits = 0;
    let minH = Infinity, maxH = -Infinity, minD = Infinity, maxD = -Infinity;

    // A cell is "coastal" if any 1-ring neighbour differs in wet/dry state.
    const nbrA = planet.grid.nbrA;
    const landOf = c => cellB[c * 4 + 3];

    for (let c = 0; c < V; c++) {
      const A = cellA[c * 4 + 3];
      const land = landOf(c);
      const D = cellC ? cellC[c * 4] : P.hTotal;
      const hT = tex[0][c * 4 + 0];
      const Tt = tex[0][c * 4 + 1], St = tex[0][c * 4 + 2];
      const Td = tex[2][c * 4 + 0], Sd = tex[2][c * 4 + 1];
      const hD = D - hT;
      area += A;
      volume += D * A;
      heat += cpW * rhoW * (hT * Tt + hD * Td) * A;
      salt += rhoW * (hT * St + hD * Sd) * A;
      if (hT < minH) minH = hT;
      if (hT > maxH) maxH = hT;
      if (D < minD) minD = D;
      if (D > maxD) maxD = D;

      const u = tex[1][c * 4 + 0], v = tex[1][c * 4 + 1];
      const spd = Math.hypot(u, v);
      if (land < 0.5) {
        if (spd > maxTopSpd) maxTopSpd = spd;
        if (spd > 2.99) clampHits++;
        let coastal = false;
        for (let k = 0; k < 6; k++) {
          const base = (c + k * W * H) * 4;
          if (nbrA[base + 3] < 0.5) continue;
          if (landOf(nbrA[base]) > 0.5) { coastal = true; break; }
        }
        if (coastal && spd > maxTopSpdCoast) maxTopSpdCoast = spd;
      }
    }

    return {
      hash: hashOf(tex),
      cellHash: hashOf(cellC ? [cellA, cellB, cellC] : [cellA, cellB]),
      steps: STEPS, level: LEVEL, V, ms: +ms.toFixed(1),
      msPerStep: +(ms / STEPS).toFixed(3),
      nanCount,
      simTime: planet.simTime,
      hasCellC: !!cellC,
      lastJacobiIters: planet.lastJacobiIters,
      residualHistory: planet.residualHistory,
      diag: {
        volume, heat, salt, area,
        maxTopSpd: +maxTopSpd.toPrecision(6),
        maxTopSpdCoast: +maxTopSpdCoast.toPrecision(6),
        clampHits,
        hTop: [+minH.toPrecision(6), +maxH.toPrecision(6)],
        depth: [+minD.toPrecision(6), +maxD.toPrecision(6)],
      },
      stats,
    };
  }, STEPS, LEVEL, PATCH, SEED, LEGACY_SEED);

  result.shaderLogs = logs.filter(l =>
    /compile|link|FBO|PAGEERROR|error/i.test(l)).slice(0, 40);

  await browser.close();
  const json = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
  if (result.fatal || result.nanCount > 0 || (result.shaderLogs || []).length) process.exit(2);
})().catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
