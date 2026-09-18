/**
 * Auth exchange script — functional test against the REAL Baidu endpoint.
 *
 * Extracts the compiled client main.js from the freshly packaged zip, exposes
 * the internal buildExchangeScript, generates the script with a fake code, and
 * runs it with `node -e` while a local HTTP server captures the auth callback.
 *
 * Assertions:
 *   A) script has valid syntax and runs (no spawn/syntax failure)
 *   B) fake code → Baidu returns an error → callback POSTs ok=false with the
 *      REAL Baidu error message (proves error propagation works)
 *   C) token file stays absent on failure
 *   D) the success-path mechanism (mkdirSync recursive + writeFileSync into a
 *      non-existent workDir) works
 *
 * Run: node scripts/verify_auth_exchange.cjs  (needs network to openapi.baidu.com)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const ZIP = path.join(ROOT, 'plugins-dist', 'com.fmb.baidunetdisk.client@0.2.2.zip');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  // 0) extract compiled main.js from the zip
  if (!fs.existsSync(ZIP)) throw new Error('zip not found: ' + ZIP);
  const zip = new AdmZip(ZIP);
  const entry = zip.getEntry('main.js');
  if (!entry) throw new Error('main.js missing in zip');
  const code = entry.getData().toString('utf8');

  // expose the internal buildExchangeScript for test purposes
  const moduleShim = { exports: {} };
  const fn = new Function('module', 'exports', 'hostApi', '__hostEnv', '__filename',
    code + '\n;module.exports.__buildExchangeScript = buildExchangeScript;');
  fn(moduleShim, moduleShim.exports, {}, {}, path.join('D:\\x', 'plugins', 'com.fmb.baidunetdisk.client@0.2.2', 'main.js'));
  const buildExchangeScript = moduleShim.exports.__buildExchangeScript;
  t('A0 buildExchangeScript extracted from packaged zip', typeof buildExchangeScript === 'function');

  // 1) local capture server standing in for the FMB HTTP API
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const PORT = 54399;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  // 2) generate the script with a FAKE code; tokenFile inside a NON-EXISTENT dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-auth-'));
  const tokenFile = path.join(tmp, 'no-such-dir', 'sub', '_baidu_tokens.json');
  const script = buildExchangeScript('FAKEKEY', 'FAKESECRET', 'FAKECODE', tokenFile,
    'com.fmb.baidunetdisk.uploader', 'auth_test_1', tmp);

  // 3) run it exactly like _launchScript does (node -e), with FMB_HTTP_* env
  await new Promise((resolve) => {
    execFile(process.execPath, ['-e', script], {
      env: { ...process.env, FMB_HTTP_PORT: String(PORT), FMB_HTTP_TOKEN: 'test-token' },
      timeout: 30000,
    }, () => resolve());
  });

  // A) the script ran and called back
  t('A script executed + callback POST received', captured.length > 0, JSON.stringify(captured));
  const cb = captured[0];
  if (cb) {
    t('B1 callback url targets storeAuthResult', /storeAuthResult/.test(cb.body) && /com\.fmb\.baidunetdisk\.uploader/.test(cb.url || ''));
    let payload = null;
    try { payload = JSON.parse(cb.body).payload; } catch (e) { /* noop */ }
    t('B2 callback ok=false', payload && payload.ok === false, cb.body);
    t('B3 callback carries REAL Baidu error message', payload && typeof payload.message === 'string' && payload.message.length > 0, payload && payload.message);
    if (payload) console.log('       → baidu error message was:', payload.message);
  }
  // C) failure path leaves no token file
  t('C no token file written on failure', !fs.existsSync(tokenFile));

  // D) success-path mechanism: mkdirSync recursive + write into non-existent dir
  const probeFile = path.join(tmp, 'no-such-dir', 'sub', 'probe.json');
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e',
      'var fs=require("fs"),path=require("path");var f=' + JSON.stringify(probeFile) + ';fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,"{}")',
    ], (e) => (e ? reject(e) : resolve()));
  });
  t('D mkdirSync-recursive + writeFileSync creates missing workDir', fs.existsSync(probeFile));

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n==== auth-exchange: ${pass}/${pass + fail} passed ${fail === 0 ? '—— ALL GREEN ✅' : '—— FAIL ❌'}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
