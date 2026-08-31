/**
 * electron-vite / Vite asset type stubs for the renderer process.
 *
 * - `*?raw` imports return the asset's raw text content as a string.
 *   We use this to embed AGENTS.md and plugin-dev.md (copied into
 *   renderer/src/docs/) directly into the Settings page's markdown viewer
 *   so it works both in `pnpm dev` (Vite dev server) and after build without
 *   touching the filesystem at runtime.
 */
declare module '*.md?raw' {
  const content: string;
  export default content;
}

declare module '*.txt?raw' {
  const content: string;
  export default content;
}

declare module '*.md' {
  const content: string;
  export default content;
}
