/* tri.js -- diagnose the triangular / spoke pattern in deep-ocean speed.
 *
 * Hypothesis A: the pattern is GRID IMPRINTING -- the icosahedral base mesh
 *   has 12 pentagonal cells and 20 triangular faces whose edges are lines of
 *   distorted cell shape/area. If so the pattern is locked to the mesh and
 *   should (a) correlate with distance to the 12 pentagon vertices / the 30
 *   great-circle arcs, and (b) NOT rotate when the flow changes.
 *
 * Hypothesis B: the pattern is physical flow (planetary waves).
 *
 * Discriminator implemented here:
 *   1. Locate the 12 icosahedral vertices (cells with 5 neighbours).
 *   2. Bin deep speed by angular distance to the nearest pentagon.
 *   3. Bin deep speed by distance to the nearest of the 30 icosahedral EDGE
 *      arcs (great circles between adjacent pentagon pairs) -- the "triangle
 *      sides" the user sees.
 *   4. Report anisotropy: the ratio of mean speed ON an edge arc vs OFF it.
 *      Grid imprinting => strong, stable ratio != 1.
 *   Also reports cell-area and edge-length variation as the mechanical cause.
 *
 * Usage: node tri.js --level=6 --steps=2000 [--params='{...}'] [--out=f.json]
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const arg = (k, d) => {
  const a = process.argv.find(s => s.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : d;
};
const LEVEL = +arg('level', 6);
const STEPS = +arg('steps', 2000);
const PARAMS = arg('params', '{}');
const OUT = arg('out', '');
const DIR = arg('dir', '/home/user/project');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 0,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle',
           '--use-angle=swiftshader', '--disable-gpu-sandbox', '--enable-webgl',
           '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('PAGEERROR', e.message));
  await page.goto('file://' + path.join(DIR, 'index.html'), { waitUntil: 'load' });

  const res = await page.evaluate(async (LEVEL, STEPS, PARAMS) => {
    Math.random = () => 0.5;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const canvas = document.getElementById('c');
    const planet = new Planet(canvas, LEVEL);
    const over = JSON.parse(PARAMS);
    for (const k in over) planet.params[k] = over[k];
    planet.build(LEVEL);
    planet._rng = null;
    planet.reset();
    for (let i = 0; i < STEPS; i++) planet.step();

    const gl = planet.gl;
    const V = planet.grid.V, W = planet.grid.W, H = planet.grid.H;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const read = (t) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const b = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, b);
      return b;
    };
    const deepV = read(planet.A[3]);
    const topV  = read(planet.A[1]);
    const cellA = read(planet.texCellA);
    const cellB = read(planet.texCellB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const nbrA = planet.grid.nbrA;

    // --- 1. valence: pentagons have 5 valid neighbours -----------------
    const pent = [];
    const valence = new Int32Array(V);
    for (let c = 0; c < V; c++) {
      let k5 = 0;
      for (let k = 0; k < 6; k++) if (nbrA[(c + k * W * H) * 4 + 3] > 0.5) k5++;
      valence[c] = k5;
      if (k5 === 5) pent.push(c);
    }

    const pos = [];
    for (let c = 0; c < V; c++) {
      const x = cellA[c * 4], y = cellA[c * 4 + 1], z = cellA[c * 4 + 2];
      const r = Math.hypot(x, y, z) || 1;
      pos.push([x / r, y / r, z / r]);
    }
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    // --- 2. the 30 icosahedral edges: nearest pentagon pairs ------------
    const edges = [];
    for (let i = 0; i < pent.length; i++) {
      const di = [];
      for (let j = 0; j < pent.length; j++) {
        if (i === j) continue;
        di.push([Math.acos(Math.max(-1, Math.min(1, dot(pos[pent[i]], pos[pent[j]])))), j]);
      }
      di.sort((a, b) => a[0] - b[0]);
      for (let m = 0; m < 5; m++) {            // 5 nearest = icosahedral edges
        const j = di[m][1];
        if (i < j) edges.push([pent[i], pent[j]]);
      }
    }

    // distance from cell to great-circle arc (p,q), as an angle
    const arcDist = (u, p, q) => {
      const n = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      const nn = [n[0] / nl, n[1] / nl, n[2] / nl];
      const perp = Math.asin(Math.max(-1, Math.min(1, Math.abs(dot(u, nn)))));
      // only count if the projection falls between p and q
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(p, q))));
      const ap = Math.acos(Math.max(-1, Math.min(1, dot(u, p))));
      const aq = Math.acos(Math.max(-1, Math.min(1, dot(u, q))));
      if (ap > ang || aq > ang) return Math.min(ap, aq);
      return perp;
    };

    // --- 3. per-cell metrics --------------------------------------------
    const out = { V, nPent: pent.length, nEdge: edges.length, level: LEVEL, steps: STEPS };
    let areaMin = 1e30, areaMax = 0, areaSum = 0;
    const dEdgeArr = new Float64Array(V), spdArr = new Float64Array(V);
    const NB = 10, BW = 0.03;    // radian bins from the edge arc
    const bins = [];
    for (let b = 0; b < NB; b++) bins.push({ n: 0, s: 0, t: 0, area: 0 });

    for (let c = 0; c < V; c++) {
      const land = cellB[c * 4 + 3] > 0.5;
      const a = cellA[c * 4 + 3];
      areaSum += a;
      if (a < areaMin) areaMin = a;
      if (a > areaMax) areaMax = a;
      let dmin = 9;
      for (const [pi, qi] of edges) {
        const d = arcDist(pos[c], pos[pi], pos[qi]);
        if (d < dmin) dmin = d;
      }
      dEdgeArr[c] = dmin;
      const sd = Math.hypot(deepV[c * 4], deepV[c * 4 + 1]);
      const st = Math.hypot(topV[c * 4], topV[c * 4 + 1]);
      spdArr[c] = sd;
      if (land) continue;
      const b = Math.min(NB - 1, Math.floor(dmin / BW));
      bins[b].n++; bins[b].s += sd; bins[b].t += st; bins[b].area += a;
    }

    out.area = { min: areaMin, max: areaMax, ratio: areaMax / areaMin, mean: areaSum / V };
    out.bins = bins.map((b, i) => ({
      dLo: +(i * BW).toFixed(3), n: b.n,
      deepSpd: b.n ? +(b.s / b.n).toPrecision(4) : 0,
      topSpd:  b.n ? +(b.t / b.n).toPrecision(4) : 0,
      meanArea: b.n ? +(b.area / b.n).toPrecision(6) : 0,
    }));

    // on-arc (<0.03 rad) vs off-arc (>0.12 rad)
    let on = { n: 0, s: 0, t: 0 }, off = { n: 0, s: 0, t: 0 };
    for (let c = 0; c < V; c++) {
      if (cellB[c * 4 + 3] > 0.5) continue;
      const sd = Math.hypot(deepV[c * 4], deepV[c * 4 + 1]);
      const st = Math.hypot(topV[c * 4], topV[c * 4 + 1]);
      const g = dEdgeArr[c] < 0.03 ? on : (dEdgeArr[c] > 0.12 ? off : null);
      if (g) { g.n++; g.s += sd; g.t += st; }
    }
    out.onArc  = { n: on.n,  deepSpd: on.n  ? +(on.s / on.n).toPrecision(4)   : 0,
                              topSpd: on.n  ? +(on.t / on.n).toPrecision(4)   : 0 };
    out.offArc = { n: off.n, deepSpd: off.n ? +(off.s / off.n).toPrecision(4) : 0,
                              topSpd: off.n ? +(off.t / off.n).toPrecision(4) : 0 };
    out.ratioDeep = out.offArc.deepSpd ? +(out.onArc.deepSpd / out.offArc.deepSpd).toPrecision(4) : 0;
    out.ratioTop  = out.offArc.topSpd  ? +(out.onArc.topSpd  / out.offArc.topSpd ).toPrecision(4) : 0;

    // --- 4. speed near the 12 pentagons ---------------------------------
    let pn = 0, ps = 0;
    for (let c = 0; c < V; c++) {
      if (cellB[c * 4 + 3] > 0.5) continue;
      let dmin = 9;
      for (const p of pent) {
        const d = Math.acos(Math.max(-1, Math.min(1, dot(pos[c], pos[p]))));
        if (d < dmin) dmin = d;
      }
      if (dmin < 0.05) { pn++; ps += Math.hypot(deepV[c * 4], deepV[c * 4 + 1]); }
    }
    out.pentagon = { n: pn, deepSpd: pn ? +(ps / pn).toPrecision(4) : 0 };

    // --- 5. neighbour-distance anisotropy per cell (mechanical cause) ----
    let worstAniso = 0, anisoSum = 0, anisoN = 0;
    for (let c = 0; c < V; c++) {
      let lo = 1e30, hi = 0;
      for (let k = 0; k < 6; k++) {
        const base = (c + k * W * H) * 4;
        if (nbrA[base + 3] < 0.5) continue;
        const L = nbrA[base + 1];
        if (L < lo) lo = L;
        if (L > hi) hi = L;
      }
      if (hi > 0) { const r = hi / lo; anisoSum += r; anisoN++; if (r > worstAniso) worstAniso = r; }
    }
    out.edgeAniso = { mean: +(anisoSum / anisoN).toPrecision(4), worst: +worstAniso.toPrecision(4) };

    /* --- 6. direct correlation: is the field slaved to grid geometry? ----
       Pearson r between deep speed and (a) cell area, (b) per-cell edge-length
       anisotropy. Grid imprinting shows up here far more directly than in the
       arc test, because the distortion is smooth over each icosahedral face
       rather than concentrated on its edges. */
    const areaArr = new Float64Array(V), anisoArr = new Float64Array(V);
    for (let c = 0; c < V; c++) {
      areaArr[c] = cellA[c * 4 + 3];
      let lo = 1e30, hi = 0;
      for (let k = 0; k < 6; k++) {
        const base = (c + k * W * H) * 4;
        if (nbrA[base + 3] < 0.5) continue;
        const L = nbrA[base + 1];
        if (L < lo) lo = L;
        if (L > hi) hi = L;
      }
      anisoArr[c] = hi > 0 ? hi / lo : 1;
    }
    const wet = [];
    for (let c = 0; c < V; c++) if (cellB[c * 4 + 3] <= 0.5) wet.push(c);
    const pearson = (f, g) => {
      let n = wet.length, sf = 0, sg = 0;
      for (const c of wet) { sf += f[c]; sg += g[c]; }
      const mf = sf / n, mg = sg / n;
      let cov = 0, vf = 0, vg = 0;
      for (const c of wet) {
        const a = f[c] - mf, b = g[c] - mg;
        cov += a * b; vf += a * a; vg += b * b;
      }
      return +(cov / Math.sqrt(vf * vg || 1)).toPrecision(4);
    };
    const topSpdArr = new Float64Array(V);
    for (let c = 0; c < V; c++) topSpdArr[c] = Math.hypot(topV[c*4], topV[c*4+1]);
    out.corr = {
      deepSpd_area:  pearson(spdArr, areaArr),
      deepSpd_aniso: pearson(spdArr, anisoArr),
      topSpd_area:   pearson(topSpdArr, areaArr),
      topSpd_aniso:  pearson(topSpdArr, anisoArr),
      deepSpd_dEdge: pearson(spdArr, dEdgeArr),
    };
    return out;
  }, LEVEL, STEPS, PARAMS);

  console.log(JSON.stringify(res, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  await browser.close();
})();
