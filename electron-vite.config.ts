import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Native / CJS / worker-thread packages MUST be kept out of the rollup bundle:
 *   - better-sqlite3 ships a .node native binding resolved via relative require.
 *   - pino's worker loader & rotating-file-stream use Node-only filesystem APIs.
 *   - electron-log ships its own CJS entry requiring process globals.
 * externalizeDepsPlugin() should already exclude package.json dependencies by
 * default; we duplicate the list here as a belt-and-suspenders safeguard.
 */
const EXTERNAL_RUNTIME_DEPS = [
  'better-sqlite3',
  'pino',
  'pino-pretty',
  'rotating-file-stream',
  'electron-log',
  'nanoid',
  'kysely',
  'zod',
  'sqlite',
  'node-cron',
  'eventemitter2',
  'hono',
  'commander',
];

export default defineConfig({
  /**
   * Shared resolve rules applied to main + preload + renderer builds.
   * Aliases declared here are merged into each target's resolve table.
   */
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main-app'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer/src'),
    },
  },
  /**
   * Top-level Vite `ssr` block — applied to SSR builds (main + preload),
   * regardless of target. Forces externalization of every non-local package.
   *
   * Background: electron-vite 2.x runs each main/preload build through
   * Vite's SSR pipeline. Putting rules here guarantees they are applied.
   */
  ssr: {
    noExternal: [],
    external: (id: string): boolean | null => {
      if (!id) return null;
      if (id.startsWith('node:') || id.startsWith('\0')) return true;
      if (id.startsWith('.') || id.startsWith('/') || id.startsWith('file://')) return false;
      if (id.startsWith('@main/') || id.startsWith('@shared/') || id.startsWith('@renderer/')) return false;
      if (id === '@main' || id === '@shared' || id === '@renderer') return false;
      // All third-party packages (better-sqlite3, pino, kysely, nanoid, ...) stay external:
      // their wrapper needs node_modules on-disk layout for native bindings.
      return true;
    },
  },
  main: {
    plugins: [
      externalizeDepsPlugin(),
    ],
    build: {
      outDir: 'out/main',
      commonjsOptions: {
        ignoreDynamicRequires: true,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
