const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const DIR=path.resolve('../planet');
(async()=>{
  const b=await puppeteer.launch({headless:'new',protocolTimeout:200000,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await b.newPage(); const logs=[];
  page.on('console',m=>{const t=m.text(); if(/error|ERROR|NaN|WebGL/i.test(t))logs.push(t);});
  page.on('pageerror',e=>logs.push('ERR:'+e.message));
  await page.setContent('<canvas id="c" width="400" height="300"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const r=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    planet.params.substeps=1; planet.params.running=true; planet.params.streamline=15;
    planet.params.flowRecycle=1; planet.params.flowMix=2; planet.params.flowLife=15;
    const gl=planet.gl;
    function rd(t,w,h){const fb=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);
      const a=new Float32Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.FLOAT,a);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return a;}
    for(let i=0;i<30;i++) planet.loop();
    const out={pools:planet.pools.length, layerFrac:[], nan:0};
    for(const pool of planet.pools){
      const s=rd(pool.state[pool.idx],planet.PW,planet.PH);
      let l0=0,l1=0,nan=0,ageBad=0;
      const N=planet.PW*planet.PH;
      for(let c=0;c<N;c++){const w=s[c*4+3]; if(Number.isNaN(w)||Number.isNaN(s[c*4])){nan++;continue;}
        const layer=Math.floor(w+0.5); if(layer===0)l0++; else l1++;
        const age=w-Math.floor(w); if(age<0||age>=1) ageBad++;}
      const tr=rd(pool.trail[pool.idx],planet.PW,planet.PH*planet.PT);
      let trnan=0; for(let c=0;c<tr.length;c++) if(Number.isNaN(tr[c]))trnan++;
      out.layerFrac.push({pool:pool.cfg.name, sub0:+(l0/N).toFixed(2), sub1:+(l1/N).toFixed(2), nan, ageBad, trailNaN:trnan});
    }
    // render both projections + a couple modes without error
    let err=null; try{ planet.params.mode=5; planet.render(); planet.params.equirect=1; planet.renderEquirect(400,300,planet.sunDir()); }catch(e){err=e.message;}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); const pix=new Uint8Array(400*300*4); gl.readPixels(0,0,400,300,gl.RGBA,gl.UNSIGNED_BYTE,pix);
    let nz=0; for(let i=0;i<pix.length;i+=4) if(pix[i]|pix[i+1]|pix[i+2])nz++;
    out.renderErr=err; out.glError=gl.getError()||null; out.nonZero=nz;
    return out;
  },stateTxt);
  console.log(JSON.stringify(r,null,2));
  console.log('LOGS',JSON.stringify([...new Set(logs)].slice(0,8)));
  await b.close();
})();
