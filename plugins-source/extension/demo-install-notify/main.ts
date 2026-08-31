/**
 * extension-demo — observes plugin installs (plugin-dev reference).
 *
 * ── How extension plugins work ─────────────────────────────────────────
 * An extension plugin has no UI and no atomic actions; it only reacts to host
 * events. manifest.extensionPoints entries bind an exported handler to an
 * event point on the host event bus. The host loader, on enable, does:
 *
 *   for decl in manifest.extensionPoints:
 *     [point, handlerName] = decl.split('::')   // or handlerName='default'
 *     bus.on(point, exports[handlerName])
 *
 * So `exports.onAfterInstall` becomes a listener for `plugin.afterInstall`.
 *
 * ── TR-16.3 evidence ────────────────────────────────────────────────────
 * When ANY plugin is installed (after this one is enabled), the host emits
 * `plugin.afterInstall` with payload { plugin, pluginVersion }. This handler:
 *   1. generates a fresh traceId,
 *   2. writes a warn-level log (visible in error_logs / logs),
 *   3. persists a kv record `ext_demo_log_<traceId>` (queryable later),
 *   4. records an audit entry.
 *
 * NOTE: creating a custom SQL table from inside the sandbox is not supported
 * (no DB access by design), so per the spec we use the kv store as the
 * "extension_metadata" storage.
 */
module.exports = {
  activate(ctx) {
    ctx.hostApi.logger.info('extension-demo activated', { pluginId: ctx.pluginId });
  },

  deactivate() {
    hostApi.logger.info('extension-demo deactivated', {});
  },

  /** Bound to `plugin.afterInstall` via manifest.extensionPoints. */
  async onAfterInstall(payload) {
    // payload = { plugin: {...}, pluginVersion: {...} } emitted by the loader.
    const installedId =
      payload && payload.plugin && payload.plugin.id ? payload.plugin.id : 'unknown';
    const traceId = 'ext-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const record = { traceId, installedPluginId: installedId, observedAt: Date.now() };

    // warn-level log → appears in error_logs level=warn (requires log:write).
    hostApi.logger.warn('plugin.afterInstall observed', record);

    // kv record (requires kv:write). Keyed by traceId for later inspection.
    await hostApi.kv.set('ext_demo_log_' + traceId, JSON.stringify(record));

    // audit trail (requires audit:write).
    hostApi.audit.record('ext.install-notify', { traceId, installedPluginId: installedId });

    return record;
  },
};
