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
 *   4. write the staged `manifest.json` + `main.js` [+ `renderer.umd.js`]
 *      into a temp staging dir, then zip it to
 *      `plugins-dist/<id>@<version>.zip`.
 *
 * Usage:
 *   node scripts/package-plugin.ts            # build all three demo plugins
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

const ALL_PLUGINS = [
  'atomic/demo-echo',
  'app/demo-counter',
  'extension/demo-install-notify',
];

async function packageOne(rel: string): Promise<string> {
  const srcDir = path.join(SRC, rel);
  if (!fs.existsSync(srcDir)) throw new Error(`plugin source dir not found: ${srcDir}`);
  const manifestPath = path.join(srcDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const staging = path.join(STAGING_ROOT, `${manifest.id}@${manifest.version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // 1) main.ts -> main.js (CJS for the sandbox)
  const mainSrc = path.join(srcDir, manifest.main.replace(/\.js$/, '.ts'));
  if (!fs.existsSync(mainSrc)) {
    throw new Error(`main source not found: ${mainSrc} (expected manifest.main base as .ts)`);
  }
  const mainOut = path.join(staging, 'main.js');
  await esbuild.build({
    entryPoints: [mainSrc],
    outfile: mainOut,
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
    const rendererSrc = path.join(srcDir, manifest.renderer);
    if (!fs.existsSync(rendererSrc)) {
      throw new Error(`renderer source not found: ${rendererSrc}`);
    }
    const rendererOut = path.join(staging, 'renderer.umd.js');
    await esbuild.build({
      entryPoints: [rendererSrc],
      outfile: rendererOut,
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

  // 4) zip the staging dir → plugins-dist/<id>@<version>.zip
  fs.mkdirSync(DIST, { recursive: true });
  const zipName = `${manifest.id}@${manifest.version}.zip`;
  const zipPath = path.join(DIST, zipName);
  fs.rmSync(zipPath, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(staging);
  zip.writeZip(zipPath);

  // 5) cleanup staging
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
  console.log(`[package-plugin] done: ${items.length} plugin(s) → plugins-dist/`);
}

main().catch((e: unknown) => {
  console.error('[package-plugin] FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
