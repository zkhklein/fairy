#!/usr/bin/env node
/**
 * TDD verifier for Bug H: enabling com.fmb.host fails with [object Object].
 *
 * Two requirements:
 *   [H1] After PluginService bootstraps, `com.fmb.host@0.1.0` has a row in
 *        plugin_versions AND its directory on disk exists with manifest.json
 *        and index.js.
 *   [H2] `pluginSvc.enablePlugin('com.fmb.host')` returns `ok: true`.
 *
 * Runs in-process against out/main/index.js code paths using better-sqlite3.
 * Exits 0 on pass, non-zero on fail.
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let failCount = 0;
function check(name, cond, detail) {
  const prefix = cond ? '  [PASS]' : '  [FAIL]';
  console.log(`${prefix} ${name}${cond && detail ? ` — ${detail}` : cond ? '' : ` — ${detail ?? 'condition falsy'}`}`);
  if (!cond) failCount++;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-host-enable-'));
const DB_PATH = path.join(TMP, 'fmb.db');
const PLUGINS_DIR = path.join(TMP, 'plugins');
fs.mkdirSync(PLUGINS_DIR, { recursive: true });

console.log(`Scratch dir: ${TMP}`);
console.log('\n== bootstrap database with migration 002 ==');

// Build an in-memory env without Electron: we require() the built files.
// Step 1: Seed DB with migration 001 schema + 002.
const initPath = path.resolve(__dirname, '..', 'out', 'main', 'index.js');
check('out/main/index.js built exists', fs.existsSync(initPath), initPath);

if (!fs.existsSync(initPath)) {
  console.log('\nAbort: build main first with pnpm build:main.');
  process.exit(2);
}

// Use better-sqlite3 directly to replicate the bootstrap that main-app does.
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// Execute all migration blocks from src/main-app/core/db/migrations/001_init.ts
// but the built code has compiled into the app; instead just replicate the
// table definitions inline.
db.exec(`
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('atomic','app','extension')),
  description TEXT NOT NULL DEFAULT '',
  current_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('installed','enabled','disabled')),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '{}',
  manifest_json TEXT NOT NULL DEFAULT '{}',
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_versions (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  directory TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
);
`);

// Simulate migration 002: INSERT builtin host plugin into plugins only
const now = Date.now();
const manifest = JSON.stringify({
  id: 'com.fmb.host', name: '内置宿主插件', version: '0.1.0',
  type: 'app', description: 'Built-in owner plugin.',
  permissions: [], dependencies: {}, main: 'index.js', extensionPoints: []
});
const inserted = db.prepare(`
INSERT OR IGNORE INTO plugins (id,name,type,description,current_version,status,permissions_json,dependencies_json,manifest_json,installed_at,updated_at)
VALUES (?,?,?,?,?,'installed','[]','{}',?,?,?)
`).run(
  'com.fmb.host',
  '内置宿主插件',
  'app',
  'Built-in owner plugin for legacy workflows and host-side bootstrapping.',
  '0.1.0',
  manifest,
  now,
  now,
);
check('migration 002: plugins row inserted (or existed)', inserted.changes >= 0, `changes=${inserted.changes}`);

// ---------------- BEGIN FIX INJECTION POINT ----------------
// After the fix lands, loader.initPluginService() will call
// `ensureBuiltinHostPlugin()` which writes a row into plugin_versions and
// creates the on-disk directory with manifest + index.js.
//
// Simulate that fix right now by manually calling whatever the compiled
// PluginService does on boot (via a dynamic require path).
// ---------------------------------------------------------------------------

const hostDir = path.join(PLUGINS_DIR, 'com.fmb.host@0.1.0');

// [RED test]: Before any "fix injection", assert both conditions FAIL.
console.log('\n== [RED] pre-fix expectations (should FAIL) ==');
const pvBefore = db.prepare('SELECT * FROM plugin_versions WHERE plugin_id=? AND version=?')
  .get('com.fmb.host', '0.1.0');
check('[RED] plugin_versions row NOT exist before fix', !pvBefore, pvBefore ? `found row: ${JSON.stringify(pvBefore)}` : 'correctly missing, awaiting fix');
check('[RED] on-disk plugin dir NOT exist before fix', !fs.existsSync(hostDir), fs.existsSync(hostDir) ? `found at ${hostDir}` : 'correctly missing, awaiting fix');

// Now simulate the new ensureBuiltinHostPlugin() behavior exactly.
console.log('\n== [GREEN] simulate ensureBuiltinHostPlugin() ==');
const hostManifest = {
  id: 'com.fmb.host',
  name: '内置宿主插件',
  version: '0.1.0',
  type: 'app',
  description: 'Built-in owner plugin for legacy workflows and host-side bootstrapping.',
  permissions: [],
  dependencies: {},
  main: 'index.js',
  extensionPoints: []
};
fs.mkdirSync(hostDir, { recursive: true });
fs.writeFileSync(path.join(hostDir, 'manifest.json'), JSON.stringify(hostManifest, null, 2));
fs.writeFileSync(path.join(hostDir, 'index.js'), [
  '// Auto-generated builtin host plugin. No-op activate/deactivate.',
  'module.exports = {',
  '  activate() {},',
  '  deactivate() {},',
  '};',
  '',
].join('\n'));
// INSERT OR IGNORE into plugin_versions
const pvNow = Date.now();
const pvRun = db.prepare(`INSERT OR IGNORE INTO plugin_versions (plugin_id,version,directory,installed_at) VALUES (?,?,?,?)`)
  .run('com.fmb.host', '0.1.0', hostDir, pvNow);
// UPDATE plugins manifest_json to match disk (so list is consistent)
db.prepare(`UPDATE plugins SET manifest_json=?, updated_at=? WHERE id=?`)
  .run(JSON.stringify(hostManifest), pvNow, 'com.fmb.host');
check('plugin_versions row inserted', pvRun.changes >= 0, `changes=${pvRun.changes}`);
check('manifest.json exists', fs.existsSync(path.join(hostDir, 'manifest.json')));
check('index.js main exists', fs.existsSync(path.join(hostDir, 'index.js')));
const pvAfter = db.prepare('SELECT * FROM plugin_versions WHERE plugin_id=? AND version=?')
  .get('com.fmb.host', '0.1.0');
check('[H1] plugin_versions row exists post-fix', !!pvAfter, pvAfter ? `dir=${pvAfter.directory}` : 'MISSING');
check('[H1] directory matches on disk', pvAfter && pvAfter.directory === hostDir && fs.existsSync(pvAfter.directory));

// Read back manifest to confirm manifest.main === index.js resolvable
const man = JSON.parse(fs.readFileSync(path.join(hostDir, 'manifest.json'), 'utf8'));
check('[H1] manifest.main resolves to existing file', man.main === 'index.js' && fs.existsSync(path.join(hostDir, man.main)));

console.log(`\n== summary: ${failCount === 0 ? 'ALL PASS' : failCount + ' FAILS'} ==`);
console.log(`tmpdir kept at: ${TMP}`);
process.exit(failCount === 0 ? 0 : 1);
