/* timing_diag.js — isolate whether save/load affects the PER-FRAME sim cost.
 * 1) time steps on a fresh planet (baseline ms/step)
 * 2) time serializeState()+encode (save op cost)
 * 3) time applyState()+decode (load op cost)
 * 4) time steps again after load (does per-step change?)
 */
const puppeteer = require('/media/sf_1/planet242/harness/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');
function arg(n, d){ const h=process.argv.find(a=>a.startsWith('--'+n+'=')); return h?h.slice(n.length+3):d; }
const DIR = arg('dir', '/media/sf_1/planet242/planet');
const LEVEL = parseInt(arg('level','5'),10);
const SAVE = arg('save', path.resolve(__dirname,'saves','equilibrium_L5.sav'));

(async () => {
  const browser = await puppeteer.launch({ headless:'new', protocolTimeout:600000,
    args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-gl=angle',
          '--use-angle=swiftshader','--disable-gpu-sandbox','--enable-webgl',
          '--ignore-gpu-blocklist','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('pageerror', e=>console.log('PAGEERROR',e.message));
  await page.setContent('<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas></body></html>');
  for (const f of ['geodesics.js','shader.js','params.js','engine.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR,f),'utf8') });

  const res = await page.evaluate(async (LEVEL, SAVE_JSON) => {
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; window.cancelAnimationFrame=()=>{};
    const planet = new Planet(document.getElementById('c'), LEVEL);
    const gl = planet.gl; while(gl.getError()!==gl.NO_ERROR){}
    function timeSteps(n){ const t0=performance.now(); for(let i=0;i<n;i++) planet.step(); gl.finish(); return performance.now()-t0; }
    const N=400;
    const tFresh = timeSteps(N);

    // separate the two halves of a save: GPU readback vs base64 encode
    let tSerialize=0, tEncode=0, enc=null, st=null;
    { const t0=performance.now(); st=planet.serializeState(); tSerialize=performance.now()-t0;
      const t1=performance.now(); enc=encodePlanetState(st); tEncode=performance.now()-t1; }

    // load op cost (decode + applyState)
    let tLoad=0;
    { const st=decodePlanetState(enc); const t0=performance.now(); planet.applyState(st); gl.finish(); tLoad=performance.now()-t0; }

    const tAfter = timeSteps(N);
    const saveBytes = JSON.stringify(enc).length;

    return { level:LEVEL, N,
      msPerStep_fresh:+(tFresh/N).toFixed(4),
      msPerStep_afterLoad:+(tAfter/N).toFixed(4),
      serialize_ms:+tSerialize.toFixed(2), encode_ms:+tEncode.toFixed(2),
      loadOp_ms:+tLoad.toFixed(2),
      saveBytesMB:+(saveBytes/1e6).toFixed(2) };
  }, LEVEL, fs.readFileSync(SAVE,'utf8'));

  await browser.close();
  console.log(JSON.stringify(res,null,2));
  const d = res.msPerStep_afterLoad - res.msPerStep_fresh;
  console.log('per-step delta after load:', d.toFixed(4), 'ms  (' + (d/res.msPerStep_fresh*100).toFixed(1) + '% change)');
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
