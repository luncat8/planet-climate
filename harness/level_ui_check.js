/* level_ui_check.js — regression check: level buttons must reflect the grid
 * level that is actually built (and vice versa).
 *
 * Regression: ui.level was hardcoded to 6 while boot() built the planet at
 * level 5 (fresh init, planet_state.js untracked/absent) and never synced the
 * two — so the L6 button lit while the sim ran L5. Related defects covered
 * here: saves of another level failed to load (applyState throws on level
 * mismatch), and tuning sliders were never aligned to boot-time params.
 *
 *   node harness/level_ui_check.js
 *
 * Requires the headless Chromium from setup_chrome.sh. Uses file:// like a
 * local double-click; planet_state.js is generated/removed by this script
 * (restored if one already existed).
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { launchBrowser } = require('./chrome-launch');

const PLANET_DIR = path.resolve(__dirname, '..', 'planet');
const STATE_PATH = path.join(PLANET_DIR, 'planet_state.js');
const INDEX_URL = 'file://' + path.join(PLANET_DIR, 'index.html');

let fails = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log('PASS  ' + name); }
  else { fails++; console.log('FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

async function waitUntil(page, fn, what, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - t0 > (timeoutMs || 120000)) throw new Error('timeout waiting for ' + what);
    await new Promise(r => setTimeout(r, 200));
  }
}

async function snapshot(page) {
  return page.evaluate(() => ({
    ready: !!(window.ui && ui.planet && ui.planet.grid),
    gridLevel: ui.planet && ui.planet.grid ? ui.planet.grid.level : null,
    uiLevel: ui.level,
    lit: (document.querySelector('.mbtn.on') || {}).textContent || null,
    hud: ui.fpsEls && ui.fpsEls.lvlSpan ? ui.fpsEls.lvlSpan.textContent : null,
    errBox: !!ui.errBox,
    saveValue: ui.saveSel ? ui.saveSel.value : null,
  }));
}

async function bootFresh(page) {
  await page.goto(INDEX_URL, { waitUntil: 'load' });
  await waitUntil(page, () => window.ui && ui.planet && ui.planet.grid, 'planet boot');
  // first stats tick aligns HUD readouts
  await waitUntil(page, () => ui.fpsEls.fps.textContent !== '0 fps' || true, 'fps tick', 2000).catch(() => {});
}

(async () => {
  // stash any real save out of the way
  let stashed = null;
  if (fs.existsSync(STATE_PATH)) { stashed = fs.readFileSync(STATE_PATH); fs.unlinkSync(STATE_PATH); }

  const browser = await launchBrowser(puppeteer, { protocolTimeout: 600000 });
  const page = await browser.newPage();
  const pageErrs = [];
  page.on('pageerror', e => pageErrs.push(String(e.message || e)));

  try {
    /* ---- A: fresh boot (no planet_state.js) must boot L5 and highlight L5 */
    await bootFresh(page);
    let s = await snapshot(page);
    check('A fresh boot builds level 5', s.gridLevel === 5, s);
    check('A lit button is L5', s.lit && s.lit.indexOf('L5') === 0, s.lit);
    check('A HUD shows L5', s.hud === '5', s.hud);
    check('A ui.level synced', s.uiLevel === 5, s.uiLevel);
    check('A no error overlay', !s.errBox);

    /* ---- F: every tuning slider sits on the live param value */
    const sliderMismatch = await page.evaluate(() => {
      const bad = [];
      Object.keys(ui.knobInputs).forEach(k => {
        const inp = ui.knobInputs[k];
        if (Math.abs(parseFloat(inp.value) - ui.planet.params[k]) > 1e-9) bad.push(k);
      });
      return bad;
    });
    check('F sliders aligned to boot params', sliderMismatch.length === 0, sliderMismatch);

    /* ---- B: clicking L6 rebuilds to 6 and highlights L6 */
    await page.evaluate(() => {
      Array.prototype.find.call(document.querySelectorAll('.mbtn'),
        b => b.textContent.indexOf('L6') === 0).click();
    });
    await waitUntil(page, () => ui.planet.grid.level === 6, 'rebuild to L6');
    s = await snapshot(page);
    check('B grid rebuilt to level 6', s.gridLevel === 6, s);
    check('B lit button is L6', s.lit && s.lit.indexOf('L6') === 0, s.lit);

    /* ---- C: snapshot at L6, drop to L5, load the save back -> returns to L6.
       Pause first so the advancing sim can't race the measurements. */
    await page.evaluate(() => { ui.planet.params.running = 0; saveCurrent(); });
    const savedClock = await page.evaluate(() => ui.saves[0].state.simTime);
    await page.evaluate(() => {
      Array.prototype.find.call(document.querySelectorAll('.mbtn'),
        b => b.textContent.indexOf('L5') === 0).click();
    });
    await waitUntil(page, () => ui.planet.grid.level === 5, 'rebuild to L5');
    s = await snapshot(page);
    check('C grid back at level 5', s.gridLevel === 5, s);
    check('C lit button is L5', s.lit && s.lit.indexOf('L5') === 0, s.lit);
    await page.evaluate(() => {
      ui.saveSel.value = '0';
      ui.saveSel.dispatchEvent(new Event('change'));
    });
    await waitUntil(page, () => ui.planet.grid.level === 6, 'save load rebuild to L6');
    s = await snapshot(page);
    check('C cross-level save loads (grid L6)', s.gridLevel === 6, s);
    check('C lit button is L6 after load', s.lit && s.lit.indexOf('L6') === 0, s.lit);
    check('C dropdown shows the save', s.saveValue === '0', s.saveValue);
    check('C no error overlay after load', !s.errBox);
    const daysAfterLoad = await page.evaluate(() => ui.planet.simTime);
    check('C clock restored from save', daysAfterLoad === savedClock,
      { savedClock, daysAfterLoad });

    /* ---- E: boot WITH a planet_state.js written at level 6 -> L6 lights */
    const stateJS = await page.evaluate(() => {
      // serialize the live L6 sim straight to the .js file format
      return planetStateToJS(encodePlanetState(ui.planet.serializeState()));
    });
    await browser.close();
    fs.writeFileSync(STATE_PATH, stateJS);

    const browser2 = await launchBrowser(puppeteer, { protocolTimeout: 600000 });
    const page2 = await browser2.newPage();
    const pageErrs2 = [];
    page2.on('pageerror', e => pageErrs2.push(String(e.message || e)));
    try {
      await page2.goto(INDEX_URL, { waitUntil: 'load' });
      await waitUntil(page2, () => window.ui && ui.planet && ui.planet.grid, 'planet boot (state)');
      const s2 = await snapshot(page2);
      check('E state-file boot builds level 6', s2.gridLevel === 6, s2);
      check('E lit button is L6', s2.lit && s2.lit.indexOf('L6') === 0, s2.lit);
      check('E HUD shows L6', s2.hud === '6', s2.hud);
      check('E dropdown shows loaded default', s2.saveValue === '0', s2.saveValue);
      check('E no error overlay', !s2.errBox);
      check('E no page errors', pageErrs2.length === 0, pageErrs2);
    } finally {
      await browser2.close();
    }

    check('no page errors', pageErrs.length === 0, pageErrs);
  } finally {
    // restore the original save situation
    try { fs.unlinkSync(STATE_PATH); } catch (e) {}
    if (stashed !== null) fs.writeFileSync(STATE_PATH, stashed);
    try { await browser.close(); } catch (e) {}
  }

  console.log('\n' + passes + ' passed, ' + fails + ' failed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
