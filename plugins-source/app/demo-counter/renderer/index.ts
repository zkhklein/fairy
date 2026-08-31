/**
 * app-demo renderer — plain-DOM +1/-1 Counter (plugin-dev reference).
 *
 * ── Renderer contract ───────────────────────────────────────────────────
 * The host compiles this file (manifest.renderer) to `renderer.umd.js` via
 * esbuild (react/react-dom/antd externalized). At runtime AppPluginPage:
 *   1. fetches the bundle via IPC `main:plugin.getRenderer`,
 *   2. evaluates it in a controlled scope with a `require` shim (provides
 *      react/react-dom/antd from the host instance if you want React),
 *   3. calls `module.exports.mount(container, hostUIApi)`.
 *
 * This example uses plain DOM (no React) to keep the bundle dependency-free
 * and robust inside the Shadow DOM. `hostUIApi` is the RESTRICTED surface:
 *   - callPluginMainAction<A>(action, payload) → IPC → sandbox action
 *   - navigate(to)                              → host React Router
 *   - readPluginState()                         → plugin-scoped state
 *
 * The host element passed to mount() lives inside a Shadow Root, so styles
 * from the main document cannot leak in; theme tokens (the --ant-... and
 * --fmb-... CSS custom properties) are copied forward by AppPluginPage.
 */
module.exports = {
  mount(hostEl, hostApi) {
    // Container with sane defaults (Shadow DOM has no inherited stylesheet).
    const root = document.createElement('div');
    root.style.fontFamily = '-apple-system, system-ui, sans-serif';
    root.style.padding = '16px';

    const title = document.createElement('h2');
    title.textContent = 'Demo Counter';
    title.style.margin = '0 0 8px';

    const display = document.createElement('p');
    display.style.fontSize = '22px';
    display.style.fontWeight = '700';
    display.style.margin = '0 0 12px';
    display.textContent = 'Count: 0';

    const row = document.createElement('div');
    const btnPlus = document.createElement('button');
    btnPlus.textContent = '+1';
    const btnMinus = document.createElement('button');
    btnMinus.textContent = '\u22121'; // −
    btnMinus.style.marginLeft = '8px';

    const status = document.createElement('p');
    status.style.color = '#c0392b';
    status.style.minHeight = '1.2em';

    let busy = false;
    async function bump(delta: number) {
      if (busy) return;
      busy = true;
      btnPlus.disabled = btnMinus.disabled = true;
      status.textContent = '';
      try {
        // Round-trip: renderer → HostUIApi → IPC → sandbox main `bump`.
        const r: any = await hostApi.callPluginMainAction('bump', { delta });
        display.textContent = `Count: ${r.count}`;
      } catch (e: any) {
        status.textContent = String(e?.message || e);
      } finally {
        busy = false;
        btnPlus.disabled = btnMinus.disabled = false;
      }
    }
    btnPlus.onclick = () => bump(1);
    btnMinus.onclick = () => bump(-1);

    row.appendChild(btnPlus);
    row.appendChild(btnMinus);
    root.appendChild(title);
    root.appendChild(display);
    root.appendChild(row);
    root.appendChild(status);
    hostEl.appendChild(root);

    // Initialize count from the main module.
    hostApi
      .callPluginMainAction('getCount')
      .then((r: any) => {
        display.textContent = `Count: ${r.count}`;
      })
      .catch(() => {
        /* main action unavailable — leave at 0 */
      });

    // Remember root for unmount.
    module.exports._root = root;
  },

  unmount(hostEl) {
    // Shadow DOM cleanup: drop everything we appended.
    while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);
    module.exports._root = null;
  },
};
