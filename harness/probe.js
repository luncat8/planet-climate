const puppeteer = require('puppeteer');
const { launchBrowser } = require('./chrome-launch');
(async () => {
  const browser = await launchBrowser(puppeteer);
  const page = await browser.newPage();
  page.on('console', m => console.log('  [page]', m.text()));
  const r = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok:false, why:'no webgl2' };
    return {
      ok:true,
      ver: gl.getParameter(gl.VERSION),
      renderer: gl.getParameter(gl.RENDERER),
      colorFloat: !!gl.getExtension('EXT_color_buffer_float'),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      vertUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      drawBufs: gl.getParameter(gl.MAX_DRAW_BUFFERS),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  });
  console.log(JSON.stringify(r,null,2));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
