/**
 * FMB Audit Service.
 * All write actions on the platform MUST route through `audit(...)` BEFORE changing state.
 *
 * Usage:
 *   audit({
 *     action: 'plugin.install',
 *     source: 'cli',
 *     actor: 'user@cli',
 *     payload: { pluginId: 'com.fmb.x', version: '1.0.0' },
 *     traceId: req.traceId,
 *   });
 */
import { nanoid } from 'nanoid';
import { getRawDb } from '../db';
import type { AuditSource } from '../db/types';
import { createLogger } from '../logger';

const logger = createLogger('audit');

export interface AuditRecord {
  action: string;
  source: AuditSource;
  actor?: string;
  payload?: unknown;
  traceId?: string | null;
}

export function audit(record: AuditRecord): number {
  const now = Date.now();
  const traceId = record.traceId ?? nanoid(12);
  const payloadJson = record.payload == null ? null : JSON.stringify(record.payload);
  const insert = getRawDb().prepare(
    "INSERT INTO audit_logs (action, actor, source, payload_json, trace_id, created_at) VALUES (@action, @actor, @source, @payload_json, @trace_id, @created_at)",
  );
  const info = insert.run({
    action: record.action,
    actor: record.actor ?? 'system',
    source: record.source,
    payload_json: payloadJson,
    trace_id: traceId,
    created_at: now,
  });
  logger.debug(
    {
      id: info.lastInsertRowid,
      action: record.action,
      source: record.source,
      actor: record.actor,
      traceId,
    },
    'audit event recorded',
  );
  return Number(info.lastInsertRowid);
}

/**
 * Convenience wrapper: generate a fresh nanoid-based trace id that can be threaded
 * through a whole cross-module call chain.
 */
export function newTraceId(): string {
  return nanoid(16);
}
