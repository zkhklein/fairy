/**
 * FMB CLI bundler — esbuild only.
 *
 * Bundles `src/cli/index.ts` into a self-contained CommonJS file at
 * `out/cli/index.js` so the `fmb` bin entry can run on any Node 20+
 * without a separate TypeScript runtime or ts-node.
 *
 * The CLI is a standalone Node program (no Electron, no internal @main/
 * aliases): it only imports `commander` + node built-ins. We bundle
 * `commander` in so the CLI has zero runtime file dependencies beyond
 * Node itself, while keeping all `node:*` modules external.
 */
import esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IN_TS = path.join(ROOT, 'src/cli/index.ts');
const OUT_DIR = path.join(ROOT, 'out/cli');
const OUT_FILE = path.join(OUT_DIR, 'index.js');
fs.mkdirSync(OUT_DIR, { recursive: true });

const options = {
  entryPoints: [IN_TS],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: OUT_FILE,
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info',
  // node:* built-ins stay external (esbuild only accepts string glob patterns,
  // not RegExp, in `external`); everything else (commander + its deps) gets
  // bundled so the CLI is a single drop-in file.
  external: ['node:*'],
  tsconfig: path.join(ROOT, 'tsconfig.cli.json'),
  legalComments: 'none',
};

const mode = process.argv[2] || 'build';
if (mode === 'watch') {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  process.on('SIGINT', async () => { await ctx.dispose(); process.exit(0); });
  console.log('[esbuild:cli] watching for changes → out/cli/index.js');
} else {
  await esbuild.build(options);
  // Ensure the bin file is executable on POSIX (harmless on Windows).
  try { fs.chmodSync(OUT_FILE, 0o755); } catch { /* noop */ }
  console.log('[esbuild:cli] OK → out/cli/index.js');
}
