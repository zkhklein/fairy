/**
 * NotifyService (Task 13) — Windows Toast notifications.
 *
 * Subscribes to the event bus and raises native Electron `Notification`s:
 *   - `errorLog.newEntry`  → toast when log.level >= configured min level
 *   - `workflow.afterExecute` → toast when run status === 'failed'
 *
 * The min level is driven by the `notify.minLevel` setting (kv_store) when
 * available; defaults to 'warn' so errors + warnings surface by default.
 *
 * If native notifications are unsupported on the host, the service degrades
 * gracefully (logs a warn) instead of throwing — UI keeps working.
 */
import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import { getEventBus } from '../core/event-bus';
import { createLogger } from '../core/logger';

const log = createLogger('notify');

export type NotifyLevel = 'error' | 'warn' | 'info';

const LEVEL_RANK: Record<NotifyLevel, number> = { info: 1, warn: 2, error: 3 };

export interface NotifyDeps {
  /** Called when the user clicks a toast — typically focuses the main window. */
  onActivate?: () => void;
  /** Read the persisted min level (kv_store-backed). Returns null if unset. */
  getMinLevel?: () => NotifyLevel | null;
}

export class NotifyService {
  private disposers: Array<() => void> = [];
  private readonly deps: NotifyDeps;

  constructor(deps: NotifyDeps = {}) {
    this.deps = deps;
  }

  start(): void {
    const bus = getEventBus();

    const d1 = bus.on(
      'errorLog.newEntry',
      (p) => {
        const lvl = p.log.level as NotifyLevel;
        const min = this.resolveMinLevel();
        if (LEVEL_RANK[lvl] >= LEVEL_RANK[min]) {
          this.show({
            title: `[${lvl.toUpperCase()}] ${p.log.source}`,
            body: p.log.message,
          });
        }
      },
      { owner: 'notify', name: 'notify.errorLog.newEntry' },
    );
    this.disposers.push(d1);

    const d2 = bus.on(
      'workflow.afterExecute',
      (p) => {
        if (p.status === 'failed') {
          this.show({
            title: '工作流执行失败',
            body: `${p.workflowId}（run ${p.runId.slice(0, 8)}）`,
          });
        }
      },
      { owner: 'notify', name: 'notify.workflow.afterExecute' },
    );
    this.disposers.push(d2);

    log.info('notify service started');
  }

  private resolveMinLevel(): NotifyLevel {
    try {
      const v = this.deps.getMinLevel?.();
      if (v && v in LEVEL_RANK) return v;
    } catch { /* fall through to default */ }
    return 'warn';
  }

  private show(n: { title: string; body: string }): void {
    if (!Notification.isSupported()) {
      log.warn({ title: n.title }, 'native notifications unsupported on this host');
      return;
    }
    try {
      const notif = new Notification({ title: n.title, body: n.body, silent: false });
      notif.on('click', () => {
        try { this.deps.onActivate?.(); } catch { /* noop */ }
      });
      notif.show();
    } catch (e) {
      log.error({ err: (e as Error).message }, 'notification show failed');
    }
  }

  dispose(): void {
    for (const d of this.disposers) {
      try { d(); } catch { /* noop */ }
    }
    this.disposers = [];
    log.info('notify service disposed');
  }
}

/**
 * Helper to focus a main window if present (used as NotifyDeps.onActivate).
 */
export function focusWindow(win: BrowserWindow | null): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
