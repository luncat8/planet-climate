const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const { launchBrowser }=require('./chrome-launch');
const DIR=path.join(__dirname,'..','planet');
(async()=>{
  const b=await launchBrowser(puppeteer,{protocolTimeout:200000});
  const page=await b.newPage(); const logs=[];
  page.on('console',m=>{const t=m.text(); if(/error|NaN|WebGL/i.test(t))logs.push(t);});
  page.on('pageerror',e=>logs.push('ERR:'+e.message));
  await page.setContent('<canvas id="c" width="400" height="300"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const r=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    const gl=planet.gl, W=planet.grid.W,H=planet.grid.H, V=planet.grid.V;
    planet.params.substeps=1; planet.params.oceanScheme=0; planet.params.iceOn=1;
    const cellA=planet.readTex(planet.texCellA); const cellB=planet.readTex(planet.texCellB);
    function iceArr(){return planet.readTex(planet.iceTex());}
    function totalMass(a){let m=0;for(let i=0;i<V;i++)m+=a[i*4]*cellA[i*4+3];return m;}
    function stats(a){let nan=0,neg=0,fbad=0,maxT=0,cov=0;for(let i=0;i<V;i++){
      const t=a[i*4],f=a[i*4+1];
      if(!isFinite(t)||!isFinite(f))nan++; if(t<-1e-6)neg++; if(f<-1e-6||f>1.0001)fbad++;
      if(t>maxT)maxT=t; if(f>0.01)cov++;} return {nan,neg,fbad,maxT:+maxT.toFixed(2),coverCells:cov};}

    // (1) freeze-up from equilibrium
    for(let i=0;i<40;i++) planet.step();
    const a1=iceArr(); const s1=stats(a1);

    // (2) render ice modes -> GL error + nonzero
    function renderMode(m){planet.params.mode=m; planet.params.equirect=0; planet.render();
      gl.bindFramebuffer(gl.FRAMEBUFFER,null); const px=new Uint8Array(400*300*4);
      gl.readPixels(0,0,400,300,gl.RGBA,gl.UNSIGNED_BYTE,px); let nz=0;
      for(let i=0;i<px.length;i+=4) if(px[i]|px[i+1]|px[i+2])nz++; return {nz,ge:gl.getError()};}
    const rThk=renderMode(22), rFrac=renderMode(23), rOverlay=renderMode(1);

    // (3) pure-transport conservation: seed a blob, run ICE pass only (dThk=0)
    const seed=new Float32Array(W*H*4);
    for(let i=0;i<V;i++){ seed[i*4]= (cellB[i*4+3]<0.5)?2.0:0.0; seed[i*4+1]=(cellB[i*4+3]<0.5)?1.0:0.0; }
    planet.writeTex(planet.ice[0],seed); planet.writeTex(planet.ice[1],seed); planet.iceIdx=0;
    // zero the hand-off channel A[2].zw so stepIce does pure transport
    const a2=planet.readTex(planet.A[2]); for(let i=0;i<W*H;i++){a2[i*4+2]=0;a2[i*4+3]=0;} planet.writeTex(planet.A[2],a2);
    const m0=totalMass(iceArr());
    for(let i=0;i<60;i++){ planet.stepIce();
      const aa=planet.readTex(planet.A[2]); for(let k=0;k<W*H;k++){aa[k*4+2]=0;aa[k*4+3]=0;} planet.writeTex(planet.A[2],aa); }
    const aT=iceArr(); const mT=totalMass(aT); const sT=stats(aT);
    return {W,H,V, freeze:s1, rThk,rFrac,rOverlay,
      transport:{m0:+m0.toExponential(4), mT:+mT.toExponential(4),
        driftPct:+((mT-m0)/m0*100).toFixed(3), stats:sT}};
  },stateTxt);
  console.log(JSON.stringify(r,null,2));
  console.log('LOGS',JSON.stringify([...new Set(logs)].slice(0,8)));
  await b.close();
})();
