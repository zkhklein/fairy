/**
 * Post-build strip: remove `crossorigin` attribute from renderer index.html.
 *
 * Why this exists:
 *   Vite/Rollup auto-adds `crossorigin` to `<script type=module>` tags during
 *   production builds. Under Electron's `file://` loadFile() the file://
 *   origin cannot serve CORS headers, so Chromium silently blocks the bundle
 *   fetch → React never mounts → blank window.
 *
 *   Vite's `build.crossorigin: ''` option and `transformIndexHtml` plugins
 *   are both overridden by electron-vite's own HTML processing, so the only
 *   reliable way to strip the attribute is a post-build file rewrite.
 *
 * Run as part of `pnpm build` after `electron-vite build` completes.
 */
import fs from 'node:fs';
import path from 'node:path';

const htmlPath = path.resolve('out/renderer/index.html');

if (!fs.existsSync(htmlPath)) {
  console.warn('[strip-crossorigin] renderer index.html not found:', htmlPath);
  process.exit(0);
}

let html = fs.readFileSync(htmlPath, 'utf8');
const before = html;
html = html.replace(/\s+crossorigin(="[^"]*")?/g, '');

if (html === before) {
  console.log('[strip-crossorigin] no crossorigin attribute found (already clean)');
} else {
  fs.writeFileSync(htmlPath, html);
  console.log('[strip-crossorigin] removed crossorigin attribute from', htmlPath);
}
