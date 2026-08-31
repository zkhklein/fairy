/**
 * FMB Main Process bundler — esbuild only.
 *
 * Why not electron-vite for main?
 *   electron-vite 2.x silently ignores all `ssr.external` /
 *   rollupOptions.external / externalizeDepsPlugin configurations we tried
 *   and always bundles ALL dependencies (including better-sqlite3) into a
 *   single file, which breaks native module loading.
 *
 * This esbuild script:
 *   - bundles OUR src/main/** TS source tree together (local relative imports)
 *   - keeps EVERYTHING else (node built-ins + node_modules + aliases we
 *     don't recognise) external → they become runtime require() calls.
 *   - emits CommonJS so Electron's Node.js CJS loader can directly execute.
 *   - produces sourcemaps so stack traces point to src/main TS files.
 */
import esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IN_TS = path.join(ROOT, 'src/main-app/index.ts');
const OUT_DIR = path.join(ROOT, 'build/main-app');
const OUT_FILE = path.join(OUT_DIR, 'index.mjs');
fs.mkdirSync(OUT_DIR, { recursive: true });

const isLocalUserModule = (p) =>
  p.startsWith('.') ||
  p.startsWith('/') ||
  p.startsWith('file://') ||
  p.startsWith('@main/') ||
  p.startsWith('@shared/') ||
  p === '@main' ||
  p === '@shared';

const SHARED_ALIASES = {
  '@main': path.join(ROOT, 'src/main-app'),
  '@shared': path.join(ROOT, 'src/shared'),
};

/**
 * Decide whether a module specifier or resolved path should be bundled.
 * - Local relative imports / TS aliases → always bundle (return undefined: let esbuild resolve).
 * - Absolute paths that live inside the PROJECT ROOT → bundle (our own source code after alias expansion).
 * - node: prefix → external.
 * - Everything else (better-sqlite3, pino, lodash, transitive deps) → external.
 */
function shouldBundle(p) {
  if (!p) return false;
  if (p.startsWith('node:')) return false;
  if (p.startsWith('\0')) return false;
  // Explicit aliases — let the plugin resolve first (onResolve below returns a path)
  if (p.startsWith('@main/') || p.startsWith('@shared/') || Object.hasOwn(SHARED_ALIASES, p)) return true;
  // Relative file specifiers
  if (p.startsWith('.') || p.startsWith('file://')) return true;
  // Unix-style absolute paths inside project root
  if (p.startsWith(ROOT + '/') || p.startsWith(ROOT + '\\') || p === ROOT) return true;
  // Windows absolute paths: starts with "C:\", "D:\", etc., or "\\?\"
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    const normalized = p.split(path.sep).join('/');
    const normalizedRoot = ROOT.split(path.sep).join('/');
    if (normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/')) {
      return true;
    }
    // Absolute path outside project root (e.g. inside node_modules resolved) → external
    return false;
  }
  // Bare specifiers: better-sqlite3, kysely, nanoid, pino, lodash, etc.
  return false;
}

function resolveTsLike(base) {
  // Base alias expansion may point to bare path without extension;
  // try exact path → *.ts → /index.ts.
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  if (fs.existsSync(base + '.ts')) return base + '.ts';
  if (fs.existsSync(base + '.cts')) return base + '.cts';
  if (fs.existsSync(base + '.mts')) return base + '.mts';
  if (fs.existsSync(path.join(base, 'index.ts'))) return path.join(base, 'index.ts');
  if (fs.existsSync(path.join(base, 'index.cts'))) return path.join(base, 'index.cts');
  if (fs.existsSync(path.join(base, 'index.mts'))) return path.join(base, 'index.mts');
  // Fallback: esbuild will try platform resolution; at least return a file-like path.
  return base;
}

const baseOptions = {
  entryPoints: [IN_TS],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: OUT_DIR,
  outbase: path.join(ROOT, 'src/main-app'),
  outExtension: { '.js': '.mjs' },
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info',
  mainFields: ['module', 'main'],
  tsconfig: path.join(ROOT, 'tsconfig.main.json'),
  loader: { '.sql': 'text' },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" },
  plugins: [
    {
      name: 'fmb-externalize-everything-nonlocal',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const id = args.path;
          if (id.startsWith('node:')) return { external: true };
          if (SHARED_ALIASES[id]) {
            return { path: resolveTsLike(SHARED_ALIASES[id]), namespace: 'file' };
          }
          if (id.startsWith('@main/')) {
            return { path: resolveTsLike(path.join(SHARED_ALIASES['@main'], id.slice('@main/'.length))) };
          }
          if (id.startsWith('@shared/')) {
            return { path: resolveTsLike(path.join(SHARED_ALIASES['@shared'], id.slice('@shared/'.length))) };
          }
          if (shouldBundle(id)) return undefined; // resolve normally (bundle)
          return { external: true };
        });
      },
    },
  ],
  legalComments: 'none',
};

const mode = process.argv[2] || 'build';
if (mode === 'watch') {
  const ctx = await esbuild.context(baseOptions);
  await ctx.watch();
  process.on('SIGINT', async () => { await ctx.dispose(); process.exit(0); });
  console.log('[esbuild:main] watching for changes → build/main-app/index.mjs');
} else {
  await esbuild.build(baseOptions);
  console.log('[esbuild:main] OK → build/main-app/index.mjs');
}
