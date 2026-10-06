import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { DB } from './db.ts';
import { now } from './db.ts';

export const ROLES = [
  'super_admin', 'org_admin', 'tournament_admin', 'scorer', 'referee', 'umpire', 'coach', 'team_manager', 'player', 'spectator',
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'org.manage' | 'user.manage' | 'venue.manage' | 'team.manage' | 'player.manage' | 'tournament.manage'
  | 'match.manage' | 'match.score' | 'display.manage' | 'sponsor.manage' | 'stats.view' | 'ai.use';

const ALL: Permission[] = ['org.manage', 'user.manage', 'venue.manage', 'team.manage', 'player.manage', 'tournament.manage', 'match.manage', 'match.score', 'display.manage', 'sponsor.manage', 'stats.view', 'ai.use'];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL,
  org_admin: ALL,
  tournament_admin: ['tournament.manage', 'match.manage', 'match.score', 'display.manage', 'team.manage', 'player.manage', 'stats.view', 'ai.use'],
  scorer: ['match.score', 'stats.view'],
  referee: ['match.score', 'stats.view'],
  umpire: ['match.score', 'stats.view'],
  coach: ['team.manage', 'player.manage', 'stats.view', 'ai.use'],
  team_manager: ['team.manage', 'player.manage', 'stats.view'],
  player: ['stats.view'],
  spectator: ['stats.view'],
};

/** Roles that may only score matches explicitly assigned to them. */
export const ASSIGNMENT_SCOPED: Role[] = ['scorer', 'referee', 'umpire'];

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
}

export function can(user: AuthUser | null, perm: Permission): boolean {
  return !!user && ROLE_PERMISSIONS[user.role]?.includes(perm);
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, saltB64, hashB64] = stored.split('$');
  if (!saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, got);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

const SESSION_DAYS = 30;

/** Sessions store only a hash of the bearer token, so a DB leak doesn't leak live sessions. */
export function createSession(db: DB, userId: string): string {
  const t = token();
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(t), userId, exp);
  return t;
}

export function userFromToken(db: DB, t: string | undefined | null): AuthUser | null {
  if (!t) return null;
  const row = db
    .prepare('SELECT u.id, u.org_id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(sha256(t)) as any;
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, orgId: row.org_id, email: row.email, name: row.name, role: row.role };
}

export function revokeSession(db: DB, t: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
}

/** Simple in-memory token bucket per key (IP + route class). Swap for Redis in multi-node deployments. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number) {}
  take(key: string, cost = 1): boolean {
    const t = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    if (b.tokens < cost) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 50000) this.buckets.clear();
    return true;
  }
}
