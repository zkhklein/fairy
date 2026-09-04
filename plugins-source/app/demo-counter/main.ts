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

  /**
   * Schedule template handler: `bump_every_hour` (manifest.scheduleTemplates[0]).
   * Registered via manifest.extensionPoints as
   *   `schedule.template.com.fmb.demo.app.bump_every_hour::onBumpEveryHour`.
   *
   * Payload = schedule_runtime_envelope { scheduleId, params, pluginId, ... }.
   *   - params.step   (number,  default 1) : counter delta
   *   - params.notify (boolean, default true) : extra audit record
   *   - params.tag    (string|hourly|nightly|manual) : audit source tag
   *   - params.note   (string optional)    : arbitrary note attached to audit
   */
  async onBumpEveryHour(payload) {
    const params = (payload && payload.params) ? payload.params : {};
    const step = typeof params.step === 'number' ? params.step
      : params.step !== undefined ? Number(params.step) : 1;
    const notify = typeof params.notify === 'boolean' ? params.notify : true;
    const tag = typeof params.tag === 'string' ? params.tag : 'hourly';
    const note = typeof params.note === 'string' ? params.note : '';
    const effectiveStep = Number.isFinite(step) ? step : 1;

    const prev = parseInt((await hostApi.kv.get('count')) ?? '0', 10);
    const next = (Number.isFinite(prev) ? prev : 0) + effectiveStep;
    await hostApi.kv.set('count', String(next));

    hostApi.audit.record(`schedule.${tag}.bump`, {
      count: next,
      step: effectiveStep,
      scheduleId: payload && payload.scheduleId ? payload.scheduleId : null,
      note,
    });

    if (notify) {
      hostApi.audit.record('schedule.bump.notify', {
        count: next,
        at: new Date().toISOString(),
      });
    }

    try {
      await hostApi.extensions.call('demo.echo', {
        value: next,
        source: 'app-demo.schedule.bump',
        tag,
      });
    } catch (e) {
      hostApi.logger.warn('app-demo schedule: demo.echo ping failed', {
        error: e && e.message ? e.message : String(e),
      });
    }

    hostApi.logger.info('schedule bump_every_hour executed', {
      prev, next: next, step: effectiveStep, tag, scheduleId: payload && payload.scheduleId,
    });
    return { ok: true, count: next, step: effectiveStep, tag, note };
  },

  /**
   * Schedule template handler: `nightly_reset`.
   * Registered via manifest.extensionPoints as
   *   `schedule.template.com.fmb.demo.app.nightly_reset::onNightlyReset`.
   *
   * Payload.params:
   *   - keepBackup (boolean, default true) : backup the last value before reset.
   */
  async onNightlyReset(payload) {
    const params = (payload && payload.params) ? payload.params : {};
    const keepBackup = typeof params.keepBackup === 'boolean' ? params.keepBackup : true;

    const raw = await hostApi.kv.get('count');
    const prev = parseInt(raw ?? '0', 10);
    const prevValue = Number.isFinite(prev) ? prev : 0;

    if (keepBackup) {
      await hostApi.kv.set('counter.last_known_value', String(prevValue));
      await hostApi.kv.set('counter.last_reset_at', new Date().toISOString());
    }
    await hostApi.kv.set('count', '0');

    hostApi.audit.record('schedule.nightly_reset', {
      prev: prevValue,
      keepBackup,
      scheduleId: payload && payload.scheduleId ? payload.scheduleId : null,
    });

    hostApi.logger.info('schedule nightly_reset executed', {
      prev: prevValue, keepBackup,
      scheduleId: payload && payload.scheduleId,
    });
    return { ok: true, resetFrom: prevValue, keepBackup };
  },
};
