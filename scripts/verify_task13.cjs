/* eslint-disable */
/**
 * Pure-Node verification runner for Task 13 (System tray + close-to-tray + Toast).
 * Mirrors TR-13.1 / TR-13.2 / TR-13.3 as static structural checks (no Electron runtime).
 *
 * Usage: node scripts/verify_task13.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function check(label, cond, note) {
  RESULTS.push({ label, pass: !!cond, note });
  process.stdout.write(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${note ? ' — ' + note : ''}\n`);
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

console.log('\n=== Task 13 验证驱动 (no-deps, pure CJS) ===\n');

// TR-13.1: tray module + close-to-tray + show-main menu
console.log('TR-13.1 系统托盘 + 关闭隐藏');
const tray = read('src/main-app/tray/index.ts');
check('TrayService class exists', /export class TrayService/.test(tray));
check('Tray uses electron Tray', /new Tray\(/.test(tray));
check('tray menu item 打开主界面', tray.includes('打开主界面'));
check('tray click → showMain', tray.includes("on('click'"));
check('showMain restores window (restore/show/focus)',
  tray.includes('restore') && tray.includes('show') && tray.includes('focus'));
check('tray menu 退出 item calls app.quit', /'退出'/.test(tray) && tray.includes('app.quit'));
check('tray exposes pauseAll/resumeAll menu items',
  tray.includes('暂停所有任务') && tray.includes('恢复所有任务'));
check('tray 查看日志 uses shell.openPath', tray.includes('shell.openPath'));

const idx = read('src/main-app/index.ts');
check('main wires TrayService', idx.includes('TrayService') && idx.includes('trayService.start'));
check('close-to-tray: preventDefault + hide on close',
  idx.includes("on('close'") && idx.includes('preventDefault') && idx.includes('hide()'));
check('isQuitting flag gates close', idx.includes('isQuitting'));
check('settings closeBehavior consulted', idx.includes("system.closeBehavior") && idx.includes("'quit'"));
check('before-quit sets isQuitting + disposes',
  idx.includes("before-quit") && idx.includes('isQuitting = true') && idx.includes('trayService?.destroy'));

// TR-13.2: Toast notifications on errorLog.newEntry + workflow failure
console.log('\nTR-13.2 Windows Toast 通知 (errorLog.newEntry + workflow 失败)');
const notify = read('src/main-app/notify/index.ts');
check('NotifyService class exists', /export class NotifyService/.test(notify));
check('subscribes errorLog.newEntry', notify.includes("'errorLog.newEntry'") || notify.includes('"errorLog.newEntry"'));
check('subscribes workflow.afterExecute', notify.includes("'workflow.afterExecute'") || notify.includes('"workflow.afterExecute"'));
check('toasts on workflow status === failed', /status === 'failed'/.test(notify) || /status\s*===\s*'failed'/.test(notify));
check('uses electron Notification', notify.includes('Notification'));
check('guards Notification.isSupported()', notify.includes('Notification.isSupported()'));
check('calls notif.show()', notify.includes('.show()'));
check('level filter (LEVEL_RANK / min level)', notify.includes('LEVEL_RANK') || notify.includes('minLevel'));
check('dispose removes subscriptions', notify.includes('dispose') && /for \(.*disposers/.test(notify));

// error-calendar actually emits the event the notify service listens to
const ec = read('src/main-app/core/error-calendar/service.ts');
check('error-calendar emits errorLog.newEntry', ec.includes("'errorLog.newEntry'") || ec.includes('"errorLog.newEntry"'));

// TR-13.3: clean quit, no zombies
console.log('\nTR-13.3 托盘退出 → app.quit + 资源释放');
check('tray 退出 → app.quit', tray.includes('app.quit'));
check('main wires NotifyService + dispose', idx.includes('NotifyService') && idx.includes('notifyService?.dispose'));
check('main pause/resume wired to queue+scheduler',
  idx.includes('getQueueService().stop') && idx.includes('getSchedulerService().stop') &&
  idx.includes('getQueueService().start') && idx.includes('getSchedulerService().start'));
check('window-all-closed disposes tray+notify',
  idx.includes('trayService?.destroy') && idx.includes('notifyService?.dispose'));

// Icon generator self-contained (no external asset)
console.log('\n图标自包含');
check('icon module exists', exists('src/main-app/tray/icon.ts'));
const icon = read('src/main-app/tray/icon.ts');
check('icon uses zlib deflateSync', icon.includes('deflateSync'));
check('icon encodes IHDR + IDAT + IEND', icon.includes("'IHDR'") && icon.includes("'IDAT'") && icon.includes("'IEND'"));
check('icon has crc32', icon.includes('crc32'));

// Summary
console.log('\n=== 汇总 ===');
const passed = RESULTS.filter((r) => r.pass).length;
const total = RESULTS.length;
console.log(`PASSED: ${passed} / ${total}`);
RESULTS.filter((r) => !r.pass).forEach((r) => {
  console.log(`  FAIL: ${r.label}${r.note ? ' (' + r.note + ')' : ''}`);
});
if (passed !== total) { process.exitCode = 1; }
