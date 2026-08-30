import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line node/prefer-global/process
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

const FALLBACK_DEV_SERVER_URL = 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;

function resolveRendererEntry(): { mode: 'url'; url: string } | { mode: 'file'; file: string } {
  if (!app.isPackaged) {
    // eslint-disable-next-line node/prefer-global/process
    const fromEnv = process.env['VITE_DEV_SERVER_URL'] || process.env.VITE_DEV_SERVER_URL;
    const url = (typeof fromEnv === 'string' && fromEnv.length > 0) ? fromEnv : FALLBACK_DEV_SERVER_URL;
    return { mode: 'url', url };
  }
  return { mode: 'file', file: path.join(__dirname, '../renderer/index.html') };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Fairy Maid Brigade',
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  const entry = resolveRendererEntry();
  if (entry.mode === 'url') {
    const load = async (): Promise<void> => {
      try {
        await mainWindow?.loadURL(entry.url);
      } catch (err) {
        // Retry once against fallback URL if VITE_DEV_SERVER_URL was stale
        if (entry.url !== FALLBACK_DEV_SERVER_URL) {
          await mainWindow?.loadURL(FALLBACK_DEV_SERVER_URL);
          return;
        }
        throw err;
      }
    };
    void load();
  } else {
    void mainWindow.loadFile(entry.file);
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
