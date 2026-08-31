/**
 * TrayService (Task 13) — System tray + window close-to-tray behavior.
 *
 * Provides:
 *   - 16x16 tray icon (generated at runtime via a minimal PNG encoder — no
 *     external asset required; replaced by a branded icon in T18).
 *   - Context menu: 打开主界面 / 暂停所有任务 / 恢复所有任务 / 查看日志 / 退出
 *   - Click on tray icon → show + focus the main window
 *   - Tracks running state to toggle pause/resume menu item enablement
 *
 * The close-to-tray *window* behavior is implemented by the main boot module
 * (it owns the BrowserWindow); this module only needs getMainWindow/createWindow
 * callbacks to remain decoupled from window lifecycle.
 */
import { app, Menu, Tray, nativeImage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { createLogger } from '../core/logger';
import { makeTrayIconPng } from './icon';

const log = createLogger('tray');

export interface TrayDeps {
  getMainWindow: () => BrowserWindow | null;
  createWindow: () => void;
  pauseAll: () => void;
  resumeAll: () => void;
  logsDir: string;
}

export class TrayService {
  private tray: Tray | null = null;
  private running = true;
  constructor(private readonly deps: TrayDeps) {}

  start(): void {
    const png = makeTrayIconPng();
    const image = nativeImage.createFromBuffer(png);
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip('Fairy Maid Brigade');
    this.rebuildMenu();
    this.tray.on('click', () => this.showMain());
    log.info('tray service started');
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.rebuildMenu();
  }

  rebuildMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: '打开主界面', click: () => this.showMain() },
      { type: 'separator' },
      {
        label: '暂停所有任务',
        enabled: this.running,
        click: () => {
          try { this.deps.pauseAll(); } catch (e) { log.error({ err: (e as Error).message }, 'pauseAll failed'); }
          this.setRunning(false);
        },
      },
      {
        label: '恢复所有任务',
        enabled: !this.running,
        click: () => {
          try { this.deps.resumeAll(); } catch (e) { log.error({ err: (e as Error).message }, 'resumeAll failed'); }
          this.setRunning(true);
        },
      },
      { type: 'separator' },
      {
        label: '查看日志',
        click: () => {
          try { void shell.openPath(this.deps.logsDir); } catch (e) { log.warn({ err: (e as Error).message }, 'open logs dir failed'); }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          log.info('user clicked tray quit');
          app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  showMain(): void {
    const win = this.deps.getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      this.deps.createWindow();
    }
  }

  destroy(): void {
    try { this.tray?.destroy(); } catch { /* noop */ }
    this.tray = null;
    log.info('tray service destroyed');
  }
}
