/**
 * atomic-demo — minimal atomic plugin (plugin-dev reference example).
 *
 * ── Plugin entry contract ──────────────────────────────────────────────
 * The host sandbox loads this file (compiled to main.js) and runs it inside a
 * permission-wrapped vm context. The entry shape is:
 *
 *   module.exports = { activate(ctx), deactivate(), ...actions }
 *
 *   - activate(ctx): called on enable. ctx = { pluginId, version, hostApi }.
 *     `hostApi` is ALSO available as a global inside the sandbox (so action
 *     handlers can reach it without ctx).
 *   - deactivate(): called on disable.
 *   - every other export is an "atomic action", invokable as a workflow node
 *     or via IPC `callAction(pluginId, actionName, payload)` which runs
 *     `exports[actionName](payload)`.
 *
 * ── This plugin's actions ──────────────────────────────────────────────
 *   - echo(input)       → returns input unchanged. Trivial pass-through node.
 *   - crashMe(_input)   → ALWAYS throws. Used by AC-14 fault-injection tests:
 *     a workflow node wired to `crashMe` must transition the node to `failed`,
 *     the run to `failed`, and write an error_logs row — WITHOUT crashing the
 *     host process (the sandbox catches it).
 *
 * ── Extension point ────────────────────────────────────────────────────
 * manifest.extensionPoints = ["demo.echo::echo"] binds `exports.echo` as a
 * listener on the `demo.echo` event. Other plugins (e.g. app-demo) can then
 * call `hostApi.extensions.call('demo.echo', value)` to invoke it
 * cross-plugin (main → main), demonstrating bidirectional communication.
 */
module.exports = {
  activate(ctx) {
    // ctx.hostApi is the permission-wrapped HostApi (same object as the global
    // `hostApi`). logger requires the `log:write` permission (declared above).
    ctx.hostApi.logger.info('atomic-demo activated', { pluginId: ctx.pluginId });
  },

  deactivate() {
    // No resources to release. hostApi global still available here.
    hostApi.logger.info('atomic-demo deactivated', {});
  },

  /** Pass-through action. Returns input unchanged. */
  echo(input) {
    return input;
  },

  /**
   * Intentionally failing action for AC-14 / TR-16.2.
   * A workflow node pointing at `crashMe` must fail cleanly; the host keeps
   * running and the failure is recorded in error_logs + workflow_runs.
   */
  crashMe(_input) {
    throw new Error('atomic-demo.crashMe: intentional failure (AC-14 fault injection)');
  },
};
