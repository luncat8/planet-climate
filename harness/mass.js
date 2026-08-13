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
    function read(tex,hh){const h=hh||H;const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
      const b=new Float32Array(W*h*4);gl.readPixels(0,0,W,h,gl.RGBA,gl.FLOAT,b);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return b;}
    const topV=read(planet.A[1]), topS=read(planet.A[0]), deepV=read(planet.A[3]), cellC=read(planet.texCellC);
    const hiA=read(planet.A[6]), loA=read(planet.A[4]);
    const cellA=read(planet.texCellA), nbrA=read(planet.texNbrA,H*6), nbrB=read(planet.texNbrB,H*6), cellB=read(planet.texCellB);
    function cT(i){const y=Math.floor(i/W);return [i-y*W,y];}
    function xf(v,z,w){return [v[0]*z-v[1]*w,v[1]*z+v[0]*w];}
    function dt(a,b){return a[0]*b[0]+a[1]*b[1];}
    // flux divergence div(h*u) using the model's FV face stencil
    function fluxDiv(vel, hfn, cell){
      const [cx,cy]=cT(cell); const area=cellA[(cy*W+cx)*4+3]; const land=cellB[(cy*W+cx)*4+3];
      let f=0;
      for(let k=0;k<6;k++){const base=((cy*W+cx)+k*W*H)*4; if(nbrA[base+3]<0.5)continue;
        const j=Math.round(nbrA[base]); const L=nbrA[base+1]; const [jx,jy]=cT(j);
        const nb=[nbrB[base],nbrB[base+1],nbrB[base+2],nbrB[base+3]]; const landj=cellB[(jy*W+jx)*4+3];
        const wet=(1-landj)*(1-land);
        const h0=hfn(cell), hj=hfn(j); const hFace=0.5*(h0+hj);
        const v0=[vel[(cy*W+cx)*4],vel[(cy*W+cx)*4+1]];
        const vj=xf([vel[(jy*W+jx)*4],vel[(jy*W+jx)*4+1]],nb[2],nb[3]);
        const un=0.5*dt([0.5*(v0[0]+vj[0]),0.5*(v0[1]+vj[1])],[nb[0],nb[1]]);
        f+=hFace*un*L*wet;}
      return f/Math.max(area,1);}
    const hTop=cell=>topS[(cT(cell)[1]*W+cT(cell)[0])*4];
    const Dof=cell=>cellC[(cT(cell)[1]*W+cT(cell)[0])*4];
    const eta=cell=>topS[(cT(cell)[1]*W+cT(cell)[0])*4+3];
    const hDeep=cell=>Dof(cell)+eta(cell)-hTop(cell);
    function stats(name, aArr, bArr){
      let opp=0,same=0,b0=0,n=0,sA=0,sB=0,sAA=0,sBB=0,sAB=0, closureSum=0, closureMax=0;
      let maxSpdA=0,maxSpdB=0;
      for(let c=0;c<V;c++){const [x,y]=cT(c); if(cellB[(y*W+x)*4+3]>0.5)continue;
        const a=aArr[c], b=bArr[c];
        const sa=Math.hypot(topV[(y*W+x)*4],topV[(y*W+x)*4+1]); // placeholder not used
        if(!isFinite(a)||!isFinite(b))continue;
        if(Math.abs(a)<1e-12 && Math.abs(b)<1e-12){b0++;continue;}
        if((a>0&&b<0)||(a<0&&b>0))opp++; else if((a>0&&b>0)||(a<0&&b<0))same++;
        sA+=a;sB+=b;sAA+=a*a;sBB+=b*b;sAB+=a*b;n++;
        closureSum+=a+b; const ca=Math.abs(a+b); if(ca>closureMax)closureMax=ca;}
      const corr=sAB/Math.max(1e-30,Math.sqrt(sAA*sBB));
      return {name, n, oppPct:+(100*opp/(opp+same)).toFixed(1), samePct:+(100*same/(opp+same)).toFixed(1), b0Pct:+(100*b0/V).toFixed(1),
        corr:+(corr).toFixed(3), meanA:+(sA/n).toExponential(2), meanB:+(sB/n).toExponential(2),
        closureMean:+(closureSum/n).toExponential(2), closureMax:+(closureMax).toExponential(2)};
    }
    // build per-cell arrays
    const oTop=[],oDeep=[],oTopPlain=[],oDeepPlain=[];
    const aHi=[],aLo=[];
    let maxTopSpd=0,maxDeepSpd=0;
    for(let c=0;c<V;c++){const [x,y]=cT(c); if(cellB[(y*W+x)*4+3]>0.5){oTop[c]=0;oDeep[c]=0;aHi[c]=0;aLo[c]=0;continue;}
      oTop[c]=fluxDiv(topV,hTop,c); oDeep[c]=fluxDiv(deepV,hDeep,c);
      aHi[c]=fluxDiv(hiA, ()=>1, c); aLo[c]=fluxDiv(loA, ()=>1, c); // air: use unit thickness -> = plain div
      const ts=Math.hypot(topV[(y*W+x)*4],topV[(y*W+x)*4+1]); if(ts>maxTopSpd)maxTopSpd=ts;
      const ds=Math.hypot(deepV[(y*W+x)*4],deepV[(y*W+x)*4+1]); if(ds>maxDeepSpd)maxDeepSpd=ds;
    }
    return {
      oceanFlux: stats('ocean div(h*u): top vs deep', oTop, oDeep),
      airFlux:   stats('air div(u): high vs low (unit thickness)', aHi, aLo),
      maxTopSpeed:+maxTopSpd.toFixed(4), maxDeepSpeed:+maxDeepSpd.toFixed(4),
    };
  }, LEVEL, SAVE);
  await browser.close();
  console.log(JSON.stringify(res,null,1));
})().catch(e=>{console.error('FAIL',e);process.exit(1);});
