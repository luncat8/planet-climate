/* dti_check.js — dt-independence regression for the air solver.
 *
 *   node dti_check.js [--simt=259200] [--level=5] [--tol=1.3]
 *
 * Runs the headless harness for a sweep of timesteps at a FIXED simulated time
 * (default 3 days) and checks that the peak air wind speed does not depend on
 * dt. The explicit upwind air advection used to make large-dt air spuriously
 * calmer (over-diffusion) -> a big loA/hiA ratio across the dt set. After the
 * Courant cap (shader.js stepAir) that ratio should be < tol.
 *
 * Outputs one line per layer/channel (max|u|, max|v| per dt, and the ratio)
 * and exits non-zero if any ratio exceeds tol. Run outputs are cached under
 * /tmp/dti so re-running is cheap.
 *
 * This test is EXPECTED TO FAIL on the pre-fix code (~1.9x loA at dt=10 vs
 * dt=300) and PASS afterwards.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
}

// Extra params injected into every harness run (used to A/B test hypotheses
// such as the Semi-Lagrangian advection path or explicit Coriolis).
function extraParams() {
  const e = arg('extra', '');
  return e ? JSON.parse(e) : {};
}

const SIMT  = parseFloat(arg('simt', '259200'));   // 3 days [s]
const LEVEL = parseInt(arg('level', '5'), 10);
const TOL   = parseFloat(arg('tol', '1.3'));
const CACHE = process.env.DTI_CACHE || '/tmp/dti';
const DIR   = '/media/sf_1/planet242/planet';
const HARNESS = path.join(__dirname, 'harness.js');
const DTS = [10, 30, 60, 120, 300];

const LAYERS = ['loA', 'hiA'];
// channel index: 0 = u, 1 = v  (matches stats.<layer>.min/max arrays)

function maxAbs(arr, idx) {
  return Math.max(Math.abs(arr.min[idx]), Math.abs(arr.max[idx]));
}

function run(dt) {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, `dt_${dt}.json`);
  if (!fs.existsSync(out)) {
    const steps = Math.max(1, Math.round(SIMT / dt));
    const params = JSON.stringify(Object.assign({ dt, substeps: 1 }, extraParams()));
    console.error(`  [dt=${dt}] running ${steps} steps (level ${LEVEL})...`);
    execFileSync('node', [
      HARNESS,
      `--steps=${steps}`,
      `--level=${LEVEL}`,
      `--dir=${DIR}`,
      `--params=${params}`,
      `--out=${out}`,
    ], { stdio: 'inherit' });
  } else {
    console.error(`  [dt=${dt}] cached ${out}`);
  }
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

console.error(`dt-independence check: simt=${SIMT}s level=${LEVEL} tol=${TOL}x`);
console.error(`dt sweep: ${DTS.join(', ')}`);

const data = {};
for (const dt of DTS) data[dt] = run(dt);

let worst = 0;
let worstTag = '';
const rows = [];
for (const layer of LAYERS) {
  const u = DTS.map(dt => maxAbs(data[dt].stats[layer], 0));
  const v = DTS.map(dt => maxAbs(data[dt].stats[layer], 1));
  const ratioU = Math.max(...u) / Math.min(...u);
  const ratioV = Math.max(...v) / Math.min(...v);
  rows.push({ layer, chan: 'u', perDt: u, ratio: ratioU });
  rows.push({ layer, chan: 'v', perDt: v, ratio: ratioV });
  for (const r of [ratioU, ratioV]) {
    if (r > worst) { worst = r; worstTag = `${layer}`; }
  }
}

// Pretty table
console.log('\n  dt-independence: peak air wind speed (m/s) vs dt\n');
console.log('  layer  chan   ' + DTS.map(dt => `dt=${String(dt).padStart(4)}`).join('  ') + '   ratio');
for (const r of rows) {
  const cells = r.perDt.map(x => x.toFixed(3).padStart(8)).join('  ');
  const flag = r.ratio > TOL ? '  <-- FAIL' : '';
  console.log(`  ${r.layer.padEnd(5)}  ${r.chan}    ${cells}   ${r.ratio.toFixed(3)}${flag}`);
}

const pass = worst <= TOL;
console.log(`\n  worst ratio = ${worst.toFixed(3)}x (tol ${TOL}x) -> ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
