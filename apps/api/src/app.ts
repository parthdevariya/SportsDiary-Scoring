import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { catalog, getSport } from '../../../packages/engine/src/index.ts';
import { openDb, J, P, now, tx } from './db.ts';
import { Hub, send, type Client } from './realtime.ts';
import { makeCtx, HttpError, id, validate, type Ctx } from './context.ts';
import { can, createSession, hashPassword, userFromToken, verifyPassword, revokeSession, RateLimiter, ROLES, type AuthUser, type Permission } from './auth.ts';
import { MatchService } from './services/matches.ts';
import { TournamentService } from './services/tournaments.ts';
import { DisplayService } from './services/displays.ts';
import { buildFacts, templateProvider, playerOfTheMatch, shareCardSvg } from './services/insights.ts';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/public');

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  body: any;
  user: AuthUser | null;
  ip: string;
  headers: http.IncomingHttpHeaders;
  token: string | null;
}
type Raw = { __raw: true; status?: number; type: string; body: string | Buffer; headers?: Record<string, string> };
type Handler = (r: Req) => any | Promise<any>;
interface Route { method: string; re: RegExp; keys: string[]; perm?: Permission | 'auth' | 'public'; h: Handler }

export interface App {
  server: http.Server;
  ctx: Ctx;
  matches: MatchService;
  tournaments: TournamentService;
  displays: DisplayService;
  close(): Promise<void>;
}

export function createApp(opts: { dbFile?: string; rateLimitScale?: number } = {}): App {
  const db = openDb(opts.dbFile);
  const hub = new Hub();
  const ctx = makeCtx(db, hub);
  const matches = new MatchService(ctx);
  const tournaments = new TournamentService(ctx, matches);
  const displays = new DisplayService(ctx, matches, tournaments);
  const routes: Route[] = [];
  // Scale is >1 only in tests/load runs; production uses the defaults.
  const k = opts.rateLimitScale ?? Number(process.env.RATE_LIMIT_SCALE ?? 1);
  const authLimiter = new RateLimiter(20 * k, (20 / 60) * k);
  const writeLimiter = new RateLimiter(60 * k, 30 * k);
  const publicLimiter = new RateLimiter(120 * k, 60 * k);

  const route = (method: string, pattern: string, perm: Route['perm'], h: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, perm, h });
  };
  const raw = (type: string, body: string | Buffer, status = 200, headers?: Record<string, string>): Raw => ({ __raw: true, type, body, status, headers });

  // ------------------------------------------------------------------ auth & org
  route('POST', '/api/auth/register', 'public', (r) => {
    const b = validate(r.body, { orgName: 'string', name: 'string', email: 'string', password: 'string' });
    const email = b.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Valid email required', 'VALIDATION');
    if (b.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters', 'VALIDATION');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists', 'CONFLICT');
    const orgId = id();
    const userId = id();
    let slug = b.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';
    while (db.prepare('SELECT 1 FROM organizations WHERE slug = ?').get(slug)) slug += '-' + Math.floor(Math.random() * 1000);
    tx(db, () => {
      db.prepare('INSERT INTO organizations (id, name, slug, created_at) VALUES (?,?,?,?)').run(orgId, b.orgName.slice(0, 80), slug, now());
      db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)').run(userId, orgId, email, b.name.slice(0, 80), hashPassword(b.password), 'org_admin', now());
    });
    ctx.audit(orgId, userId, 'org.register', 'organization', orgId);
    return { token: createSession(db, userId), user: userFromTokenSafe(userId), organization: { id: orgId, name: b.orgName, slug } };
  });

  const userFromTokenSafe = (uid: string) => {
    const u = db.prepare('SELECT id, org_id AS orgId, email, name, role FROM users WHERE id = ?').get(uid) as any;
    return u;
  };

  route('POST', '/api/auth/login', 'public', (r) => {
    const b = validate(r.body, { email: 'string', password: 'string' });
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(b.email.trim().toLowerCase()) as any;
    if (!u || !verifyPassword(b.password, u.password_hash)) throw new HttpError(401, 'Incorrect email or password', 'UNAUTHORIZED');
    return { token: createSession(db, u.id), user: userFromTokenSafe(u.id) };
  });

  route('POST', '/api/auth/logout', 'auth', (r) => {
    if (r.token) revokeSession(db, r.token);
    return { ok: true };
  });

  route('GET', '/api/me', 'auth', (r) => {
    const org = db.prepare('SELECT id, name, slug, plan, branding FROM organizations WHERE id = ?').get(r.user!.orgId) as any;
    return { user: r.user, organization: { ...org, branding: P(org.branding, {}) } };
  });

  route('PATCH', '/api/organization', 'org.manage', (r) => {
    const b = validate(r.body, { name: 'string?', branding: 'object?' });
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(r.user!.orgId) as any;
    db.prepare('UPDATE organizations SET name = ?, branding = ? WHERE id = ?').run(b.name ?? org.name, b.branding ? J(b.branding) : org.branding, org.id);
    return { ok: true };
  });

  route('GET', '/api/users', 'user.manage', (r) => db.prepare('SELECT id, email, name, role, created_at FROM users WHERE org_id = ? ORDER BY name').all(r.user!.orgId));
  route('POST', '/api/users', 'user.manage', (r) => {
    const b = validate(r.body, { email: 'string', name: 'string', password: 'string', role: 'string' });
    if (!(ROLES as readonly string[]).includes(b.role) || b.role === 'super_admin') throw new HttpError(400, 'Invalid role', 'VALIDATION');
    if (b.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters', 'VALIDATION');
    const email = b.email.trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Email already in use', 'CONFLICT');
    const uid = id();
    db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)').run(uid, r.user!.orgId, email, b.name, hashPassword(b.password), b.role, now());
    ctx.audit(r.user!.orgId, r.user!.id, 'user.create', 'user', uid, { role: b.role });
    return { id: uid, email, name: b.name, role: b.role };
  });

  // ------------------------------------------------------------------ sports catalog
  route('GET', '/api/sports', 'public', () => catalog());

  // ------------------------------------------------------------------ venues & surfaces
  route('GET', '/api/venues', 'auth', (r) => {
    const vs = db.prepare('SELECT * FROM venues WHERE org_id = ? ORDER BY name').all(r.user!.orgId) as any[];
    const ss = db.prepare('SELECT * FROM surfaces WHERE org_id = ? ORDER BY sort, name').all(r.user!.orgId) as any[];
    return vs.map((v) => ({ ...v, facilities: P(v.facilities, []), surfaces: ss.filter((s) => s.venue_id === v.id).map((s) => ({ ...s, sports: P(s.sports, []) })) }));
  });
  route('POST', '/api/venues', 'venue.manage', (r) => {
    const b = validate(r.body, { name: 'string', address: 'string?', capacity: 'number?', facilities: 'array?', surfaces: 'array?' });
    const vid = id();
    tx(db, () => {
      db.prepare('INSERT INTO venues (id, org_id, name, address, capacity, facilities, created_at) VALUES (?,?,?,?,?,?,?)').run(vid, r.user!.orgId, b.name, b.address ?? null, b.capacity ?? null, J(b.facilities ?? []), now());
      (b.surfaces ?? []).forEach((s: any, i: number) => insertSurface(r.user!.orgId, vid, s, i));
    });
    return { id: vid };
  });
  const insertSurface = (orgId: string, venueId: string, s: any, sort: number) => {
    const sid = id();
    db.prepare('INSERT INTO surfaces (id, org_id, venue_id, name, kind, sports, sort) VALUES (?,?,?,?,?,?,?)').run(sid, orgId, venueId, String(s.name).slice(0, 60), ['court', 'table', 'field', 'pitch', 'lane'].includes(s.kind) ? s.kind : 'court', J(s.sports ?? []), sort);
    return sid;
  };
  route('POST', '/api/venues/:id/surfaces', 'venue.manage', (r) => {
    const v = db.prepare('SELECT id FROM venues WHERE id = ? AND org_id = ?').get(r.params.id, r.user!.orgId);
    if (!v) throw new HttpError(404, 'Venue not found', 'NOT_FOUND');
    const b = validate(r.body, { name: 'string', kind: 'string?', sports: 'array?' });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM surfaces WHERE venue_id = ?').get(r.params.id) as any).n;
    return { id: insertSurface(r.user!.orgId, r.params.id, b, n) };
  });

  // ------------------------------------------------------------------ teams & players
  route('GET', '/api/players', 'auth', (r) =>
    (db.prepare('SELECT * FROM players WHERE org_id = ? ORDER BY name LIMIT 2000').all(r.user!.orgId) as any[]).map((p) => ({ ...p, sports: P(p.sports, []), rating: P(p.rating, {}) })));
  route('POST', '/api/players', 'player.manage', (r) => {
    const b = validate(r.body, { name: 'string', dob: 'string?', gender: 'string?', city: 'string?', country: 'string?', sports: 'array?', photoUrl: 'string?' });
    const pid = id();
    db.prepare('INSERT INTO players (id, org_id, name, dob, gender, city, country, photo_url, sports, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      pid, r.user!.orgId, b.name.slice(0, 80), b.dob ?? null, b.gender ?? null, b.city ?? null, b.country ?? null, b.photoUrl ?? null, J(b.sports ?? []), now());
    return { id: pid };
  });
  route('GET', '/api/players/:id', 'auth', (r) => {
    const p = db.prepare('SELECT * FROM players WHERE id = ? AND org_id = ?').get(r.params.id, r.user!.orgId) as any;
    if (!p) throw new HttpError(404, 'Player not found', 'NOT_FOUND');
    const rows = db.prepare('SELECT sport, won, stats FROM player_match_stats WHERE player_id = ? AND org_id = ?').all(p.id, r.user!.orgId) as any[];
    const career: Record<string, any> = {};
    for (const row of rows) {
      const c = (career[row.sport] ??= { played: 0, won: 0, lost: 0, totals: {} });
      c.played++;
      if (row.won === 1) c.won++;
      if (row.won === 0) c.lost++;
      for (const [k, v] of Object.entries(P(row.stats, {}))) if (typeof v === 'number') c.totals[k] = (c.totals[k] ?? 0) + v;
    }
    const teams = db.prepare('SELECT t.id, t.name, tp.number, tp.position FROM team_players tp JOIN teams t ON t.id = tp.team_id WHERE tp.player_id = ?').all(p.id);
    return { ...p, sports: P(p.sports, []), rating: P(p.rating, {}), career, teams };
  });
  route('GET', '/api/teams', 'auth', (r) => {
    const ts = db.prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY name').all(r.user!.orgId) as any[];
    const cnt = db.prepare('SELECT team_id, COUNT(*) AS n FROM team_players GROUP BY team_id').all() as any[];
    return ts.map((t) => ({ ...t, players: cnt.find((c) => c.team_id === t.id)?.n ?? 0 }));
  });
  route('POST', '/api/teams', 'team.manage', (r) => {
    const b = validate(r.body, { name: 'string', short: 'string?', color: 'string?', sport: 'string?', coach: 'string?', players: 'array?', logoUrl: 'string?' });
    const tid = id();
    tx(db, () => {
      db.prepare('INSERT INTO teams (id, org_id, name, short, color, logo_url, sport, coach, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
        tid, r.user!.orgId, b.name.slice(0, 80), b.short?.slice(0, 6) ?? null, b.color ?? null, b.logoUrl ?? null, b.sport ?? null, b.coach ?? null, now());
      for (const p of b.players ?? []) {
        let pid = p.id;
        if (!pid) {
          pid = id();
          db.prepare('INSERT INTO players (id, org_id, name, created_at, sports) VALUES (?,?,?,?,?)').run(pid, r.user!.orgId, String(p.name).slice(0, 80), now(), J(b.sport ? [b.sport] : []));
        } else if (!db.prepare('SELECT 1 FROM players WHERE id = ? AND org_id = ?').get(pid, r.user!.orgId)) throw new HttpError(400, `Unknown player ${pid}`, 'VALIDATION');
        db.prepare('INSERT OR REPLACE INTO team_players (team_id, player_id, number, position) VALUES (?,?,?,?)').run(tid, pid, p.number != null ? String(p.number) : null, p.position ?? null);
      }
    });
    return { id: tid };
  });
  route('GET', '/api/teams/:id', 'auth', (r) => {
    const t = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(r.params.id, r.user!.orgId) as any;
    if (!t) throw new HttpError(404, 'Team not found', 'NOT_FOUND');
    return tournaments.participantFor(r.user!.orgId, { teamId: t.id });
  });

  route('GET', '/api/leaderboard', 'stats.view', (r) => {
    const sport = r.query.get('sport') ?? 'football';
    const stat = r.query.get('stat') ?? (sport === 'cricket' ? 'runs' : sport === 'basketball' ? 'pts' : 'goals');
    const rows = db.prepare('SELECT player_id, stats, won FROM player_match_stats WHERE org_id = ? AND sport = ?').all(r.user!.orgId, sport) as any[];
    const agg = new Map<string, { total: number; played: number; won: number }>();
    for (const row of rows) {
      const a = agg.get(row.player_id) ?? { total: 0, played: 0, won: 0 };
      a.total += Number(P(row.stats, {} as any)[stat] ?? 0);
      a.played++;
      if (row.won === 1) a.won++;
      agg.set(row.player_id, a);
    }
    const name = db.prepare('SELECT name, rating FROM players WHERE id = ?');
    return [...agg.entries()]
      .map(([pid, a]) => {
        const p = name.get(pid) as any;
        return { playerId: pid, name: p?.name ?? pid, [stat]: a.total, played: a.played, won: a.won, elo: P(p?.rating, {} as any)[sport] ?? null };
      })
      .sort((a: any, b: any) => (stat === 'elo' ? (b.elo ?? 0) - (a.elo ?? 0) : b[stat] - a[stat]))
      .slice(0, 50);
  });

  // ------------------------------------------------------------------ tournaments
  route('GET', '/api/tournaments', 'auth', (r) => tournaments.list(r.user!.orgId));
  route('POST', '/api/tournaments', 'tournament.manage', (r) => {
    const b = validate(r.body, { name: 'string', sport: 'string', discipline: 'string', format: 'string', entrants: 'array', venueId: 'string?', groups: 'number?', matchConfig: 'object?' });
    getSport(b.sport);
    return tournaments.create(r.user!, b as any);
  });
  route('GET', '/api/tournaments/:id', 'auth', (r) => {
    const t = tournaments.row(r.user!.orgId, r.params.id);
    return { ...t, config: P(t.config, {}), entrants: tournaments.entrants(t.id), standings: tournaments.standings(t.id), matches: matches.list(r.user!.orgId, { tournamentId: t.id }).map(matchListItem) };
  });
  route('POST', '/api/tournaments/:id/generate', 'tournament.manage', (r) => {
    const b = validate(r.body ?? {}, { startAt: 'string?', slotMinutes: 'number?', surfaceIds: 'array?' });
    const ms = tournaments.generate(r.user!, r.params.id, b);
    displays.scheduleOrgRefresh(r.user!.orgId);
    return { created: ms.length, matches: ms.map(matchListItem) };
  });

  // ------------------------------------------------------------------ matches
  const matchListItem = (m: any) => ({
    id: m.id, code: m.public_code, sport: m.sport, discipline: m.discipline, status: m.status, label: m.label, round: m.round,
    participants: P<any[]>(m.participants).map((p) => ({ id: p.id, name: p.name, short: p.short })), scheduledAt: m.scheduled_at,
    surfaceId: m.surface_id, venueId: m.venue_id, tournamentId: m.tournament_id, score: P(m.score), display: P(m.display), visibility: m.visibility, scorerUserId: m.scorer_user_id,
  });
  route('GET', '/api/matches', 'auth', (r) =>
    matches.list(r.user!.orgId, { status: r.query.get('status') ?? undefined, tournamentId: r.query.get('tournamentId') ?? undefined, venueId: r.query.get('venueId') ?? undefined }).map(matchListItem));
  route('POST', '/api/matches', 'match.manage', (r) => {
    const b = validate(r.body, { sport: 'string', discipline: 'string', participants: 'array', config: 'object?', surfaceId: 'string?', scheduledAt: 'string?', visibility: 'string?', scorerUserId: 'string?', label: 'string?' });
    const parts = b.participants.map((p: any) => (p.teamId || p.playerIds ? tournaments.participantFor(r.user!.orgId, p) : p));
    return matchListItem(matches.create(r.user!, { ...b, participants: parts } as any));
  });
  route('GET', '/api/matches/:id', 'auth', (r) => {
    const m = matches.rowForOrg(r.user!.orgId, r.params.id);
    return { match: { ...matchListItem(m), config: P(m.config), participants: P(m.participants) }, snapshot: matches.snapshot(m.id), meta: matches.meta(m) };
  });
  route('PATCH', '/api/matches/:id', 'match.manage', (r) => {
    const b = validate(r.body, { surfaceId: 'string?', scheduledAt: 'string?', scorerUserId: 'string?', visibility: 'string?', label: 'string?' });
    return matchListItem(matches.update(r.user!, r.params.id, b));
  });
  route('GET', '/api/matches/:id/events', 'auth', (r) => {
    matches.rowForOrg(r.user!.orgId, r.params.id);
    return matches.events(r.params.id, Number(r.query.get('since') ?? 0));
  });
  route('POST', '/api/matches/:id/events', 'match.score', (r) => {
    if (!writeLimiter.take(`w:${r.user!.id}`)) throw new HttpError(429, 'Too many requests', 'RATE_LIMIT');
    const inputs = Array.isArray(r.body?.events) ? r.body.events : [r.body];
    const since = Number(r.body?.since ?? -1);
    const out = matches.appendEvents(r.user!, r.params.id, inputs);
    // Offline sync: return every event after the client's last known seq so it can rebase.
    return since >= 0 ? { ...out, events: matches.events(r.params.id, since) } : out;
  });
  route('POST', '/api/matches/:id/undo', 'match.score', (r) => matches.undo(r.user!, r.params.id));
  route('POST', '/api/matches/:id/redo', 'match.score', (r) => matches.redo(r.user!, r.params.id));
  route('GET', '/api/matches/:id/insights', 'stats.view', async (r) => {
    const m = matches.rowForOrg(r.user!.orgId, r.params.id);
    const facts = buildFacts(m, matches.aggregate(m.id), matches.meta(m));
    const text = await templateProvider.summarize(facts);
    return { provider: templateProvider.name, ...text, playerOfTheMatch: playerOfTheMatch(facts), facts };
  });

  // ------------------------------------------------------------------ displays
  route('POST', '/api/displays/register', 'public', (r) => {
    if (!authLimiter.take(`reg:${r.ip}`)) throw new HttpError(429, 'Too many requests', 'RATE_LIMIT');
    return displays.register({ userAgent: r.headers['user-agent'], resolution: r.body?.resolution, orientation: r.body?.orientation });
  });
  route('POST', '/api/displays/pair', 'display.manage', (r) => {
    const b = validate(r.body, { code: 'string', name: 'string?', venueId: 'string?', assignment: 'object?' });
    return displays.pair(r.user!, b.code, b as any);
  });
  route('GET', '/api/displays', 'display.manage', (r) => displays.list(r.user!.orgId));
  route('PATCH', '/api/displays/:id', 'display.manage', (r) => displays.update(r.user!, r.params.id, r.body ?? {}));
  route('POST', '/api/displays/:id/refresh', 'display.manage', (r) => (displays.refresh(r.user!, r.params.id), { ok: true }));
  route('POST', '/api/displays/:id/unpair', 'display.manage', (r) => (displays.unpair(r.user!, r.params.id), { ok: true }));
  route('POST', '/api/displays/announce', 'display.manage', (r) => {
    const b = validate(r.body, { text: 'string', level: 'string?', seconds: 'number?', displayIds: 'array?' });
    return displays.announce(r.user!, b as any);
  });
  route('GET', '/api/playlists', 'display.manage', (r) => displays.listPlaylists(r.user!.orgId));
  route('POST', '/api/playlists', 'display.manage', (r) => {
    const b = validate(r.body, { name: 'string', items: 'array' });
    return displays.createPlaylist(r.user!, b.name, b.items);
  });
  route('POST', '/api/sponsors', 'sponsor.manage', (r) => {
    const b = validate(r.body, { name: 'string', logoUrl: 'string?', url: 'string?', tier: 'string?', tournamentId: 'string?' });
    const sid = id();
    db.prepare('INSERT INTO sponsors (id, org_id, name, logo_url, url, tier, tournament_id, created_at) VALUES (?,?,?,?,?,?,?,?)').run(sid, r.user!.orgId, b.name, b.logoUrl ?? null, b.url ?? null, b.tier ?? 'partner', b.tournamentId ?? null, now());
    return { id: sid };
  });

  // ------------------------------------------------------------------ public (no login)
  const publicMatch = (code: string) => {
    const m = matches.byCode(code);
    if (!m || m.visibility !== 'public') throw new HttpError(404, 'Match not found', 'NOT_FOUND');
    return m;
  };
  route('GET', '/api/public/m/:code', 'public', (r) => {
    const m = publicMatch(r.params.code);
    const agg = matches.aggregate(m.id);
    return { ...matches.publicView(m), timeline: agg.timeline.slice(-60).reverse(), statistics: agg.statistics() };
  });
  route('GET', '/api/public/t/:code', 'public', (r) => {
    const t = db.prepare("SELECT * FROM tournaments WHERE public_code = ?").get(r.params.code.toUpperCase()) as any;
    if (!t) throw new HttpError(404, 'Tournament not found', 'NOT_FOUND');
    return tournaments.publicView(t);
  });
  route('GET', '/share/:code', 'public', (r) => raw('image/svg+xml', shareCardSvg(matches.publicView(publicMatch(r.params.code.replace(/\.svg$/, ''))))));
  route('GET', '/api/qr', 'public', async (r) => {
    const data = r.query.get('data') ?? '';
    if (!data || data.length > 512) throw new HttpError(400, 'data required (max 512 chars)', 'VALIDATION');
    return raw('image/svg+xml', await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#062547', light: '#FFFFFF' } }), 200, { 'cache-control': 'public, max-age=86400' });
  });
  route('GET', '/api/health', 'public', () => ({ ok: true, time: now(), sockets: hub.clients.size }));

  // ------------------------------------------------------------------ static web app
  const PAGES: [RegExp, string][] = [
    [/^\/$/, 'index.html'], [/^\/console(\/.*)?$/, 'index.html'], [/^\/pair$/, 'index.html'],
    [/^\/score\/[^/]+$/, 'score.html'], [/^\/tv(\/.*)?$/, 'tv.html'], [/^\/overlay\/.+$/, 'tv.html'],
    [/^\/live\/[^/]+$/, 'live.html'], [/^\/t\/[^/]+$/, 'live.html'],
  ];
  const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
  async function serveStatic(p: string): Promise<Raw | null> {
    const page = PAGES.find(([re]) => re.test(p));
    const rel = page ? page[1] : p.replace(/^\/+/, '');
    const file = path.resolve(WEB_ROOT, rel);
    if (!file.startsWith(WEB_ROOT) || !existsSync(file)) return null;
    const ext = path.extname(file);
    const cache = ext === '.html' || rel === 'sw.js' ? 'no-cache' : 'public, max-age=300';
    return raw(TYPES[ext] ?? 'application/octet-stream', await readFile(file), 200, { 'cache-control': cache });
  }

  // ------------------------------------------------------------------ HTTP plumbing
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || '';
    const embeddable = /^\/(tv|overlay)/.test(url.pathname);
    const headers: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': `default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; frame-ancestors ${embeddable ? '*' : "'none'"}`,
    };
    const reply = (status: number, body: any, extra: Record<string, string> = {}) => {
      if (body && body.__raw) {
        res.writeHead(body.status ?? status, { ...headers, 'content-type': body.type, ...(body.headers ?? {}), ...extra });
        res.end(body.body);
        return;
      }
      res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(body));
    };
    try {
      const method = req.method ?? 'GET';
      const match = routes.map((rt) => ({ rt, m: rt.method === method ? url.pathname.match(rt.re) : null })).find((x) => x.m);
      if (!match) {
        if (method === 'GET' && !url.pathname.startsWith('/api/')) {
          const s = await serveStatic(url.pathname);
          if (s) return reply(200, s);
        }
        throw new HttpError(404, 'Not found', 'NOT_FOUND');
      }
      if (match.rt.perm === 'public' && !publicLimiter.take(`p:${ip}`)) throw new HttpError(429, 'Too many requests', 'RATE_LIMIT');
      if (url.pathname.startsWith('/api/auth/') && !authLimiter.take(`a:${ip}`)) throw new HttpError(429, 'Too many attempts — try again shortly', 'RATE_LIMIT');
      const auth = req.headers.authorization;
      const tok = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      const user = userFromToken(db, tok);
      const perm = match.rt.perm;
      if (perm !== 'public') {
        if (!user) throw new HttpError(401, 'Sign in required', 'UNAUTHORIZED');
        if (perm !== 'auth' && !can(user, perm!)) throw new HttpError(403, 'You do not have permission for this action', 'FORBIDDEN');
      }
      let body: any = undefined;
      if (method !== 'GET' && method !== 'HEAD') body = await readJson(req);
      const params: Record<string, string> = {};
      match.rt.keys.forEach((k, i) => (params[k] = decodeURIComponent(match.m![i + 1])));
      const out = await match.rt.h({ method, path: url.pathname, query: url.searchParams, params, body, user, ip, headers: req.headers, token: tok });
      reply(200, out ?? { ok: true });
    } catch (e: any) {
      if (e instanceof HttpError) return reply(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      console.error(e);
      reply(500, { error: { code: 'INTERNAL', message: 'Something went wrong' } });
    }
  });

  // ------------------------------------------------------------------ WebSocket
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', (ws, req) => {
    const c: Client = hub.add(ws);
    const url = new URL(req.url ?? '/', 'http://x');
    const user = userFromToken(db, url.searchParams.get('token'));
    if (user) c.userId = user.id;
    ws.on('pong', () => (c.alive = true));
    ws.on('close', () => hub.remove(c));
    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        handleWs(c, user, msg);
      } catch (e: any) {
        send(c, { t: 'error', message: e?.message ?? 'error' });
      }
    });
    send(c, { t: 'hello' });
  });

  function handleWs(c: Client, user: AuthUser | null, msg: any) {
    switch (msg.t) {
      case 'ping':
        return send(c, { t: 'pong', id: msg.id });
      case 'sub': {
        const [kind, code] = String(msg.topic ?? '').split(':');
        if (kind === 'match') {
          const m = matches.byCode(code ?? '');
          const allowed = m && (m.visibility === 'public' || (user && user.orgId === m.org_id));
          if (!allowed) return send(c, { t: 'error', topic: msg.topic, message: 'Not found' });
          hub.subscribe(c, `match:${m!.public_code}`);
          return send(c, { t: 'match', topic: `match:${m!.public_code}`, match: matches.publicView(m!) });
        }
        if (kind === 'tournament') {
          const t = db.prepare('SELECT * FROM tournaments WHERE public_code = ?').get(String(code).toUpperCase()) as any;
          if (!t) return send(c, { t: 'error', topic: msg.topic, message: 'Not found' });
          hub.subscribe(c, `tournament:${t.public_code}`);
          return send(c, { t: 'tournament', topic: `tournament:${t.public_code}`, tournament: tournaments.publicView(t) });
        }
        return;
      }
      case 'unsub':
        return hub.unsubscribe(c, String(msg.topic));
      case 'display.hello': {
        const d = displays.authenticate(String(msg.deviceId ?? ''), String(msg.secret ?? ''));
        if (!d) return send(c, { t: 'display.unknown' });
        c.deviceId = d.id;
        displays.heartbeat(d.id, { resolution: msg.resolution });
        const { message, topics } = displays.resolve(d);
        return displays.attach(c, message, topics);
      }
      case 'display.hb':
        if (c.deviceId) displays.heartbeat(c.deviceId, { lastUpdate: msg.lastUpdate, resolution: msg.resolution });
        return send(c, { t: 'display.hb.ack' });
    }
  }

  const ping = setInterval(() => {
    for (const c of hub.clients) {
      if (!c.alive) {
        c.ws.terminate();
        hub.remove(c);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 25_000);

  return {
    server, ctx, matches, tournaments, displays,
    async close() {
      clearInterval(ping);
      displays.dispose();
      for (const c of hub.clients) c.ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request body too large', 'TOO_LARGE');
    chunks.push(ch);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON', 'VALIDATION');
  }
}
