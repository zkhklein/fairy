import esbuild from 'esbuild';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'build/scheduler-tick-dedup.mjs');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'scripts/scheduler-tick-dedup.test.ts')],
  outfile: OUT,
  bundle: true,
  sourcemap: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: 'import { createRequire as __topCreateRequire } from "module"; const require = __topCreateRequire(import.meta.url);' },
  logLevel: 'warning',
  external: [
    'node:*', 'child_process', 'fs', 'path', 'os', 'assert', 'process',
    'assert/strict', 'module', 'events', 'stream', 'util', 'crypto',
    'zlib', 'buffer', 'http', 'https', 'net', 'url', 'tty', 'worker_threads',
    'cluster', 'timers', 'perf_hooks', 'async_hooks', 'readline', 'dns',
    'better-sqlite3', 'electron', 'pino', 'pino-pretty', 'rotating-file-stream',
    'electron-log', 'zod', 'hono', 'uuid', 'node-cron', 'chokidar', 'ws', 'sharp',
  ],
  alias: {
    '@main': path.join(ROOT, 'src/main-app'),
    '@shared': path.join(ROOT, 'src/shared'),
    electron: path.join(ROOT, 'build/_electron_stub.mjs'),
  },
});
console.log('esbuild ok ->', path.relative(ROOT, OUT));
