// TDD: Remove builtin virtual com.fmb.host plugin (Structural Verification)
//
// User requirement: "com.fmb.host 这个插件没必要就不要加上了"
// Goal: Completely remove the com.fmb.host builtin plugin:
//   1) No constant exported (project.ts)
//   2) No code that (re)creates com.fmb.host manifest/JS on disk (loader.ts ensureBuiltinHostPlugin)
//   3) No constructor call to ensureBuiltinHostPlugin (loader.ts constructor)
//   4) Workflow crud create() no longer defaults owner to 'com.fmb.host' → default null
//   5) DB migration 003 new: drop owner NOT NULL constraint, rewrite triggers to allow NULL,
//      backfill rows that still use com.fmb.host → NULL, hard-delete com.fmb.host plugin rows
//   6) pruneMissing no longer skips FMB_BUILTIN_HOST_PLUGIN_ID (constant gone)

const fs = require('fs');
const path = require('path');
const root = 'd:\\FAIRY';

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.stack || String(e))); fail++; } }
function eq(a, b, why) { if (a !== b) throw new Error((why || '') + ` want ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function inc(whole, part, why) { if (!String(whole).includes(String(part))) throw new Error((why || '') + ` MISSING: ${JSON.stringify(String(part).slice(0,120))}`); }
function ninc(whole, part, why) { if (String(whole).includes(String(part))) throw new Error((why || '') + ` UNWANTED PRESENCE: ${JSON.stringify(String(part).slice(0,160))}`); }

const project = fs.readFileSync(path.join(root, 'src/shared/project.ts'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'src/main-app/core/plugin/loader.ts'), 'utf8');
const crud = fs.readFileSync(path.join(root, 'src/main-app/core/workflow/crud.ts'), 'utf8');
const mig001 = fs.readFileSync(path.join(root, 'src/main-app/core/db/migrations/001_init.ts'), 'utf8');
const migFileNames = fs.readdirSync(path.join(root, 'src/main-app/core/db/migrations')).map(f => f.toLowerCase());
const migrationRegistry = mig001; // migrations array lives at bottom of 001_init.ts
// Also read any new migration file (003) if present
let mig003Content = '';
const mig003Path = migFileNames.find(n => /003.*remove.*host|003.*host|003.*owner|003.*drop/.test(n)) ||
                   (fs.existsSync(path.join(root, 'src/main-app/core/db/migrations/003_remove_host_plugin.ts'))
                    ? '003_remove_host_plugin.ts' : null);
if (mig003Path) mig003Content = fs.readFileSync(path.join(root, 'src/main-app/core/db/migrations', mig003Path), 'utf8');

console.log('\n==== Phase A: Structural — Remove com.fmb.host builtin virtual plugin ====\n');

// 1) project.ts no longer exports FMB_BUILTIN_HOST_PLUGIN_ID constant
t('R1: project.ts — removed FMB_BUILTIN_HOST_PLUGIN_ID constant export', () => {
  ninc(project, 'FMB_BUILTIN_HOST_PLUGIN_ID', 'R1');
});
t('R2: project.ts — removed FMB_BUILTIN_HOST_PLUGIN_NAME constant export', () => {
  ninc(project, 'FMB_BUILTIN_HOST_PLUGIN_NAME', 'R2');
});

// 2) loader.ts: ensureBuiltinHostPlugin method should be GONE, no import of constant, no call in constructor
t('R3: loader.ts — no import of FMB_BUILTIN_HOST_PLUGIN_ID / FMB_BUILTIN_HOST_PLUGIN_NAME from @shared/project', () => {
  ninc(loader, "from '@shared/project';", 'R3 (still imports project for host-constants)');
  ninc(loader, 'FMB_BUILTIN_HOST_PLUGIN_ID', 'R3 still references constant');
  ninc(loader, 'FMB_BUILTIN_HOST_PLUGIN_NAME', 'R3 still references name constant');
});
t('R4: loader.ts — method ensureBuiltinHostPlugin removed entirely (no disk creation of com.fmb.host plugin)', () => {
  ninc(loader, 'ensureBuiltinHostPlugin', 'R4 method still declared or called');
});
t('R5: loader.ts — constructor no longer calls ensureBuiltinHostPlugin (check constructor body)', () => {
  const consMatch = loader.match(/constructor\s*\(\s*opts[\s\S]*?\)\s*:\s*\{[\s\S]*?\n\s*\}\s*\n\s*(?:private|public|async\s+rescan|rescan\s*\(|get\s|list\s*\()/);
  const consBody = consMatch ? consMatch[0] : '';
  ninc(consBody || loader, 'ensureBuiltinHostPlugin', 'R5 constructor still calls ensureBuiltinHostPlugin');
});
t('R6: loader.ts — pruneMissing no longer has if (row.id === FMB_BUILTIN_HOST_PLUGIN_ID) skip guard', () => {
  // pruneMissing definition anchor
  const pmMatch = loader.match(/(?:private\s+)?async\s+pruneMissing\b[\s\S]*?\)\s*:\s*Promise/);
  const start = pmMatch ? loader.indexOf(pmMatch[0]) : loader.indexOf('pruneMissing');
  const body = start > 0 ? loader.slice(start, start + 4000) : loader;
  ninc(body, 'FMB_BUILTIN_HOST_PLUGIN_ID', 'R6 pruneMissing still skips builtin host id explicitly (should no longer exist)');
});

// 3) Workflow create default
t('R7: workflow crud.ts — create() no longer defaults owner_plugin_id to \'com.fmb.host\'', () => {
  // Find the create() method body where owner_plugin_id is set
  const createMatch = crud.match(/owner_plugin_id\s*:\s*[^,\n}]+/g) || [];
  const allHits = createMatch.join('\n');
  ninc(allHits, "'com.fmb.host'", 'R7 create still has string literal com.fmb.host as default owner');
  ninc(allHits, '"com.fmb.host"', 'R7 create still has double-quoted com.fmb.host default');
  // Now verify a null-like default is used: should be `ownerPluginId ?? data.owner_plugin_id ?? null`
  // (Either explicit null or no default at all is OK.)
  const hasNullDefault = /owner_plugin_id\s*:\s*(?:ownerPluginId\s*\?\?\s*)?(?:data\.owner_plugin_id\s*\?\?\s*)?(?:null|undefined)/.test(crud);
  eq(hasNullDefault, true, 'R7 create default owner must resolve to null/undefined when no owner provided');
});

// 4) Migration registry has new 003 entry that removes com.fmb.host + relaxes NOT NULL + rewrites triggers
t('R8: Migration registry (MIGRATIONS array) — new entry 003 present (remove_host_plugin / drop_host_not_null etc.)', () => {
  // Registry lives in 001_init.ts bottom
  const regBlock = mig001.match(/export\s+const\s+MIGRATIONS\s*:\s*Migration\[\]\s*=\s*\[([\s\S]*)\];\s*$/)?.[1] ?? '';
  // Count entries: each `{ name:` starts one entry
  const entryNames = [...regBlock.matchAll(/name\s*:\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
  // We expect at least 001_init.sql, 002_workflows_owner..., and now 003_remove_host...
  const has003 = entryNames.some(n => /003|remove.*host|host.*remove|drop.*host/.test(n));
  eq(has003, true, `R8 MIGRATIONS must include a 003 entry (found: [${entryNames.join(' | ')}])`);
  // Also ensure migration FILE exists (to be loaded - if referenced inline in registry, OK too)
});
t('R9: Migration 003 body — rebuilds workflows table with owner_plugin_id TEXT (no NOT NULL)', () => {
  const allMigSql = (mig001 + '\n' + mig003Content);
  // Must contain: create workflows_new, copy data, drop old, rename new → workflows; OR equivalent
  const rebuildHints = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?workflows_new[\s\S]*?owner_plugin_id\s+TEXT\b/i,
    /ALTER\s+TABLE\s+workflows_new\s+RENAME\s+TO\s+workflows/i,
    /DROP\s+TABLE\s+IF\s+EXISTS\s+workflows\b/i,
    /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+workflows_new\b/i,
  ];
  let hintsFound = 0;
  for (const rx of rebuildHints) if (rx.test(allMigSql)) hintsFound++;
  // Accept if 3+ hints present (actual rebuild strategy). Or we accept explicit column change via PRAGMA table_copy schema...
  // Alternative: direct PRAGMA foreign_keys=OFF + CREATE new + INSERT + DROP + RENAME pattern
  eq(hintsFound >= 3, true, `R9 need rebuild of workflows with nullable owner (found ${hintsFound}/4 rebuild indicators; allSql.len=${allMigSql.length})`);
});
t('R10: Migration 003 body — rewrites insert/update triggers for workflows to accept owner_plugin_id NULL', () => {
  const allMigSql = (mig001 + '\n' + mig003Content);
  // New trigger insert block should allow NULL:
  //   WHEN ( NEW.owner_plugin_id IS NOT NULL AND COALESCE((SELECT type FROM plugins WHERE id = NEW.owner_plugin_id), '') != 'app' )
  const triggerPatterns = [
    /trg_workflows_owner_app_insert[\s\S]{0,300}NEW\.owner_plugin_id\s+IS\s+NOT\s+NULL/i,
    /trg_workflows_owner_app_update[\s\S]{0,300}NEW\.owner_plugin_id\s+IS\s+NOT\s+NULL/i,
  ];
  let tpFound = 0;
  for (const rx of triggerPatterns) if (rx.test(allMigSql)) tpFound++;
  // Fallback: triggers dropped (DROP TRIGGER) + recreated with NULL check
  const droppedInsert = /DROP\s+TRIGGER[\s\S]*?trg_workflows_owner_app_insert/i.test(allMigSql);
  const droppedUpdate = /DROP\s+TRIGGER[\s\S]*?trg_workflows_owner_app_update/i.test(allMigSql);
  const recreate = tpFound === 2;
  eq((droppedInsert && droppedUpdate && recreate), true,
    `R10 triggers: dropInsert=${droppedInsert}, dropUpdate=${droppedUpdate}, recreateWithNULLguard=${recreate}`);
});
t('R11: Migration 003 body — backfills com.fmb.host workflow rows to NULL, then hard deletes host plugin rows', () => {
  const allMigSql = (mig001 + '\n' + mig003Content);
  const updateToNull = /UPDATE\s+workflows\b[\s\S]{0,200}owner_plugin_id\s*=\s*NULL[\s\S]{0,200}'com\.fmb\.host'/i.test(allMigSql) ||
                      /UPDATE\s+workflows\b[\s\S]{0,200}owner_plugin_id\s*=\s*NULL[\s\S]{0,200}com\.fmb\.host/i.test(allMigSql);
  const deletePluginRow = /DELETE\s+FROM\s+plugins\b[\s\S]{0,200}'com\.fmb\.host'/i.test(allMigSql) ||
                          /DELETE\s+FROM\s+plugins\b[\s\S]{0,200}com\.fmb\.host/i.test(allMigSql);
  // Should also clean up plugin_versions and plugin_extensions (FK CASCADE may handle it, but mention)
  eq(updateToNull, true, 'R11 migration orphans workflows first: UPDATE workflows SET owner_plugin_id = NULL WHERE owner_plugin_id = com.fmb.host');
  eq(deletePluginRow, true, 'R11 migration deletes host plugin row: DELETE FROM plugins WHERE id = com.fmb.host');
});

console.log(`\n── Phase A: ${pass}/${pass+fail} passed ${fail===0?'—— ALL GREEN ✅':'—— '+fail+' FAILURES ❌'}`);
process.exit(fail === 0 ? 0 : 1);
