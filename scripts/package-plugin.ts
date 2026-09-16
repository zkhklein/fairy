/**
 * FMB plugin packager — compiles plugin TS sources into installable zips.
 *
 * For each plugin under `plugins-source/`:
 *   1. read `manifest.json`,
 *   2. esbuild-compile `manifest.main` (TS) → `main.js` (CJS, runs in the
 *      permission-wrapped vm sandbox; no externals because the sandbox blocks
 *      all `require`),
 *   3. for app plugins: esbuild-compile `manifest.renderer` (TS/TSX) →
 *      `renderer.umd.js` (CJS, react/react-dom/antd externalized — provided at
 *      runtime by the host's require shim). Rewrite the staged manifest's
 *      `renderer` field to point at the compiled bundle so the host skips
 *      recompiling it (T12-B fast-path: pre-compiled bundle wins).
 *   4. for app plugins with dependencies: recursively package every transitive
 *      dependency into a full installable zip and embed it under
 *      `bundled/<depId>@<depVersion>.zip` inside the app zip, so installing
 *      the single app zip is self-sufficient.
 *   5. write the staged `manifest.json` + `main.js` [+ `renderer.umd.js`]
 *      [+ `bundled/*.zip`] into a temp staging dir, then zip it to
 *      `plugins-dist/<id>@<version>.zip`.
 *
 * Usage:
 *   node scripts/package-plugin.ts            # build all plugins
 *   node scripts/package-plugin.ts app/demo-counter   # build only the named dir(s)
 *
 * Requires Node 22.6+ (type stripping for .ts) — the project already requires
 * Node >=20 and the dev toolchain runs Node 24.
 */
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins-source');
const DIST = path.join(ROOT, 'plugins-dist');
const STAGING_ROOT = path.join(ROOT, '.plugin-staging');
// Intermediate zips of dependency plugins, reused across app packages in one run.
const BUNDLED_CACHE = path.join(STAGING_ROOT, '.bundled-cache');

const ALL_PLUGINS = [
  'atomic/demo-echo',
  'app/demo-counter',
  'extension/demo-install-notify',
  // Baidu Netdisk Uploader suite
  'baidu-netdisk-uploader/atomic/localdb',
  'baidu-netdisk-uploader/atomic/sevenzip',
  'baidu-netdisk-uploader/atomic/baidunetdisk',
  'baidu-netdisk-uploader/app/uploader',
  // Subtitle Pipeline suite
  'subtitle-pipeline/atomic/writer',
  'subtitle-pipeline/atomic/llmtranslate',
  'subtitle-pipeline/atomic/asr',
  'subtitle-pipeline/app/studio',
];

// ---------------------------------------------------------------------------
// plugin source index: manifest id → relative source dir
// ---------------------------------------------------------------------------
let SOURCE_INDEX: Map<string, string> | null = null;
function sourceIndex(): Map<string, string> {
  if (SOURCE_INDEX) return SOURCE_INDEX;
  const idx = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      const mf = path.join(full, 'manifest.json');
      if (fs.existsSync(mf)) {
        try {
          const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
          if (m?.id) idx.set(String(m.id), path.relative(SRC, full).split(path.sep).join('/'));
        } catch { /* ignore unreadable manifest */ }
      } else {
        walk(full);
      }
    }
  };
  walk(SRC);
  SOURCE_INDEX = idx;
  return idx;
}

function readManifest(rel: string): Record<string, any> {
  const mf = path.join(SRC, rel, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error(`manifest.json not found: ${mf}`);
  return JSON.parse(fs.readFileSync(mf, 'utf8'));
}

/**
 * Collect transitive dependency source dirs for `manifest`, in install order
 * (deepest dependency first). Throws on unknown dep ids and dependency cycles.
 */
function collectTransitiveDeps(manifest: Record<string, any>): string[] {
  const idx = sourceIndex();
  const ordered: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const dfs = (m: Record<string, any>, fromId: string): void => {
    const deps = Object.keys((m.dependencies as Record<string, string>) ?? {});
    for (const depId of deps) {
      const at = stack.indexOf(depId);
      if (at !== -1) throw new Error(`dependency cycle: ${[...stack.slice(at), depId].join(' → ')}`);
      if (visited.has(depId)) continue;
      const rel = idx.get(depId);
      if (!rel) throw new Error(`dependency "${depId}" of ${fromId} not found under plugins-source/`);
      stack.push(depId);
      dfs(readManifest(rel), depId);
      stack.pop();
      visited.add(depId);
      ordered.push(rel);
    }
  };
  dfs(manifest, String(manifest.id ?? '?'));
  return ordered;
}

// ---------------------------------------------------------------------------
// staging / compile
// ---------------------------------------------------------------------------
async function buildStaging(rel: string): Promise<{ manifest: Record<string, any>; staging: string }> {
  const srcDir = path.join(SRC, rel);
  if (!fs.existsSync(srcDir)) throw new Error(`plugin source dir not found: ${srcDir}`);
  const manifest = readManifest(rel);

  const staging = path.join(STAGING_ROOT, `${manifest.id}@${manifest.version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // 1) main.ts -> main.js (CJS for the sandbox)
  const mainSrc = path.join(srcDir, String(manifest.main).replace(/\.js$/, '.ts'));
  if (!fs.existsSync(mainSrc)) {
    throw new Error(`main source not found: ${mainSrc} (expected manifest.main base as .ts)`);
  }
  await esbuild.build({
    entryPoints: [mainSrc],
    outfile: path.join(staging, 'main.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2020',
    write: true,
    sourcemap: false,
    logLevel: 'info',
    legalComments: 'none',
  });

  // Staged manifest: main always points at the compiled main.js.
  const staged: Record<string, unknown> = { ...manifest, main: 'main.js' };

  // 2) app renderer -> renderer.umd.js (pre-compiled; host keeps it as-is)
  if (manifest.type === 'app' && manifest.renderer) {
    const rendererSrc = path.join(srcDir, String(manifest.renderer));
    if (!fs.existsSync(rendererSrc)) {
      throw new Error(`renderer source not found: ${rendererSrc}`);
    }
    await esbuild.build({
      entryPoints: [rendererSrc],
      outfile: path.join(staging, 'renderer.umd.js'),
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2020',
      // Host provides these at runtime via the require shim in AppPluginPage.
      external: ['react', 'react-dom', 'react-dom/client', 'antd'],
      loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'text' },
      write: true,
      sourcemap: false,
      logLevel: 'info',
      legalComments: 'none',
    });
    // Point the staged manifest at the pre-compiled bundle so the host's
    // compileRendererIfApp sees renderer.umd.js already exists and skips.
    staged.renderer = 'renderer.umd.js';
  }

  // 3) staged manifest
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(staged, null, 2), 'utf8');
  return { manifest, staging };
}

function zipDirTo(dir: string, zipPath: string): void {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.rmSync(zipPath, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  zip.writeZip(zipPath);
}

/**
 * Package a dependency plugin into a full installable zip (cached per run) and
 * return the zip path + manifest. Dependencies never carry their own `bundled/`
 * dir — the app zip flattens the whole transitive closure into one level.
 */
async function bundledDepZip(depRel: string): Promise<{ zipPath: string; manifest: Record<string, any> }> {
  const manifest = readManifest(depRel);
  const zipName = `${manifest.id}@${manifest.version}.zip`;
  const zipPath = path.join(BUNDLED_CACHE, zipName);
  if (fs.existsSync(zipPath)) return { zipPath, manifest };
  const { staging } = await buildStaging(depRel);
  zipDirTo(staging, zipPath);
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`[package-plugin]   bundled dep OK  ${depRel}  →  ${zipName}`);
  return { zipPath, manifest };
}

async function packageOne(rel: string): Promise<string> {
  const { manifest, staging } = await buildStaging(rel);

  // 4) app plugins: embed the transitive dependency closure as bundled zips.
  if (manifest.type === 'app') {
    const depRels = collectTransitiveDeps(manifest);
    if (depRels.length > 0) {
      const bundledDir = path.join(staging, 'bundled');
      fs.mkdirSync(bundledDir, { recursive: true });
      for (const depRel of depRels) {
        const { zipPath, manifest: depManifest } = await bundledDepZip(depRel);
        fs.copyFileSync(zipPath, path.join(bundledDir, `${depManifest.id}@${depManifest.version}.zip`));
      }
      console.log(`[package-plugin]   ${manifest.id}: embedded ${depRels.length} bundled dep(s)`);
    }
  }

  // 5) zip the staging dir → plugins-dist/<id>@<version>.zip
  fs.mkdirSync(DIST, { recursive: true });
  const zipName = `${manifest.id}@${manifest.version}.zip`;
  const zipPath = path.join(DIST, zipName);
  zipDirTo(staging, zipPath);

  // 6) cleanup staging
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`[package-plugin] OK  ${rel}  →  ${zipName}`);
  return zipName;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const items = args.length ? args : ALL_PLUGINS;
  fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  for (const rel of items) {
    await packageOne(rel);
  }
  fs.rmSync(STAGING_ROOT, { recursive: true, force: true });
  console.log(`[package-plugin] done: ${items.length} plugin(s) → plugins-dist/`);
}

main().catch((e: unknown) => {
  console.error('[package-plugin] FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
