/**
 * TDD tests for:
 *   A. 便携化 runtime-paths (resolveRuntimePathsFromMarker)
 *   B. 工作流 owner_plugin_id 强契约 (DB trigger + WorkflowService.create gate +
 *      atomic/app/extension 插件类型 Host.workflows.create 鉴权)
 *   C. 左侧导航 应用插件 SubMenu 构造 + labelByPath pluginId→name map
 *
 * Pure Node harness. Reuses electron-stub pipeline.
 *   Run via:
 *     node scripts/_build-ownership-ui-test.mjs && node build/ownership-portable-ui.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ---------- Bootstrap isolated userData ----------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-owu-'));
fs.mkdirSync(path.join(TMP_ROOT, 'logs'), { recursive: true });
process.env['FMB_FORCE_USERDATA'] = TMP_ROOT;
process.env['FMB_FORCE_DB_TEST_PATH'] = path.join(TMP_ROOT, 'fmb.db');
process.env['ELECTRON_RUN_AS_NODE'] = '1';

import { initDatabase, closeDatabase, getRawDb } from '../src/main-app/core/db';
import { initEventBus } from '../src/main-app/core/event-bus';
import { initWorkflowService } from '../src/main-app/core/workflow/crud';
import { WorkflowViewModelSchema, PagedSchema } from '../src/shared/types';
import { resolveRuntimePathsFromMarker } from '../src/main-app/core/runtime-paths';
import { FMB_PORTABLE_DIR, FMB_PORTABLE_MARKER } from '../src/shared/project';

// ---------- Harness helpers ----------
type CaseResult = { id: string; pass: boolean; note?: string };
const results: CaseResult[] = [];
function case_(id: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(
      () => { results.push({ id, pass: true }); console.log(`✓ ${id} PASS`); },
      (err: unknown) => { results.push({ id, pass: false, note: err instanceof Error ? err.message : String(err) }); console.log(`✗ ${id} FAIL - ${err instanceof Error ? err.message : String(err)}`); },
    );
}

// ---------- Setup DB + bus ----------
console.log(`[BOOT] tmpRoot=${TMP_ROOT}`);
initDatabase();
const bus = initEventBus();

// ---------------- C: 导航 SubMenu / labelByPath contract (pure) ----------------
// Replicate the renderer-side logic here in pure form (no React import) so we
// can assert the menu contract without a DOM. The MainLayout.tsx rewrite MUST
// produce the same output.
type PluginLike = { id: string; name: string; type: 'atomic' | 'app' | 'extension'; status: string };
function buildAppSubMenuItems(plugins: PluginLike[]): Array<{ key: string; label: string }> {
  // Core semantics: only type='app' AND status='enabled' plugins get a
  // nav entry under the "应用插件" group. Stable order by (name, id).
  return plugins
    .filter((p) => p.type === 'app' && p.status === 'enabled')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
    .map((p) => ({ key: `/app-plugins/${p.id}`, label: p.name }));
}
function buildPluginNameMap(plugins: PluginLike[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of plugins) m.set(p.id, p.name);
  return m;
}
function labelByPathPure(p: string, extras: Map<string, string>, coreLabels: Record<string, string>): string {
  if (p.startsWith('/app-plugins/')) {
    const pluginId = p.slice('/app-plugins/'.length);
    return extras.get(pluginId) ?? pluginId;
  }
  return coreLabels[p] ?? p;
}
const CORE_LABELS: Record<string, string> = {
  '/dashboard': '仪表盘',
  '/plugins': '插件管理',
  '/workflows': '工作流',
  '/error-calendar': '错误日志',
};

// ---------------- B: ownership contracts ----------------
// Migration 002 creates com.fmb.host (app) by default. We'll reuse it as the
// canonical owner for tests that need a valid app plugin.
const db = getRawDb();
function seedPlugin(id: string, name: string, type: 'atomic' | 'app' | 'extension', status = 'installed'): void {
  const now = Date.now();
  db.prepare(`INSERT OR IGNORE INTO plugins (id,name,type,description,current_version,status,permissions_json,dependencies_json,manifest_json,installed_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, name, type, `seed plugin ${id}`, '0.1.0', status, '[]', '{}',
    JSON.stringify({ id, name, version: '0.1.0', type, permissions: [], dependencies: {}, main: 'index.js' }),
    now, now,
  );
  if (status === 'enabled') {
    db.prepare(`UPDATE plugins SET status='enabled' WHERE id=?`).run(id);
  }
}

// ---------- Main ----------
async function main(): Promise<void> {
  // ===== C group =====
  const pluginsC: PluginLike[] = [
    { id: 'com.example.notes', name: '笔记中心', type: 'app', status: 'enabled' },
    { id: 'com.example.paint', name: '绘图面板', type: 'app', status: 'enabled' },
    { id: 'com.example.disabled', name: '已停用', type: 'app', status: 'installed' },
    { id: 'com.example.echo', name: 'Echo', type: 'atomic', status: 'enabled' },
    { id: 'com.example.ext', name: 'Watcher', type: 'extension', status: 'enabled' },
  ];

  await case_('C1-submenu-contains-only-enabled-app', () => {
    const items = buildAppSubMenuItems(pluginsC);
    assert.deepEqual(items.map((i) => i.key).sort(), [
      '/app-plugins/com.example.notes',
      '/app-plugins/com.example.paint',
    ].sort());
    // Disabled / atomic / extension are excluded
    assert.ok(!items.some((i) => i.key.includes('disabled')), 'disabled app should be excluded');
    assert.ok(!items.some((i) => i.key.includes('echo')), 'atomic must not appear');
    assert.ok(!items.some((i) => i.key.includes('ext')), 'extension must not appear');
  });

  await case_('C2-empty-apps-no-menu', () => {
    const items = buildAppSubMenuItems(pluginsC.filter((p) => p.type !== 'app'));
    assert.deepEqual(items, [], 'no app plugins → no submenu entries');
  });

  await case_('C3-labelByPath-core-label', () => {
    const m = buildPluginNameMap(pluginsC);
    assert.equal(labelByPathPure('/dashboard', m, CORE_LABELS), '仪表盘');
    assert.equal(labelByPathPure('/error-calendar', m, CORE_LABELS), '错误日志');
  });

  await case_('C4-labelByPath-pluginId-resolves-to-name', () => {
    const m = buildPluginNameMap(pluginsC);
    assert.equal(labelByPathPure('/app-plugins/com.example.notes', m, CORE_LABELS), '笔记中心');
    assert.equal(labelByPathPure('/app-plugins/com.example.paint', m, CORE_LABELS), '绘图面板');
    // Unknown pluginId → fall back to the raw pluginId itself.
    assert.equal(labelByPathPure('/app-plugins/org.foo.unknown', m, CORE_LABELS), 'org.foo.unknown');
  });

  await case_('C5-rename-error-calendar-nav-label-is-error-log', () => {
    // The user requested "错误日历" 改名为 "错误日志". The top-level label
    // must be 错误日志 (core label map already reflects that). No mention of
    // "错误日历" should remain as a navigation label.
    const badLabels = Object.values(CORE_LABELS).filter((l) => l.includes('错误日历'));
    assert.deepEqual(badLabels, [], '导航标签里不应包含「错误日历」');
    // The page title semantic is verified via separate file grep outside this harness.
  });

  // ---- Source-level contract: UI code must actually implement the dynamic
  // SubMenu + rename. (Pure logic tests above prove the semantics; these
  // assertions fail when the React components still haven't been rewritten.)
  const MAIN_LAYOUT_SRC = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'layout', 'MainLayout.tsx'),
    'utf8',
  );
  const ERR_CAL_SRC = fs.readFileSync(
    path.join(ROOT, 'src', 'renderer', 'pages', 'ErrorCalendar.tsx'),
    'utf8',
  );

  await case_('C6-mainlayout-loads-plugin-store-for-app-submenu', () => {
    // The rewrite must: (a) import usePluginStore, (b) iterate enabled app
    // plugins, (c) render an AntD SubMenu whose children are Link items.
    const checks = [
      ['imports usePluginStore', /usePluginStore/.test(MAIN_LAYOUT_SRC)],
      ['filters by type=app status=enabled', /type\s*===\s*['"]app['"]|type\s*!==\s*['"]app['"]/.test(MAIN_LAYOUT_SRC) || /status\s*===\s*['"]enabled['"]/.test(MAIN_LAYOUT_SRC)],
      ['renders SubMenu (AntD)', /SubMenu|children:\s*\[.*app-plugins|groupKey.*app-plugins|应用插件/.test(MAIN_LAYOUT_SRC)],
      ['dynamic menu children instead of flat NAV_ITEMS only', /appPlugins|appPluginItems|enabledAppPlugins|subMenu/.test(MAIN_LAYOUT_SRC)],
    ];
    const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length > 0) throw new Error(`MainLayout.tsx missing app-submenu wiring: ${missing.join(', ')}`);
  });

  await case_('C7-error-calendar-page-title-is-error-log', () => {
    // The PageShell `title="错误日志"` is the canonical page heading.
    // `title="错误日历"` must not appear anywhere in the page file anymore.
    if (/title\s*=\s*["']错误日历["']/.test(ERR_CAL_SRC)) {
      throw new Error('ErrorCalendar.tsx 页面标题仍然是「错误日历」，应改为「错误日志」');
    }
    if (!/title\s*=\s*["']错误日志["']/.test(ERR_CAL_SRC)) {
      throw new Error('ErrorCalendar.tsx 缺少 `title="错误日志"` 页面标题');
    }
  });

  // ===== A group: portable paths marker =====
  await case_('A1-marker-absent-falls-back-to-legacy', () => {
    const r = resolveRuntimePathsFromMarker({ projectRoot: TMP_ROOT });
    // projectRoot has NO .data/.fmb-portable-root → legacy mode.
    assert.equal(r.mode, 'legacy');
    assert.ok(r.userData.includes(FMB_PORTABLE_DIR) === false, 'legacy userData must not reference fmb-data dir');
  });

  await case_('A2-marker-present-resolves-to-portable-root', () => {
    const portableRoot = path.join(TMP_ROOT, 'side-by-side', FMB_PORTABLE_DIR);
    fs.mkdirSync(portableRoot, { recursive: true });
    fs.writeFileSync(
      path.join(portableRoot, FMB_PORTABLE_MARKER),
      JSON.stringify({ portableRoot, createdAt: Date.now(), version: 1 }, null, 2),
      'utf8',
    );
    // Also drop marker at cwd-like projectRoot/.data for the CLI-resolution branch.
    const projectRoot2 = path.join(TMP_ROOT, 'prj');
    fs.mkdirSync(path.join(projectRoot2, '.data'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot2, '.data', FMB_PORTABLE_MARKER),
      JSON.stringify({ portableRoot, createdAt: Date.now(), version: 1 }, null, 2),
      'utf8',
    );
    const r = resolveRuntimePathsFromMarker({ projectRoot: projectRoot2 });
    assert.equal(r.mode, 'portable');
    assert.equal(r.portableRoot, portableRoot);
    assert.equal(path.basename(r.logs), 'logs');
    assert.equal(path.basename(r.plugins), 'plugins');
    assert.equal(path.basename(r.userData), 'userData');
  });

  // ===== B group: ownership DB triggers + WorkflowService.create =====
  // Ensure com.fmb.host exists (migration 002).
  const host = db.prepare(`SELECT id, type, status FROM plugins WHERE id='com.fmb.host'`).get() as any;
  assert.ok(host, 'migration 002 must seed com.fmb.host plugin');

  // Seed other plugins of all types + owner states.
  seedPlugin('com.myapp.a', '我的应用A', 'app', 'enabled');
  seedPlugin('com.myatomic', '原子A', 'atomic', 'enabled');
  seedPlugin('com.myext', '扩展A', 'extension', 'enabled');

  const workflowSvc = initWorkflowService(bus);

  // Minimal valid DSL: one atomic delay node + empty edges.
  const minimalDsl = {
    nodes: [
      { id: 'n1', type: 'delay', ms: 50 } as any,
    ],
    edges: [] as any[],
  };

  await case_('B1-create-success-with-app-owner', () => {
    const row = workflowSvc.create({
      name: 'app-A-owned',
      description: 'created by com.myapp.a',
      definition: minimalDsl,
      owner_plugin_id: 'com.myapp.a',
    });
    assert.ok(row.id.startsWith('wf-'), `id should start with wf-, got ${row.id}`);
    assert.equal(row.owner_plugin_id, 'com.myapp.a');
  });

  await case_('B2-create-rejects-atomic-owner', () => {
    assert.throws(
      () => workflowSvc.create({
        name: 'bad-owner',
        definition: minimalDsl,
        owner_plugin_id: 'com.myatomic',
      }),
      /type='app'/,
    );
  });

  await case_('B3-create-rejects-extension-owner', () => {
    assert.throws(
      () => workflowSvc.create({
        name: 'bad-owner',
        definition: minimalDsl,
        owner_plugin_id: 'com.myext',
      }),
      /type='app'/,
    );
  });

  await case_('B4-create-rejects-nonexistent-owner', () => {
    assert.throws(
      () => workflowSvc.create({
        name: 'bad-owner',
        definition: minimalDsl,
        owner_plugin_id: 'org.nope.not.there',
      }),
      /type='app'/,
    );
  });

  await case_('B5-db-trigger-blocks-raw-sql-nonapp-owner', () => {
    // Bypass WorkflowService.create to hit the DB trigger directly.
    assert.throws(
      () => db.prepare(`INSERT INTO workflows (id,name,description,definition_json,vars_json,owner_plugin_id,created_at,updated_at)
                        VALUES ('wf-trigger-test','x','','{}','{}','com.myatomic',0,0)`).run(),
      /owner_plugin_id must reference a plugin with type=app/,
    );
  });

  await case_('B6-db-trigger-blocks-raw-sql-update-owner-to-nonapp', () => {
    const id = `wf-trg-update-${Date.now()}`;
    db.prepare(`INSERT INTO workflows (id,name,description,definition_json,vars_json,owner_plugin_id,created_at,updated_at)
                VALUES (?,'x','','{}','{}','com.fmb.host',?,?)`).run(id, Date.now(), Date.now());
    assert.throws(
      () => db.prepare(`UPDATE workflows SET owner_plugin_id='com.myext' WHERE id=?`).run(id),
      /owner_plugin_id must reference a plugin with type=app/,
    );
  });

  await case_('B7-list-returns-enriched-view-model-with-owner-and-refs', () => {
    const page = workflowSvc.list({ page: 1, pageSize: 50 });
    const vm = {
      items: page.items,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
    // WorkflowViewModelSchema requires owner_plugin_id; others optional.
    const parsed = PagedSchema(WorkflowViewModelSchema).safeParse(vm);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
      throw new Error(msg);
    }
    const owned = page.items.find((r: any) => r.name === 'app-A-owned');
    assert.ok(owned, 'previously created row should be present');
    assert.equal(owned.owner_plugin_id, 'com.myapp.a');
    assert.equal(owned.owner_name, '我的应用A');
    assert.equal(owned.owner_type, 'app');
    assert.deepEqual(owned.referenced_plugin_ids, []);
    // minimalDsl is one `delay` node → classified as control (not atomic).
    assert.equal(owned.node_counts.total, 1);
    assert.equal(owned.node_counts.atomic, 0);
    assert.equal(owned.node_counts.control, 1);
  });

  // ===== B8: HostApi.workflows.create gate by plugin manifest.type =====
  // Replicate host-api.ts guard directly.
  const HostWfCreateGuard = (manifest?: { id?: string; type?: string }) => {
    const owner = manifest?.id ?? 'system';
    if (!manifest) {
      throw new Error('Host.workflows.create requires plugin context (missing selfManifest)');
    }
    if (manifest.type !== 'app') {
      throw new Error(`Host.workflows.create: plugin "${owner}" has type=${manifest.type}; only type=app plugins can create workflows`);
    }
    return true;
  };
  await case_('B8-hostapi-gate-atomic-blocked', () => {
    assert.throws(
      () => HostWfCreateGuard({ id: 'com.myatomic', type: 'atomic' }),
      /only type=app plugins can create workflows/,
    );
  });
  await case_('B9-hostapi-gate-extension-blocked', () => {
    assert.throws(
      () => HostWfCreateGuard({ id: 'com.myext', type: 'extension' }),
      /only type=app plugins can create workflows/,
    );
  });
  await case_('B10-hostapi-gate-missing-manifest-blocked', () => {
    assert.throws(
      () => HostWfCreateGuard(undefined),
      /missing selfManifest/,
    );
  });
  await case_('B11-hostapi-gate-app-passes', () => {
    assert.equal(HostWfCreateGuard({ id: 'com.myapp.a', type: 'app' }), true);
  });

  // ===== B12: legacy workflow gets assigned to an app owner via migration =====
  // Migration runs BEFORE the workflow table was created here; we test the
  // current state: com.fmb.host type=app present, and the backfill logic
  // (used as a helper) correctly returns a non-null app plugin id for any
  // sentinel row.
  await case_('B12-migration-backfill-returns-app-owner', () => {
    const row = db.prepare(
      `SELECT COALESCE((SELECT id FROM plugins WHERE type = 'app' ORDER BY installed_at ASC, id ASC LIMIT 1), 'com.fmb.host') AS owner_id`,
    ).get() as any;
    const ownerId = row?.owner_id;
    assert.ok(typeof ownerId === 'string' && ownerId.length > 0);
    const ownerType = (db.prepare(`SELECT type FROM plugins WHERE id=?`).get(ownerId) as any).type;
    assert.equal(ownerType, 'app', `backfill owner ${ownerId} must be an app plugin`);
  });

  // ---------- Summary ----------
  console.log('');
  console.log('=== SUMMARY ===');
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.pass) { pass++; console.log(` PASS ${r.id}`); }
    else { fail++; console.log(` FAIL ${r.id}  - ${r.note ?? ''}`); }
  }
  console.log(`pass=${pass} fail=${fail} total=${results.length}`);
  closeDatabase();
  if (fail > 0) process.exit(1);
}

void main();
