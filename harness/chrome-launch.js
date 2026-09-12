/* chrome-launch.js — one place that knows how to launch headless Chromium for
 * the harness. Resolves the binary (setup_chrome.sh provisioned) and merges the
 * flags this build needs (multi-process, in-process SwiftShader GPU).
 *
 *   const { launchBrowser, chromeArgs } = require('./chrome-launch');
 *   const browser = await launchBrowser(puppeteer, { protocolTimeout: 600000 });
 *
 * Override with CHROME_BIN=/path/to/chromium (must be a headless-capable
 * Chromium; system Chrome works too — the extra flags are harmless there).
 */
const fs = require('fs');
const path = require('path');

function chromeBin() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const p of ['/tmp/chrome/chromium',
                   path.join(__dirname, '.chrome', 'chromium')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Flags this Chromium build needs. Multi-process with the GPU in the browser
// process: renderer JS stays off the SwiftShader threads, so gl.finish() truly
// serializes and timings are stable. (--single-process, the serverless recipe,
// makes the renderer contend with software GL and produces multi-ms stalls
// that wander between passes — unusable for benchmarking.)
function chromeArgs(extra) {
  const base = ['--no-sandbox', '--in-process-gpu',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--disable-crashpad',
    '--no-crash-upload', '--disable-domain-reliability', '--no-pings'];
  const seen = new Set(base);
  for (const a of (extra || [])) if (!seen.has(a)) { base.push(a); seen.add(a); }
  return base;
}

async function launchBrowser(puppeteer, opts) {
  opts = opts || {};
  const bin = chromeBin();
  // No provisioned Chromium (setup_chrome.sh / CHROME_BIN): fall back to
  // puppeteer's own browser (a full `npm i puppeteer` downloads one). This
  // keeps owner machines with a regular puppeteer install working while
  // sandboxes use the provisioned binary.
  if (bin) {
    // The bundled libnss3 lives next to the binary (no $ORIGIN rpath), so
    // make sure the child process resolves it.
    const dir = path.dirname(bin);
    if (/tmp\/chrome/.test(dir) || fs.existsSync(path.join(dir, 'libnss3.so'))) {
      process.env.LD_LIBRARY_PATH = dir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');
    }
  }
  // Back-to-back launches on a loaded 2-CPU box flake intermittently (the
  // child dies during startup handshake with no stderr — teardown/launch
  // overlap). Retry with a cooldown; a genuinely broken binary still fails 3x.
  const tries = opts.launchTries || 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) {
      process.stderr.write(`[chrome-launch] retry ${i + 1}/${tries} after: ${lastErr && lastErr.message}\n`);
      await new Promise(r => setTimeout(r, 5000));
    }
    try {
      const launchOpts = Object.assign({
        headless: 'new',
        args: chromeArgs(opts.args),
      }, opts, { args: chromeArgs(opts.args) });
      if (bin) launchOpts.executablePath = bin;
      return await puppeteer.launch(launchOpts);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

module.exports = { chromeBin, chromeArgs, launchBrowser };
