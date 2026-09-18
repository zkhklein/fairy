/**
 * Quick syntax check: extract buildUploadScript from the baidunetdisk client
 * plugin source, generate the inline node -e upload script with dummy params,
 * and syntax-check it via new Function (no execution).
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'plugins-source', 'baidu-netdisk-uploader', 'atomic', 'baidunetdisk', 'main.ts'),
  'utf8'
);

const start = src.indexOf('function buildUploadScript');
if (start < 0) { console.error('FAIL: buildUploadScript not found'); process.exit(1); }
// Function ends at the first "\n}\n" after the `.join('');` terminator.
const joinIdx = src.indexOf(".join('');", start);
if (joinIdx < 0) { console.error('FAIL: join terminator not found'); process.exit(1); }
const end = src.indexOf('\n}', joinIdx);
if (end < 0) { console.error('FAIL: function end not found'); process.exit(1); }
const fnSrc = src.slice(start, end + 3);

// Strip TS type annotations from the signature so plain node can eval it.
const jsFn = fnSrc.replace(
  /function buildUploadScript\([^)]*\)/,
  'function buildUploadScript(localFolder, remotePath, appKey, secretKey, tokenFile, callbackPluginId, requestId, fmbDataDir, bduss, concurrency)'
);

const script = eval(
  '(' + jsFn + ')("D:\\\\tmp\\\\fmb-syntax-check", "/apps/test/dir", "ak", "sk", "D:\\\\tmp\\\\tok.json", "com.fmb.baidunetdisk.uploader", "up_test", "D:\\\\tmp", "", 8)'
);

// Default (no concurrency arg) must fall back to 4.
const scriptDefault = eval(
  '(' + jsFn + ')("D:\\\\tmp\\\\fmb-syntax-check", "/apps/test/dir", "ak", "sk", "D:\\\\tmp\\\\tok.json", "com.fmb.baidunetdisk.uploader", "up_test", "D:\\\\tmp", "")'
);

try {
  new Function(script);
  console.log('ok   upload script syntax valid, length=' + script.length);
} catch (e) {
  console.error('FAIL syntax: ' + e.message);
  fs.writeFileSync(path.join(__dirname, '_upload_script_debug.js'), script);
  console.error('script dumped to scripts/_upload_script_debug.js');
  process.exit(1);
}

// Sanity assertions on the generated script body.
const must = ['var CONC=8;', 'MAXTRY=4', 'setTimeout(120000', 'uploadedBytesBase', 'pump()', 'function doCreate'];
let bad = 0;
for (const m of must) {
  if (!script.includes(m)) { console.error('FAIL missing snippet: ' + m); bad++; }
}
if (!scriptDefault.includes('var CONC=4;')) { console.error('FAIL default concurrency is not 4'); bad++; }
if (bad) process.exit(1);
console.log('ok   all expected snippets present (configurable concurrency/retry/timeout/bytes progress)');
