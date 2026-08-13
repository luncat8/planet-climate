const puppeteer=require('puppeteer'); const path=require('path'); const fs=require('fs');
const DIR=path.resolve('../planet');
(async()=>{
  const b=await puppeteer.launch({headless:'new',protocolTimeout:200000,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await b.newPage(); const logs=[];
  page.on('pageerror',e=>logs.push('ERR:'+e.message));
  await page.setContent('<canvas id="c" width="64" height="64"></canvas>');
  for(const f of ['geodesics.js','shader.js','params.js','engine.js']) await page.addScriptTag({content:fs.readFileSync(path.join(DIR,f),'utf8')});
  const stateTxt=fs.readFileSync(path.join(DIR,'planet_state.js'),'utf8');
  const r=await page.evaluate(async(stateTxt)=>{
    Math.random=()=>0.5; window.requestAnimationFrame=()=>0; (0,eval)(stateTxt); const st=window.PLANET_STATE;
    const planet=new Planet(document.getElementById('c'),st.level);
    planet.applyState(decodePlanetState(st));
    planet.params.substeps=1; planet.params.iceOn=1;
    for(let i=0;i<60;i++) planet.step();
    const V=planet.grid.V;
    const iceBefore=planet.readTex(planet.iceTex());
    const oceanBefore=planet.readTex(planet.A[0]);
    // round-trip through the file codec
    const enc=encodePlanetState(serialize_wrap(planet));
    function serialize_wrap(p){return p.serializeState();}
    const dec=decodePlanetState(enc);
    // apply to a FRESH planet
    const p2=new Planet(document.getElementById('c'),st.level);
    p2.applyState(dec);
    const iceAfter=p2.readTex(p2.iceTex());
    const oceanAfter=p2.readTex(p2.A[0]);
    let iceMax=0, ocMax=0;
    for(let i=0;i<V;i++){
      iceMax=Math.max(iceMax, Math.abs(iceBefore[i*4]-iceAfter[i*4]), Math.abs(iceBefore[i*4+1]-iceAfter[i*4+1]));
      ocMax=Math.max(ocMax, Math.abs(oceanBefore[i*4+1]-oceanAfter[i*4+1]));  // Ts
    }
    // count nonzero ice to prove it wasn't just all-zero
    let nz=0; for(let i=0;i<V;i++) if(iceBefore[i*4]>0.01)nz++;
    return {iceCellsBefore:nz, maxIceDiff:iceMax, maxOceanTsDiff:ocMax};
  },stateTxt);
  console.log(JSON.stringify(r,null,2));
  console.log('ERR',JSON.stringify(logs.slice(0,5)));
  await b.close();
})();
