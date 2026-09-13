/* auto_substeps_check.js — deterministic policy regression tests.
 *
 * The interactive controller is deliberately independent of WebGL, so exercise
 * its policy with a lightweight Planet prototype object. This catches the old
 * "fit 60 fps from physics ms only" behaviour without needing a GPU or a
 * multi-second browser run.
 *
 *   node harness/auto_substeps_check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console, isFinite, Math, Array, Number, Object };
vm.createContext(ctx);
for (const file of ['params.js', 'engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'planet', file), 'utf8'), ctx,
    { filename: file });
}

let passes = 0, fails = 0;
function check(name, ok, extra) {
  if (ok) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); }
}
function controller(overrides) {
  const p = Object.create(ctx.Planet.prototype);
  p.params = Object.assign(ctx.defaultParams(), overrides || {});
  p.autoN = null; p._autoActive = false; p._autoSeed = null;
  p._lastRafT = 0; p._rafGaps = []; p._screenRafHz = 0;
  p.fps = 60; p.rafHz = 144;
  return p;
}

const defaults = ctx.defaultParams();
check('default safety brake is enabled', defaults.substepsAutoDown === 1);
check('default rAF filler is disabled', defaults.substepsAutoUp === 0);

let p = controller({ substeps: 8, substepsAutoDown: 0, substepsAutoUp: 0 });
check('both disabled uses manual slider', p.effSubsteps() === 8, p.effSubsteps());
p.params.substeps = 17;
check('manual slider remains live with both disabled', p.effSubsteps() === 17, p.effSubsteps());

p = controller({ substeps: 8, substepsAutoDown: 1, substepsAutoUp: 0 });
p.effSubsteps(); p.fps = 70; p.updateAutoSubsteps();
check('decrease-only does not increase at 70 fps', p.autoN === 8, p.autoN);
p.fps = 40; p.updateAutoSubsteps();
check('decrease-only reduces below 50 fps', p.autoN < 8, p.autoN);
const afterDown = p.autoN;
p.fps = 144; p.updateAutoSubsteps();
check('decrease-only never increases after recovery', p.autoN === afterDown, p.autoN);

p = controller({ substeps: 8, substepsAutoDown: 0, substepsAutoUp: 1 });
p.effSubsteps(); p.fps = 70; p.updateAutoSubsteps();
check('rAF-only does not increase below a 144 Hz ceiling', p.autoN === 8, p.autoN);
p.fps = 143; p.updateAutoSubsteps();
check('rAF-only increases at the rAF ceiling', p.autoN > 8, p.autoN);
const afterUp = p.autoN;
p.fps = 40; p.updateAutoSubsteps();
check('increase-only never decreases below 50 fps', p.autoN === afterUp, p.autoN);

/* A loaded 70-fps page must not be accepted as a 70-Hz display ceiling. */
p = controller({ substeps: 8, substepsAutoDown: 0, substepsAutoUp: 1 });
p.rafHz = 0; p._screenRafHz = 0; p._lastRafT = 0;
for (let i = 0; i < 12; i++) p._sampleRaf(i === 0 ? 0 : i * 1000 / 70);
check('70-fps load is not mistaken for rAF ceiling', p.rafHz === 0, p.rafHz);
p._rafGaps = []; p._lastRafT = 0;
for (let i = 0; i < 12; i++) p._sampleRaf(i === 0 ? 0 : i * 1000 / 144);
check('144-Hz cadence is recognized as rAF ceiling', p.rafHz === 144, p.rafHz);

p = controller({ substeps: 8, substepsAutoDown: 1, substepsAutoUp: 1 });
p.effSubsteps(); p.fps = 40; p.updateAutoSubsteps();
check('both enabled prioritizes the 50 fps safety brake', p.autoN < 8, p.autoN);

/* Presets (partial maps) are converted on load; obsolete saves are rejected. */
check('old preset auto=false converts to down=false, up=false', (() => {
  const m = ctx.normalizePreset({ substepsAuto: 0 });
  return m.substepsAutoDown === 0 && m.substepsAutoUp === 0 && m.substepsAuto === undefined;
})());
check('old preset auto=true converts to down=true, up=false', (() => {
  const m = ctx.normalizePreset({ substepsAuto: 1 });
  return m.substepsAutoDown === 1 && m.substepsAutoUp === 0 && m.substepsAuto === undefined;
})());
check('explicit down/up preset keys survive conversion untouched', (() => {
  const m = ctx.normalizePreset({ substepsAuto: 0, substepsAutoUp: 1 });
  return m.substepsAutoDown === 0 && m.substepsAutoUp === 1 && m.substepsAuto === undefined;
})());
check('old save with substepsAuto is rejected', (() => {
  try { ctx.assertSaveParamsCurrent({ substeps: 8, substepsAuto: 0 }); return false; }
  catch (e) { return /substepsAuto/.test(e.message); }
})());
check('current save params pass the obsolete-key check', (() => {
  try { ctx.assertSaveParamsCurrent(ctx.defaultParams()); return true; }
  catch (e) { return false; }
})());

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
