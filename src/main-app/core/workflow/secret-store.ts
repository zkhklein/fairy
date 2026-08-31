/**
 * Secret store — AES-256-GCM encryption for secrets table value_enc column.
 *
 * The encryption key is derived from the machine's hostname + a static app salt
 * using PBKDF2. This is simpler than DPAPI and cross-platform. For production
 * hardening, a proper key management system (e.g. OS keychain) should replace this.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { getRawDb } from '../db';
import { createLogger } from '../logger';

const log = createLogger('secret-store');

const APP_SALT = 'fmb-static-salt-v1-8e2f7c1a4b';
const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12; // GCM standard
const PBKDF2_ITERATIONS = 100_000;

function deriveKey(): Buffer {
  const hostname = os.hostname();
  return crypto.pbkdf2Sync(hostname, APP_SALT, PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

export function encryptValue(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv) + ':' + base64(tag) + ':' + base64(ciphertext)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptValue(encValue: string): string {
  const [ivB64, tagB64, dataB64] = encValue.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted value format');
  const key = deriveKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

// ---------------- CRUD ----------------

export function setSecret(key: string, value: string, description?: string): void {
  const db = getRawDb();
  const enc = encryptValue(value);
  const now = Date.now();
  db.prepare(
    `INSERT INTO secrets (key, value_enc, description, created_at, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_enc=excluded.value_enc, description=excluded.description, updated_at=excluded.updated_at`,
  ).run(key, enc, description ?? null, now, now);
  log.info({ key }, 'secret set');
}

export function getSecret(key: string): string | null {
  const db = getRawDb();
  const row = db.prepare('SELECT value_enc FROM secrets WHERE key = ?').get(key) as { value_enc: string } | undefined;
  if (!row) return null;
  return decryptValue(row.value_enc);
}

export function deleteSecret(key: string): boolean {
  const db = getRawDb();
  const info = db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
  return info.changes > 0;
}

export function listSecrets(): Array<{ key: string; description: string | null }> {
  const db = getRawDb();
  return db.prepare('SELECT key, description FROM secrets ORDER BY key').all() as Array<{ key: string; description: string | null }>;
}
