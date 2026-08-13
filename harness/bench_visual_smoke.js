const puppeteer=require('puppeteer'); const path=require('path');
const url='file://'+path.resolve('../planet/bench.html')+'?fast=1&noauto=1';
(async()=>{
  const b=await puppeteer.launch({headless:'new',protocolTimeout:300000,
    args:['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const page=await b.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push('ERR:'+e.message));
  page.on('console',m=>{const t=m.text(); if(/error/i.test(t))errs.push(t);});
  await page.goto(url,{waitUntil:'load'}); await page.bringToFront();
  await page.evaluate(()=>{ document.getElementById('levels').value='5';
    document.getElementById('subs').value='4'; document.getElementById('parts').value='4'; });
  await page.click('#run');
  await page.waitForFunction(()=>/Done|error/i.test(document.getElementById('status').textContent),{timeout:90000});
  const rows=await page.evaluate(()=>[...document.querySelectorAll('#tbl tbody tr')].map(tr=>
    [...tr.children].map(td=>td.textContent).join(' | ')));
  console.log('STATUS', await page.evaluate(()=>document.getElementById('status').textContent));
  console.log('ROWS ('+rows.length+'):\n'+rows.join('\n'));
  console.log('ERRORS',JSON.stringify([...new Set(errs)].slice(0,6)));
  await b.close();
})();
