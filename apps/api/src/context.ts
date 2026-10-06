import { randomInt, randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { J, now } from './db.ts';
import type { Hub } from './realtime.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR', public details?: any) {
    super(message);
  }
}

export const id = () => randomUUID();

// No 0/O/1/I/L to keep codes readable on a TV from across a hall.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function publicCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
export function pin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface Ctx {
  db: DB;
  hub: Hub;
  audit(orgId: string | null, userId: string | null, action: string, entity?: string, entityId?: string, data?: any): void;
}

export function makeCtx(db: DB, hub: Hub): Ctx {
  const stmt = db.prepare('INSERT INTO audit_log (org_id, user_id, action, entity, entity_id, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  return {
    db,
    hub,
    audit(orgId, userId, action, entity, entityId, data) {
      stmt.run(orgId, userId, action, entity ?? null, entityId ?? null, data == null ? null : J(data), now());
    },
  };
}

/** Light schema validation for request bodies (keeps routes explicit without a dependency). */
type Rule = 'string' | 'string?' | 'number' | 'number?' | 'boolean?' | 'object?' | 'array' | 'array?' | 'side';
export function validate<T = any>(body: any, rules: Record<string, Rule>): T {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required', 'VALIDATION');
  for (const [k, r] of Object.entries(rules)) {
    const v = body[k];
    const optional = r.endsWith('?');
    if (v == null) {
      if (!optional) throw new HttpError(400, `${k} is required`, 'VALIDATION');
      continue;
    }
    const base = r.replace('?', '');
    const okType =
      base === 'string' ? typeof v === 'string' && v.length <= 5000 :
      base === 'number' ? typeof v === 'number' && Number.isFinite(v) :
      base === 'boolean' ? typeof v === 'boolean' :
      base === 'object' ? typeof v === 'object' && !Array.isArray(v) :
      base === 'array' ? Array.isArray(v) :
      base === 'side' ? v === 0 || v === 1 : true;
    if (!okType) throw new HttpError(400, `${k} must be ${base}`, 'VALIDATION');
  }
  return body as T;
}
