const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const DIR=path.resolve('../planet');
(async()=>{
  const b=await puppeteer.launch({headless:'new',protocolTimeout:200000,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await b.newPage(); page.on('pageerror',e=>console.log('ERR',e.message));
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const r=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    const P=planet.params;
    P.substeps=2; P.oceanScheme=0; P.iceOn=1; P.co2On=1;
    P.co2Speed=50; P.milankOn=1; P.milankPeriod=4000; P.milankAmp=9; P.climAlbedo=10; P.climCO2Sens=7;
    P.volcRate=0.08; P.oceanCO2K=4e-3;
    function frame(){ planet.stepCO2(); for(let i=0;i<P.substeps;i++) planet.step(); }
    const tr=[];
    for(let i=0;i<360;i++){ frame();
      if(i%20===0){ const g=planet.globals;
        tr.push({f:i, meanT:+(g.meanT-273.15).toFixed(1), iceFrac:+(100*g.iceFrac).toFixed(0),
          co2:+P.co2.toFixed(0), dT:+planet.climDTshift.toFixed(1)}); } }
    // amplitude of the swings
    const mts=tr.map(x=>x.meanT), ices=tr.map(x=>x.iceFrac);
    return {trace:tr, Tswing:+(Math.max(...mts)-Math.min(...mts)).toFixed(1),
      iceSwing:Math.max(...ices)-Math.min(...ices), finite:isFinite(P.co2)&&isFinite(P.greenhouse)};
  },stateTxt);
  console.log(JSON.stringify(r.trace));
  console.log('Tswing(°C)=',r.Tswing,' iceSwing(%)=',r.iceSwing,' finite=',r.finite);
  await b.close();
})();
