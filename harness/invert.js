const puppeteer = require('puppeteer');
const path = require('path'); const fs = require('fs');
const DIR = path.resolve(__dirname, '..', 'planet'); const LEVEL = 5;
const SAVE = fs.readFileSync(path.join(DIR, 'planet_state.js'), 'utf8');
(async () => {
  const browser = await puppeteer.launch({ headless:'new',
    args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--disable-gpu-sandbox','--enable-webgl','--ignore-gpu-blocklist','--disable-dev-shm-usage']});
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><canvas id="c" width="64" height="64"></canvas></body></html>');
  for (const f of ['geodesics.js','shader.js','params.js','engine.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(DIR, f), 'utf8') });
  const res = await page.evaluate(async (LEVEL, SAVE) => {
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0;
    const canvas=document.getElementById('c');
    const planet=new Planet(canvas,LEVEL); const gl=planet.gl;
    planet.applyState(window.decodePlanetState(window.readPlanetStateJS(SAVE)));
    const W=planet.grid.W,H=planet.grid.H,V=planet.grid.V;
    function read(tex){const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
      const b=new Float32Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.FLOAT,b);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return b;}
    const vv=planet.prog.velVert.use(); planet.gridUniforms(vv);
    vv.tex('uHiA',planet.A[6]).tex('uLoA',planet.A[4]).tex('uTopV',planet.A[1]).tex('uDeepV',planet.A[3]);
    planet.fullscreen('velVert',W,H); gl.finish();
    const vert=read(planet.texVert);
    function pair(chA, chB, tag){
      let opp=0, same=0, both0=0, n=0, sumA=0,sumB=0,sumAA=0,sumBB=0,sumAB=0;
      for(let c=0;c<V;c++){
        const a=vert[c*4+chA], b=vert[c*4+chB];
        if(!isFinite(a)||!isFinite(b)) continue;
        const aa=Math.abs(a), ab=Math.abs(b);
        if(aa<1e-12 && ab<1e-12){both0++; continue;}
        if((a>0&&b<0)||(a<0&&b>0)) opp++;
        else if((a>0&&b>0)||(a<0&&b<0)) same++;
        sumA+=a; sumB+=b; sumAA+=a*a; sumBB+=b*b; sumAB+=a*b; n++;
      }
      const denom=Math.sqrt((sumAA-n*0)*(sumBB-n*0)); // crude
      const corr = (sumAB - n*0) / Math.max(1e-30, Math.sqrt((sumAA)*(sumBB)));
      return {tag, n, oppositeSignPct:+(100*opp/(opp+same)).toFixed(1), sameSignPct:+(100*same/(opp+same)).toFixed(1), bothNearZeroPct:+(100*both0/V).toFixed(1), corr:+(corr).toFixed(3), meanA:+(sumA/n).toExponential(2), meanB:+(sumB/n).toExponential(2)};
    }
    return {
      air:   pair(0,1,'high-vs-low air'),
      ocean: pair(2,3,'ocean-top-vs-deep ocean'),
    };
  }, LEVEL, SAVE);
  await browser.close();
  console.log(JSON.stringify(res,null,1));
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
