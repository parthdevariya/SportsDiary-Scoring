/**
 * Persistence. SQLite (node:sqlite) for zero-dependency local/edge deployments; the schema
 * is plain SQL that maps 1:1 to PostgreSQL for production (see ARCHITECTURE.md).
 * Every tenant-owned table carries org_id and every query in the services filters on it.
 */
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
  branding TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, org_id TEXT REFERENCES organizations(id), email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, address TEXT, capacity INTEGER,
  facilities TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS surfaces (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'court', sports TEXT NOT NULL DEFAULT '[]', sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, short TEXT, color TEXT, logo_url TEXT,
  sport TEXT, captain_id TEXT, coach TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, dob TEXT, gender TEXT, city TEXT,
  country TEXT, photo_url TEXT, sports TEXT NOT NULL DEFAULT '[]', rating TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_players (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  number TEXT, position TEXT, PRIMARY KEY (team_id, player_id)
);
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, sport TEXT NOT NULL, discipline TEXT NOT NULL,
  format TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', public_code TEXT UNIQUE NOT NULL,
  venue_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tournament_entrants (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE, entrant_id TEXT NOT NULL, seed INTEGER,
  participant TEXT NOT NULL, grp TEXT, PRIMARY KEY (tournament_id, entrant_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), tournament_id TEXT REFERENCES tournaments(id),
  fixture_key TEXT, round INTEGER, label TEXT, grp TEXT, winner_to TEXT,
  sport TEXT NOT NULL, discipline TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', participants TEXT NOT NULL,
  entrant_ids TEXT NOT NULL DEFAULT '[]', venue_id TEXT, surface_id TEXT, scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', visibility TEXT NOT NULL DEFAULT 'public', public_code TEXT UNIQUE NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, winner INTEGER, score TEXT, display TEXT, scorer_user_id TEXT,
  started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_org_status ON matches(org_id, status);
CREATE INDEX IF NOT EXISTS matches_surface ON matches(surface_id, status);
CREATE INDEX IF NOT EXISTS matches_tournament ON matches(tournament_id);
CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, seq INTEGER NOT NULL, id TEXT NOT NULL,
  client_event_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, actor_id TEXT, created_at TEXT NOT NULL, device_time TEXT,
  PRIMARY KEY (match_id, seq), UNIQUE (match_id, client_event_id)
);
CREATE TABLE IF NOT EXISTS player_match_stats (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, player_id TEXT NOT NULL, org_id TEXT NOT NULL,
  sport TEXT NOT NULL, side INTEGER, won INTEGER, stats TEXT NOT NULL, PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS display_devices (
  id TEXT PRIMARY KEY, org_id TEXT REFERENCES organizations(id), name TEXT NOT NULL DEFAULT 'New screen', venue_id TEXT,
  secret_hash TEXT NOT NULL, pairing_code TEXT UNIQUE, pairing_expires TEXT, assignment TEXT NOT NULL DEFAULT '{"mode":"idle"}',
  orientation TEXT NOT NULL DEFAULT 'landscape', aspect TEXT NOT NULL DEFAULT '16:9', theme TEXT NOT NULL DEFAULT '{}', locked INTEGER NOT NULL DEFAULT 0,
  last_heartbeat TEXT, last_update TEXT, user_agent TEXT, resolution TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS display_playlists (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, items TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), text TEXT NOT NULL, level TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sponsors (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), name TEXT NOT NULL, logo_url TEXT, url TEXT,
  tier TEXT NOT NULL DEFAULT 'partner', tournament_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT, user_id TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  data TEXT, at TEXT NOT NULL
);
`;

export type DB = DatabaseSync;

/** Add a column if it is missing (SQLite has no ADD COLUMN IF NOT EXISTS). */
export function ensureColumn(db: DB, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function openDb(file = process.env.DB_FILE ?? 'sportsdiary.db'): DB {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // identity extensions (shared by organizers, sponsors and platform admins)
  ensureColumn(db, 'users', 'phone', 'TEXT');
  ensureColumn(db, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'phone_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'google_sub', 'TEXT');
  ensureColumn(db, 'users', 'apple_sub', 'TEXT');
  ensureColumn(db, 'users', 'platform_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users(phone) WHERE phone IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_sub) WHERE google_sub IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_apple ON users(apple_sub) WHERE apple_sub IS NOT NULL');
  return db;
}

export const now = () => new Date().toISOString();
export const J = (v: any) => JSON.stringify(v ?? null);
export const P = <T = any>(v: any, d?: T): T => (v == null ? (d as T) : JSON.parse(v));

/** Run fn inside a transaction (SQLite IMMEDIATE so concurrent writers serialize). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
