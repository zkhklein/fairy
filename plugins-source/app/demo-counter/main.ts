/**
 * app-demo main module — Counter backed by plugin-scoped kv storage.
 *
 * ── How app plugins work ────────────────────────────────────────────────
 * An app plugin has TWO halves:
 *   1. main.js  — runs in the host sandbox (this file). Exports actions.
 *   2. renderer — runs in the renderer process inside a Shadow DOM. The host
 *      compiles `manifest.renderer` to `renderer.umd.js` and mounts it via
 *      `module.exports.mount(hostElement, hostUIApi)`.
 *
 * The renderer talks back to this main module through the restricted HostUIApi:
 *   hostUIApi.callPluginMainAction(action, payload)
 *      → IPC `main:plugin.callAction`
 *      → host calls `exports[action](payload)` HERE in the sandbox.
 *
 * ── Bidirectional comms (main → atomic-demo) ───────────────────────────
 * `bump` not only reads/writes its own kv counter but also pings the
 * atomic-demo `demo.echo` extension point via `hostApi.extensions.call(...)`.
 * That proves: renderer→main (HostUIApi) AND main→atomic (event-bus). The
 * echo handler runs in atomic-demo's sandbox and can log/audit independently.
 *
 * ── Actions exported ───────────────────────────────────────────────────
 *   - bump({ delta })  → count += delta (kv `count`); pings demo.echo; audits.
 *   - getCount()       → returns { count }.
 *
 * NOTE: `hostApi` is a sandbox global (permission-wrapped). Action handlers
 * receive only `payload` from callAction, so they use the global `hostApi`.
 */
module.exports = {
  activate(ctx) {
    ctx.hostApi.logger.info('app-demo activated', { pluginId: ctx.pluginId });
  },

  deactivate() {
    hostApi.logger.info('app-demo deactivated', {});
  },

  /** Increment/decrement the counter and ping atomic-demo's echo extension. */
  async bump(payload) {
    const delta = payload && typeof payload.delta === 'number' ? payload.delta : 0;
    // plugin-scoped kv: stored at <pluginDir>/.fmb-kv.json (requires kv:read/write).
    const prev = parseInt((await hostApi.kv.get('count')) ?? '0', 10);
    const next = Number.isFinite(prev) ? prev + delta : delta;
    await hostApi.kv.set('count', String(next));

    // Bidirectional: ask atomic-demo to echo the new value. Its `echo` handler
    // is bound to the `demo.echo` extension point (see atomic-demo main.ts).
    // extensions.call emits on the event bus; requires `extensions:call`.
    try {
      await hostApi.extensions.call('demo.echo', { value: next, source: 'app-demo.bump' });
    } catch (e) {
      // atomic-demo may not be enabled yet — degrade gracefully.
      hostApi.logger.warn('app-demo: demo.echo ping failed (is atomic-demo enabled?)', {
        error: e && e.message ? e.message : String(e),
      });
    }

    hostApi.audit.record('plugin.bump', { count: next, delta });
    hostApi.logger.info('bump', { count: next, delta });
    return { ok: true, count: next };
  },

  /** Return current counter value. */
  async getCount() {
    const v = parseInt((await hostApi.kv.get('count')) ?? '0', 10);
    return { count: Number.isFinite(v) ? v : 0 };
  },
};
