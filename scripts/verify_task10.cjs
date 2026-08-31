// T10 UI Base static verification runner (CommonJS so `node scripts/verify_task10.cjs` works).
// Loads task10-harness.ts via esbuild transform, catches top-level errors, prints exit code.
const { buildSync } = require('esbuild');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const out = path.join(root, '.cache', 'task10-harness.mjs');
try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch {}

buildSync({
  entryPoints: [path.join(root, 'scripts/task10-harness.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: out,
  external: ['zod'],
  tsconfigRaw: {
    compilerOptions: {
      module: 'esnext',
      target: 'es2020',
      moduleResolution: 'bundler',
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      baseUrl: '.',
      paths: {
        '@shared/ipc/*': ['./src/shared/ipc/*'],
        '@shared/ipc': ['./src/shared/ipc/index.js'],
        '@shared/*': ['./src/shared/*'],
      },
      strict: false,
    },
  },
  allowOverwrite: true,
  logLevel: 'warning',
});

const res = spawnSync(process.execPath, [out], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
});
process.exit(res.status ?? 0);
