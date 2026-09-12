#!/usr/bin/env bash
# setup_chrome.sh — provision a headless Chromium for the harness.
#
# The sandbox has no system browser and the Chrome-for-Testing CDNs are
# unreachable, so we use the @sparticuz/chromium npm package, which bundles a
# headless Chromium + SwiftShader *inside the npm tarball* (registry.npmjs.org
# is reachable). This script inflates it to $CHROME_DIR (default /tmp/chrome).
#
#   ./setup_chrome.sh            # one-time per sandbox (fast, ~5 s + download)
#   CHROME_DIR=/tmp/chrome ./setup_chrome.sh
#
# The harness resolves the binary via $CHROME_BIN (default $CHROME_DIR/chromium)
# and the wrapper sets LD_LIBRARY_PATH for the bundled libnss3. See
# chrome-launch.js. Re-run after a sandbox restart (/tmp is not persisted).
set -euo pipefail
cd "$(dirname "$0")"
CHROME_DIR="${CHROME_DIR:-/tmp/chrome}"
export CHROME_DIR
mkdir -p "$CHROME_DIR"

if [ ! -d node_modules/puppeteer ]; then
  echo "setup_chrome: installing harness deps (browser download skipped)..." >&2
  PUPPETEER_SKIP_DOWNLOAD=1 npm install --no-audit --no-fund 2>&1 | tail -2
fi
if [ ! -d node_modules/@sparticuz/chromium ]; then
  echo "setup_chrome: installing @sparticuz/chromium from npm..." >&2
  npm install --no-audit --no-fund @sparticuz/chromium 2>&1 | tail -2
fi

node -e "
const z = require('zlib'), fs = require('fs'), path = require('path');
const bin = path.resolve('node_modules/@sparticuz/chromium/bin');
const out = process.env.CHROME_DIR;
for (const f of ['chromium.br', 'al2023.tar.br', 'swiftshader.tar.br']) {
  fs.writeFileSync(path.join(out, f.replace(/\.br$/, '')),
    z.brotliDecompressSync(fs.readFileSync(path.join(bin, f))));
}
console.log('inflated to ' + out);
"
tar -xf "$CHROME_DIR/al2023.tar" -C "$CHROME_DIR"
tar -xf "$CHROME_DIR/swiftshader.tar" -C "$CHROME_DIR"
mv "$CHROME_DIR"/lib/* "$CHROME_DIR"/ 2>/dev/null || true
rmdir "$CHROME_DIR/lib" 2>/dev/null || true
chmod +x "$CHROME_DIR/chromium"
rm -f "$CHROME_DIR"/*.tar

# Wrapper: guarantees the bundled NSS libs resolve without polluting the shell.
cat > "$CHROME_DIR/chrome.sh" <<EOF
#!/usr/bin/env bash
export LD_LIBRARY_PATH="$CHROME_DIR:\${LD_LIBRARY_PATH:-}"
exec "$CHROME_DIR/chromium" "\$@"
EOF
chmod +x "$CHROME_DIR/chrome.sh"

echo "CHROME_BIN=$CHROME_DIR/chromium"
LD_LIBRARY_PATH="$CHROME_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$CHROME_DIR/chromium" --version
echo "setup_chrome: OK — export CHROME_BIN=$CHROME_DIR/chromium"
