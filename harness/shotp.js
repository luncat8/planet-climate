const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const DIR=path.resolve('../planet');
(async()=>{
  const b=await puppeteer.launch({headless:'new',protocolTimeout:200000,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await b.newPage();
  await page.setContent('<canvas id="c" width="900" height="900"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const shots=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    planet.cam={theta:0.9,phi:0.35,dist:2.5};
    planet.params.nightShading=0; planet.params.showClouds=0; planet.params.showLand=1;
    planet.params.flowAvg=1; planet.params.flowSmooth=0.9; planet.params.flowLines=1;
    planet.params.flowSegs=34; planet.params.flowRecycle=1; planet.params.flowMix=2;
    planet.params.flowLife=25; planet.params.flowUniform=1; planet.params.flowGain=2.5;
    const out={};
    function warm(dt,frames){ planet.stepSmooth(); planet.stepVFlow();
      for(let i=0;i<frames;i++){ planet.stepVFlow(); planet.stepFlow(dt); } }
    async function shot(name,p,dt,frames){ Object.assign(planet.params,p); warm(dt,frames); planet.render(); out[name]=planet.canvas.toDataURL('image/png'); }
    await shot('ocean_overturn', {mode:13, streamline:(1<<2)|(1<<3)}, 32768, 50);   // both ocean sublayers
    await shot('air_overturn',   {mode:12, streamline:(1<<0)|(1<<1)}, 16384, 50);   // both air sublayers
    return out;
  },stateTxt);
  for(const k of Object.keys(shots)) fs.writeFileSync(path.join('/home/user','v4_'+k+'.png'),Buffer.from(shots[k].split(',')[1],'base64'));
  await b.close(); console.log('done');
})();
