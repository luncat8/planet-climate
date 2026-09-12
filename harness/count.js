const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const { launchBrowser }=require('./chrome-launch');
const DIR=path.join(__dirname,'..','planet');
(async()=>{
  const b=await launchBrowser(puppeteer,{protocolTimeout:200000});
  const page=await b.newPage(); const logs=[];
  page.on('console',m=>{const t=m.text(); if(/error|NaN|WebGL/i.test(t))logs.push(t);});
  page.on('pageerror',e=>logs.push('ERR:'+e.message));
  await page.setContent('<canvas id="c" width="300" height="200"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const r=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    planet.params.substeps=1; planet.params.running=true; planet.params.streamline=15;
    const out={steps:[]};
    function rd(t,w,h){const fb=planet.gl.createFramebuffer();const gl=planet.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
      const a=new Float32Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,a);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return a;}
    function physFinger(){ // sample ocean topV to prove physics untouched
      const s=rd(planet.A[1],planet.grid.W,planet.grid.H); let sum=0; for(let i=0;i<200;i++) sum+=s[i*4]; return sum; }
    function snap(tag){
      let nan=0; for(const p of planet.pools){const s=rd(p.state[p.idx],planet.PW,planet.PH);
        for(let c=0;c<planet.PW*planet.PH*4;c++) if(Number.isNaN(s[c]))nan++;}
      out.steps.push({tag,PW:planet.PW,PH:planet.PH,perPool:planet.PW*planet.PH,nan,phys:+physFinger().toFixed(6)});
    }
    for(let i=0;i<10;i++) planet.loop(); snap('default(16k)');
    planet.params.flowParticles=4;  planet.rebuildPools(); for(let i=0;i<10;i++) planet.loop(); snap('4k');
    planet.params.flowParticles=64; planet.rebuildPools(); for(let i=0;i<10;i++) planet.loop(); snap('64k');
    let err=null; try{ planet.render(); }catch(e){err=e.message;} out.renderErr=err; out.glError=planet.gl.getError()||null;
    return out;
  },stateTxt);
  console.log(JSON.stringify(r,null,2));
  console.log('LOGS',JSON.stringify([...new Set(logs)].slice(0,6)));
  await b.close();
})();
