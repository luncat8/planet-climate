const puppeteer=require('puppeteer'); const path=require('path');
const { launchBrowser }=require('./chrome-launch');
const url='file://'+path.resolve('../planet/bench.html')+'?fast=1&noauto=1';
(async()=>{
  const b=await launchBrowser(puppeteer,{protocolTimeout:300000,
    args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const page=await b.newPage(); const errs=[];
  page.on('pageerror',e=>errs.push('ERR:'+e.message));
  page.on('console',m=>{const t=m.text(); if(/error/i.test(t))errs.push(t);});
  await page.goto(url,{waitUntil:'load'}); await page.bringToFront();
  await page.evaluate(()=>{
    document.getElementById('levels').value='5';
    document.getElementById('subs').value='1';
    document.getElementById('parts').value='1';
    document.getElementById('partsB').value=''; // omit the optional 64k comparison
    // A benchmark Planet must never enter its normal rAF loop.
    window.__benchLoopCalls = 0;
    const loop = Planet.prototype.loop;
    Planet.prototype.loop = function () { window.__benchLoopCalls++; return loop.apply(this, arguments); };
    // Exercise the preferred Clipboard API without granting host permissions.
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{
      writeText: text => { window.__benchClipboard = text; return Promise.resolve(); }
    }});
  });
  await page.click('#run');
  await page.waitForFunction(()=>/Done|error/i.test(document.getElementById('status').textContent),{timeout:90000});
  const rows=await page.evaluate(()=>[...document.querySelectorAll('#tbl tbody tr')].map(tr=>
    [...tr.children].map(td=>td.textContent).join(' | ')));
  const completion=await page.evaluate(()=>({
    visible: !document.getElementById('complete').hidden,
    label: document.getElementById('copy').textContent,
    loopCalls: window.__benchLoopCalls,
  }));
  if (!completion.visible || completion.label !== 'copy to clipboard')
    throw new Error('completion copy control was not shown after a successful run');
  if (completion.loopCalls !== 0)
    throw new Error('benchmark entered Planet\'s live rAF loop ' + completion.loopCalls + ' time(s)');
  await page.click('#copy');
  await page.waitForFunction(()=>document.getElementById('copyStatus').textContent === 'Copied.');
  const copied=await page.evaluate(()=>window.__benchClipboard || '');
  if (!/^# Planet visual benchmark\n# completed UTC: .+\n# renderer: .+/m.test(copied) ||
      copied.indexOf('level\tscheme\tsubsteps') < 0 || copied.indexOf('Draw sweep (ms)') < 0)
    throw new Error('copied benchmark log is incomplete');
  // file:// may reject the async Clipboard API; verify the textarea fallback too.
  await page.evaluate(()=>{
    Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{
      writeText: () => Promise.reject(new Error('permission denied'))
    }});
    document.execCommand = command => {
      window.__benchFallbackClipboard = document.querySelector('textarea').value;
      return command === 'copy';
    };
  });
  await page.click('#copy');
  await page.waitForFunction(()=>document.getElementById('copyStatus').textContent === 'Copied.');
  const fallback=await page.evaluate(()=>window.__benchFallbackClipboard || '');
  if (fallback.indexOf('# Planet visual benchmark') !== 0 || fallback.indexOf('Draw sweep (ms)') < 0)
    throw new Error('clipboard permission fallback is incomplete');
  console.log('STATUS', await page.evaluate(()=>document.getElementById('status').textContent));
  console.log('COPY', completion.label + '; ' + copied.split('\n').slice(0,3).join(' | '));
  console.log('ROWS ('+rows.length+'):\n'+rows.join('\n'));
  console.log('ERRORS',JSON.stringify([...new Set(errs)].slice(0,6)));
  await b.close();
})();
