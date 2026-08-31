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
    // Force esbuild to use the automatic JSX runtime (jsx: "automatic")
    // instead of classic (React.createElement). Without this, .tsx files
    // that use JSX but don't `import React` (e.g. router/index.tsx) compile
    // to `React.createElement(...)` → "React is not defined" at runtime.
    // The @vitejs/plugin-react should default to automatic, but electron-vite
    // overrides esbuild config — setting it here guarantees the transform.
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
    plugins: [
      react({ jsxRuntime: 'automatic' }),
      // Vite/Rollup auto-adds `crossorigin` to `<script type=module>` tags
      // during production builds. Under Electron's `file://` loadFile() the
      // file:// origin cannot serve CORS headers, so Chromium silently blocks
      // the bundle fetch → React never mounts → blank window. webSecurity=
      // false alone doesn't fully cover crossorigin-forced CORS-mode requests.
      // The post-build transformIndexHtml hook strips the attribute so the
      // script loads as a same-origin (file://) resource without CORS.
      {
        name: 'strip-crossorigin-for-file-protocol',
        transformIndexHtml: {
          order: 'post' as const,
          handler(html: string): string {
            return html.replace(/\s+crossorigin(="[^"]*")?/g, '');
          },
        },
      },
    ],
    build: {
      outDir: 'out/renderer',
      // Disable Vite's auto-added `crossorigin` attribute on script tags.
      // Under Electron's file:// protocol, crossorigin forces CORS-mode
      // requests which file:// cannot satisfy → bundle silently fails to load.
      // Empty string tells Vite not to emit the crossorigin attribute.
      crossorigin: '',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
