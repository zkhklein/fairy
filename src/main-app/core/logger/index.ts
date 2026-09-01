/**
 * FMB structured logger factory — NO worker-thread transports.
 *
 * Background: electron-vite 2.x (rollup bundler) does not ship pino's
 * `lib/worker.js` asset into `out/main/lib/`, which causes every logger
 * `info/warn/...` call to throw "Cannot find module .../worker.js" when
 * `pino.transport()` spawns a worker-thread-backed ThreadStream.
 *
 * To avoid this, we:
 *   1) Pipe to rotating-file-stream DIRECTLY (no worker thread).
 *   2) For dev pretty-print, require `pino-pretty` as a synchronous Transform
 *      stream and plug it into `pino.multistream` — not via pino.transport.
 *   3) Cache instances by name to avoid duplicate file handles.
 */
import path from 'node:path';
import fs from 'node:fs';
import pino, { type Logger, type LoggerOptions } from 'pino';
import prettyFactory from 'pino-pretty';
import { createStream } from 'rotating-file-stream';
import { app } from 'electron';

const loggerCache = new Map<string, Logger>();
let sharedBase: string | null = null;

function resolveLogsDir(): string {
  if (sharedBase) return sharedBase;
  // Marker-first resolution: see resolveDbPath in db/index.ts for rationale.
  // If the portable marker file exists, use {portableRoot}/logs regardless of
  // what app.getPath('logs') returns. Works around ESM hoisting causing
  // setPath to run after app is ready in packaged builds.
  let logsDir: string | undefined;
  try {
    const portableDir = 'fmb-data';
    const markerName = '.fmb-portable-root';
    try {
      const marker = path.join(path.dirname(app.getPath('exe')), portableDir, markerName);
      if (fs.existsSync(marker)) {
        const m = JSON.parse(fs.readFileSync(marker, 'utf8')) as { portableRoot?: string };
        if (m.portableRoot) logsDir = path.join(m.portableRoot, 'logs');
      }
    } catch { /* noop */ }
    if (!logsDir) {
      try {
        const markerDev = path.join(process.cwd(), '.data', markerName);
        if (fs.existsSync(markerDev)) {
          const m = JSON.parse(fs.readFileSync(markerDev, 'utf8')) as { portableRoot?: string };
          if (m.portableRoot) logsDir = path.join(m.portableRoot, 'logs');
        }
      } catch { /* noop */ }
    }
  } catch { /* noop */ }
  if (!logsDir) {
    // Portable mode: Electron setPath('logs') has already redirected to
    // {portableRoot}/logs. Dev mode: setPath didn't run but runtime-paths
    // guaranteed the .data tree exists, so app.getPath('logs') still wins.
    let root: string;
    try {
      root = app.getPath('logs');
    } catch {
      root = path.join(app.getPath('userData'), 'logs');
    }
    logsDir = root;
  }
  fs.mkdirSync(logsDir, { recursive: true });
  sharedBase = logsDir;
  return logsDir;
}

function buildStreams(name: string): pino.StreamEntry<pino.Level>[] {
  const dir = resolveLogsDir();
  const fileStream = createStream(`${name}.log`, {
    interval: '1d',
    path: dir,
    maxFiles: 30,
    compress: 'gzip',
  });
  const streams: pino.StreamEntry<pino.Level>[] = [
    { stream: fileStream, level: 'trace' },
  ];

  if (!app.isPackaged) {
    // Synchronous pretty stream (no worker thread, no pino.transport).
    const prettyStream = prettyFactory({
      colorize: true,
      ignore: 'pid,hostname',
      sync: true,
    });
    streams.push({ stream: prettyStream as unknown as NodeJS.WritableStream, level: 'debug' });
  }
  return streams;
}

export function getLogsDir(): string { return resolveLogsDir(); }

export function createLogger(name = 'main', overrides: LoggerOptions = {}): Logger {
  const cached = loggerCache.get(name);
  if (cached) return cached;
  const logger = pino(
    {
      name: `fmb.${name}`,
      level: process.env.FMB_LOG_LEVEL ?? (app.isPackaged ? 'info' : 'debug'),
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: ['*.password', '*.token', '*.authorization', '*.*_enc'],
        censor: '***REDACTED***',
      },
      ...overrides,
    },
    pino.multistream(buildStreams(name), { dedupe: true }),
  );
  loggerCache.set(name, logger);
  return logger;
}
