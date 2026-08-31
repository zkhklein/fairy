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
  let root: string;
  if (app.isPackaged) {
    root = app.getPath('userData');
  } else {
    root = path.join(app.getAppPath(), '.data');
  }
  const dir = path.join(root, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  sharedBase = dir;
  return dir;
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
