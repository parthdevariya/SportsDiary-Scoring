/**
 * Field-level encryption for stored secrets (payment keys, webhook secrets).
 * AES-256-GCM with a key from SECRETS_KEY (base64, 32 bytes). In development a key is
 * generated once into data/secrets.key; production must set SECRETS_KEY explicitly.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let key: Buffer | null = null;

function loadKey(): Buffer {
  if (key) return key;
  if (process.env.SECRETS_KEY) {
    const k = Buffer.from(process.env.SECRETS_KEY, 'base64');
    if (k.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64-encoded');
    return (key = k);
  }
  if (process.env.NODE_ENV === 'production') throw new Error('SECRETS_KEY is required in production');
  const file = path.resolve(process.env.DATA_DIR ?? 'data', 'secrets.key');
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return (key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function open(sealed: string): string {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Show only the last 4 characters of a secret in any UI or log. */
export const mask = (s?: string | null) => (s ? `••••${s.slice(-4)}` : '');

/** Stable per-installation secret for deriving other keys (e.g. signed media URLs, sandbox webhooks). */
export const secretSeed = () => createHash('sha256').update(loadKey()).update('sports-diary-seed').digest('hex');
