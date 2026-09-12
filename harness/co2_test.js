const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const { launchBrowser }=require('./chrome-launch');
const DIR=path.join(__dirname,'..','planet');
(async()=>{
  const b=await launchBrowser(puppeteer,{protocolTimeout:200000});
  const page=await b.newPage(); const logs=[];
  page.on('console',m=>{const t=m.text(); if(/error|NaN/i.test(t))logs.push(t);});
  page.on('pageerror',e=>logs.push('ERR:'+e.message));
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const r=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    planet.params.substeps=2; planet.params.oceanScheme=0; planet.params.iceOn=1; planet.params.co2On=1;
    planet.params.co2Speed=20;
    function frame(){ planet.stepCO2(); for(let i=0;i<planet.params.substeps;i++) planet.step(); }
    // (1) globals sanity
    planet.stepCO2(); const g=planet.globals;
    const gsan={meanT:+g.meanT.toFixed(1),sstMean:+g.sstMean.toFixed(1),landT:+g.landT.toFixed(1),
      iceFreeLandFrac:+g.iceFreeLandFrac.toFixed(3),suitOcean:+g.suitOcean.toExponential(2),suitLand:+g.suitLand.toExponential(2)};
    // (2) baseline evolution ~120 frames
    const trace=[]; for(let i=0;i<120;i++){ frame(); if(i%30===0)trace.push({i,co2:+planet.params.co2.toFixed(1),gh:+planet.params.greenhouse.toFixed(3),bio:+planet.params.biomass.toFixed(0)}); }
    const base={co2:+planet.params.co2.toFixed(1),gh:+planet.params.greenhouse.toFixed(3)};
    // (3) responsiveness: crank volcanism 10x for 60 frames -> CO2 & greenhouse up
    planet.params.volcRate=0.5; planet.params.volcVar=0; for(let i=0;i<60;i++)frame();
    const hot={co2:+planet.params.co2.toFixed(1),gh:+planet.params.greenhouse.toFixed(3)};
    // (4) volcanism off -> CO2 falls
    planet.params.volcRate=0; for(let i=0;i<60;i++)frame();
    const cold={co2:+planet.params.co2.toFixed(1),gh:+planet.params.greenhouse.toFixed(3)};
    const finite = isFinite(planet.params.co2)&&isFinite(planet.params.greenhouse)&&isFinite(planet.params.biomass);
    return {gsan, trace, base, hot, cold, finite};
  },stateTxt);
  console.log(JSON.stringify(r,null,2));
  console.log('LOGS',JSON.stringify([...new Set(logs)].slice(0,6)));
  await b.close();
})();
