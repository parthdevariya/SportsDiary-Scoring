/**
 * Big-screen display system.
 *
 *  Device lifecycle:  register (TV gets id+secret+PIN) → pair (organizer enters PIN or scans QR)
 *                     → assign (match | multi-court grid | venue courts | tournament boards | playlist)
 *                     → stream (same public real-time topics as the web/mobile apps) → heartbeat
 *
 *  A display never polls for scores: it subscribes to the topics its assignment resolves to,
 *  and the server re-resolves (and re-subscribes it) whenever the assignment or the set of
 *  live matches at a venue changes.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '../auth.ts';
import { sha256, token } from '../auth.ts';
import { HttpError, id, pin, type Ctx } from '../context.ts';
import { J, P, now } from '../db.ts';
import { send, type Client } from '../realtime.ts';
import type { MatchRow, MatchService } from './matches.ts';
import type { TournamentService } from './tournaments.ts';

export type ViewKind = 'match' | 'grid' | 'venue' | 'standings' | 'fixtures' | 'results' | 'upcoming' | 'sponsor' | 'announcement' | 'idle';

export interface ViewItem {
  kind: ViewKind;
  matchId?: string;
  matchIds?: string[];
  venueId?: string;
  tournamentId?: string;
  text?: string;
  title?: string;
  seconds?: number;
}

export interface Assignment {
  mode: 'idle' | 'match' | 'multi' | 'venue' | 'tournament' | 'playlist' | 'announcement';
  matchId?: string;
  matchIds?: string[];
  venueId?: string;
  tournamentId?: string;
  view?: 'standings' | 'fixtures' | 'results' | 'upcoming';
  playlistId?: string;
  items?: ViewItem[];
  text?: string;
  title?: string;
}

const PAIR_TTL_MIN = 30;
const ONLINE_WINDOW_MS = 45_000;

export class DisplayService {
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  /** Sponsor branding for a device (set by the sponsorship module). */
  brandingResolver: ((d: any, scope: { matchIds: string[]; tournamentIds: string[] }) => { view: any; sponsorsCompat: any[] }) | null = null;

  constructor(private ctx: Ctx, private matches: MatchService, private tournaments: TournamentService) {
    // Venue/tournament screens must follow matches as they start, finish and move courts.
    matches.onStatusChange((row) => this.scheduleOrgRefresh(row.org_id));
  }

  // ---------------------------------------------------------------- device side
  register(info: { userAgent?: string; resolution?: string; orientation?: string }) {
    const did = id();
    const secret = token(24);
    const code = this.freshPin();
    this.ctx.db.prepare('INSERT INTO display_devices (id, secret_hash, pairing_code, pairing_expires, user_agent, resolution, orientation, created_at) VALUES (?,?,?,?,?,?,?,?)').run(
      did, sha256(secret), code, new Date(Date.now() + PAIR_TTL_MIN * 60e3).toISOString(), info.userAgent?.slice(0, 300) ?? null, info.resolution?.slice(0, 30) ?? null,
      info.orientation === 'portrait' ? 'portrait' : 'landscape', now(),
    );
    return { deviceId: did, secret, pairingCode: code };
  }

  private freshPin(): string {
    for (let i = 0; i < 50; i++) {
      const c = pin();
      const taken = this.ctx.db.prepare('SELECT 1 FROM display_devices WHERE pairing_code = ? AND pairing_expires > ?').get(c, now());
      if (!taken) {
        this.ctx.db.prepare('UPDATE display_devices SET pairing_code = NULL WHERE pairing_code = ?').run(c);
        return c;
      }
    }
    throw new HttpError(503, 'Could not allocate a pairing code', 'UNAVAILABLE');
  }

  authenticate(deviceId: string, secret: string) {
    const d = this.ctx.db.prepare('SELECT * FROM display_devices WHERE id = ?').get(deviceId) as any;
    if (!d) return null;
    // Both sides are fixed-length sha256 hex digests, so a constant-time compare is safe.
    if (!timingSafeEqual(Buffer.from(d.secret_hash), Buffer.from(sha256(String(secret))))) return null;
    // Unpaired screen whose PIN expired gets a new one when it reconnects.
    if (!d.org_id && (!d.pairing_code || d.pairing_expires < now())) {
      const code = this.freshPin();
      this.ctx.db.prepare('UPDATE display_devices SET pairing_code = ?, pairing_expires = ? WHERE id = ?').run(code, new Date(Date.now() + PAIR_TTL_MIN * 60e3).toISOString(), d.id);
      d.pairing_code = code;
    }
    return d;
  }

  heartbeat(deviceId: string, info: { lastUpdate?: string; resolution?: string } = {}) {
    this.ctx.db.prepare('UPDATE display_devices SET last_heartbeat = ?, last_update = COALESCE(?, last_update), resolution = COALESCE(?, resolution) WHERE id = ?').run(
      now(), info.lastUpdate ?? null, info.resolution?.slice(0, 30) ?? null, deviceId,
    );
  }

  // ---------------------------------------------------------------- organizer side
  device(orgId: string, did: string) {
    const d = this.ctx.db.prepare('SELECT * FROM display_devices WHERE id = ? AND org_id = ?').get(did, orgId) as any;
    if (!d) throw new HttpError(404, 'Display not found', 'NOT_FOUND');
    return d;
  }

  pair(user: AuthUser, code: string, opts: { name?: string; venueId?: string; assignment?: Assignment } = {}) {
    const d = this.ctx.db.prepare('SELECT * FROM display_devices WHERE pairing_code = ?').get(String(code).replace(/\D/g, '')) as any;
    if (!d || d.pairing_expires < now()) throw new HttpError(404, 'Pairing code not found or expired — check the code on the screen', 'NOT_FOUND');
    if (d.org_id && d.org_id !== user.orgId) throw new HttpError(409, 'Screen is paired to another organization', 'CONFLICT');
    const count = (this.ctx.db.prepare('SELECT COUNT(*) AS n FROM display_devices WHERE org_id = ?').get(user.orgId) as any).n;
    const assignment = opts.assignment ? this.checkAssignment(user.orgId, opts.assignment) : { mode: 'idle' };
    this.ctx.db.prepare('UPDATE display_devices SET org_id = ?, name = ?, venue_id = ?, pairing_code = NULL, pairing_expires = NULL, assignment = ? WHERE id = ?').run(
      user.orgId, opts.name?.slice(0, 60) || `Screen ${count + 1}`, opts.venueId ?? null, J(assignment), d.id,
    );
    this.ctx.audit(user.orgId, user.id, 'display.pair', 'display', d.id);
    this.push(d.id);
    return this.summary(this.device(user.orgId, d.id));
  }

  list(orgId: string) {
    return (this.ctx.db.prepare('SELECT * FROM display_devices WHERE org_id = ? ORDER BY name').all(orgId) as any[]).map((d) => this.summary(d));
  }

  summary(d: any) {
    const connected = this.ctx.hub.displayClients(d.id).length > 0;
    const fresh = d.last_heartbeat && Date.now() - Date.parse(d.last_heartbeat) < ONLINE_WINDOW_MS;
    const assignment = P<Assignment>(d.assignment, { mode: 'idle' });
    return {
      id: d.id, name: d.name, venueId: d.venue_id, status: connected && fresh ? 'online' : connected ? 'syncing' : 'offline',
      lastHeartbeat: d.last_heartbeat, lastUpdate: d.last_update, orientation: d.orientation, aspect: d.aspect, theme: P(d.theme, {}),
      locked: !!d.locked, resolution: d.resolution, userAgent: d.user_agent, assignment, assignmentLabel: this.describe(d.org_id, assignment),
    };
  }

  update(user: AuthUser, did: string, patch: { name?: string; venueId?: string | null; assignment?: Assignment; orientation?: string; aspect?: string; theme?: any; locked?: boolean }) {
    const d = this.device(user.orgId, did);
    if (d.locked && patch.locked !== false && patch.assignment) throw new HttpError(423, 'Screen is locked — unlock it to change what it shows', 'LOCKED');
    const assignment = patch.assignment ? this.checkAssignment(user.orgId, patch.assignment) : P(d.assignment);
    const orientation = patch.orientation && ['landscape', 'portrait'].includes(patch.orientation) ? patch.orientation : d.orientation;
    const aspect = patch.aspect && ['16:9', '16:10', '9:16', '4:3'].includes(patch.aspect) ? patch.aspect : d.aspect;
    this.ctx.db.prepare('UPDATE display_devices SET name = ?, venue_id = ?, assignment = ?, orientation = ?, aspect = ?, theme = ?, locked = ? WHERE id = ?').run(
      patch.name?.slice(0, 60) ?? d.name, patch.venueId !== undefined ? patch.venueId : d.venue_id, J(assignment), orientation, aspect,
      patch.theme ? J(patch.theme) : d.theme, patch.locked === undefined ? d.locked : patch.locked ? 1 : 0, did,
    );
    this.ctx.audit(user.orgId, user.id, 'display.update', 'display', did, patch);
    this.push(did);
    return this.summary(this.device(user.orgId, did));
  }

  unpair(user: AuthUser, did: string) {
    this.device(user.orgId, did);
    const code = this.freshPin();
    this.ctx.db.prepare(`UPDATE display_devices SET org_id = NULL, assignment = '{"mode":"idle"}', pairing_code = ?, pairing_expires = ? WHERE id = ?`).run(
      code, new Date(Date.now() + PAIR_TTL_MIN * 60e3).toISOString(), did,
    );
    this.ctx.audit(user.orgId, user.id, 'display.unpair', 'display', did);
    this.push(did);
  }

  refresh(user: AuthUser, did: string) {
    this.device(user.orgId, did);
    for (const c of this.ctx.hub.displayClients(did)) send(c, { t: 'reload' });
  }

  /** Emergency / notice broadcast to every paired screen in the org (or a subset). */
  announce(user: AuthUser, input: { text: string; level?: 'info' | 'notice' | 'emergency' | 'sponsor'; seconds?: number; displayIds?: string[] }) {
    const level = input.level ?? 'notice';
    const seconds = Math.min(Math.max(input.seconds ?? 60, 5), 3600);
    const expires = new Date(Date.now() + seconds * 1000).toISOString();
    const aid = id();
    this.ctx.db.prepare('INSERT INTO announcements (id, org_id, text, level, expires_at, created_at) VALUES (?,?,?,?,?,?)').run(aid, user.orgId, input.text.slice(0, 500), level, expires, now());
    const msg = { t: 'announce', id: aid, text: input.text.slice(0, 500), level, until: expires };
    if (input.displayIds?.length) for (const did of input.displayIds) for (const c of this.ctx.hub.displayClients(did)) send(c, msg);
    else this.ctx.hub.publish(`org:${user.orgId}`, msg);
    this.ctx.audit(user.orgId, user.id, 'display.announce', 'announcement', aid, { level });
    return { id: aid, expires };
  }

  // ---------------------------------------------------------------- resolution
  private checkAssignment(orgId: string, a: Assignment): Assignment {
    const ownMatch = (mid: string) => {
      const r = this.matches.row(mid);
      if (!r || r.org_id !== orgId) throw new HttpError(400, `Unknown match ${mid}`, 'VALIDATION');
    };
    switch (a.mode) {
      case 'idle':
        return { mode: 'idle' };
      case 'match':
        ownMatch(a.matchId!);
        return { mode: 'match', matchId: a.matchId };
      case 'multi':
        if (!a.matchIds?.length || a.matchIds.length > 16) throw new HttpError(400, 'matchIds (1–16) required', 'VALIDATION');
        a.matchIds.forEach(ownMatch);
        return { mode: 'multi', matchIds: a.matchIds, title: a.title };
      case 'venue':
        if (!this.ctx.db.prepare('SELECT 1 FROM venues WHERE id = ? AND org_id = ?').get(a.venueId ?? '', orgId)) throw new HttpError(400, 'Unknown venue', 'VALIDATION');
        return { mode: 'venue', venueId: a.venueId, title: a.title };
      case 'tournament':
        this.tournaments.row(orgId, a.tournamentId!);
        return { mode: 'tournament', tournamentId: a.tournamentId, view: a.view ?? 'standings' };
      case 'announcement':
        return { mode: 'announcement', text: String(a.text ?? '').slice(0, 500) };
      case 'playlist': {
        let items = a.items;
        if (a.playlistId) {
          const pl = this.ctx.db.prepare('SELECT * FROM display_playlists WHERE id = ? AND org_id = ?').get(a.playlistId, orgId) as any;
          if (!pl) throw new HttpError(400, 'Unknown playlist', 'VALIDATION');
          items = P(pl.items);
        }
        if (!items?.length) throw new HttpError(400, 'Playlist needs items', 'VALIDATION');
        for (const it of items) {
          if (it.matchId) ownMatch(it.matchId);
          it.matchIds?.forEach(ownMatch);
          if (it.tournamentId) this.tournaments.row(orgId, it.tournamentId);
          it.seconds = Math.min(Math.max(it.seconds ?? 10, 3), 600);
        }
        return { mode: 'playlist', playlistId: a.playlistId, items };
      }
    }
    throw new HttpError(400, 'Unknown display mode', 'VALIDATION');
  }

  private describe(orgId: string | null, a: Assignment): string {
    if (!orgId) return 'Not paired';
    const m = (mid?: string) => {
      const r = mid ? this.matches.row(mid) : undefined;
      return r ? P<any[]>(r.participants).map((p) => p.name).join(' vs ') : '—';
    };
    switch (a.mode) {
      case 'match': return `Match: ${m(a.matchId)}`;
      case 'multi': return `${a.matchIds?.length} matches`;
      case 'venue': return `Courts at ${(this.ctx.db.prepare('SELECT name FROM venues WHERE id = ?').get(a.venueId ?? '') as any)?.name ?? 'venue'}`;
      case 'tournament': return `Tournament ${a.view}`;
      case 'playlist': return `Playlist (${a.items?.length ?? 0} items)`;
      case 'announcement': return 'Announcement';
      default: return 'Idle';
    }
  }

  /** Current match on each court of a venue: live first, else the next scheduled one. */
  venueCourts(venueId: string) {
    const surfaces = this.ctx.db.prepare('SELECT id, name FROM surfaces WHERE venue_id = ? ORDER BY sort, name').all(venueId) as any[];
    return surfaces.map((s) => {
      const live = this.ctx.db.prepare("SELECT * FROM matches WHERE surface_id = ? AND status IN ('live','paused') ORDER BY started_at DESC LIMIT 1").get(s.id) as any as MatchRow | undefined;
      const next = live ? undefined : (this.ctx.db.prepare("SELECT * FROM matches WHERE surface_id = ? AND status = 'scheduled' ORDER BY COALESCE(scheduled_at, created_at) LIMIT 1").get(s.id) as any as MatchRow | undefined);
      const last = live || next ? undefined : (this.ctx.db.prepare("SELECT * FROM matches WHERE surface_id = ? AND status = 'completed' ORDER BY ended_at DESC LIMIT 1").get(s.id) as any as MatchRow | undefined);
      const m = live ?? next ?? last;
      return { surfaceId: s.id, surface: s.name, matchId: m?.id ?? null };
    });
  }

  /** Turn a device's assignment into concrete views + the data and topics they need. */
  resolve(d: any) {
    const views: any[] = [];
    const matchIds = new Set<string>();
    const tournamentIds = new Set<string>();
    const a = P<Assignment>(d.assignment, { mode: 'idle' });
    const orgId = d.org_id as string | null;
    const addItem = (it: ViewItem) => {
      switch (it.kind) {
        case 'match':
          if (it.matchId) (matchIds.add(it.matchId), views.push({ kind: 'match', match: it.matchId, seconds: it.seconds }));
          break;
        case 'grid':
          it.matchIds?.forEach((x) => matchIds.add(x));
          views.push({ kind: 'grid', matches: it.matchIds, title: it.title, seconds: it.seconds });
          break;
        case 'venue': {
          const courts = this.venueCourts(it.venueId!);
          courts.forEach((c) => c.matchId && matchIds.add(c.matchId));
          const venue = (this.ctx.db.prepare('SELECT name FROM venues WHERE id = ?').get(it.venueId ?? '') as any)?.name;
          views.push({ kind: 'grid', courts, title: it.title ?? venue, seconds: it.seconds });
          break;
        }
        case 'standings':
        case 'fixtures':
        case 'results':
        case 'upcoming':
          if (it.tournamentId) {
            tournamentIds.add(it.tournamentId);
            views.push({ kind: it.kind, tournament: it.tournamentId, seconds: it.seconds });
          } else if (it.kind === 'upcoming' || it.kind === 'results') {
            const status = it.kind === 'upcoming' ? "('scheduled')" : "('completed')";
            const rows = orgId ? (this.ctx.db.prepare(`SELECT id FROM matches WHERE org_id = ? AND visibility = 'public' AND status IN ${status} ORDER BY ${it.kind === 'upcoming' ? 'COALESCE(scheduled_at, created_at)' : 'ended_at DESC'} LIMIT 12`).all(orgId) as any[]) : [];
            rows.forEach((r) => matchIds.add(r.id));
            views.push({ kind: it.kind, matches: rows.map((r) => r.id), seconds: it.seconds });
          }
          break;
        case 'sponsor':
          views.push({ kind: 'sponsor', seconds: it.seconds });
          break;
        case 'announcement':
          views.push({ kind: 'announcement', text: it.text, seconds: it.seconds });
          break;
        default:
          views.push({ kind: 'idle' });
      }
    };
    if (orgId) {
      if (a.mode === 'match') addItem({ kind: 'match', matchId: a.matchId });
      else if (a.mode === 'multi') addItem({ kind: 'grid', matchIds: a.matchIds, title: a.title });
      else if (a.mode === 'venue') addItem({ kind: 'venue', venueId: a.venueId, title: a.title });
      else if (a.mode === 'tournament') addItem({ kind: a.view ?? 'standings', tournamentId: a.tournamentId });
      else if (a.mode === 'announcement') addItem({ kind: 'announcement', text: a.text });
      else if (a.mode === 'playlist') a.items?.forEach(addItem);
      else views.push({ kind: 'idle' });
    }
    // Map internal ids → public codes so the client only ever handles public identifiers.
    const matchData: Record<string, any> = {};
    const codeOf: Record<string, string> = {};
    for (const mid of matchIds) {
      const r = this.matches.row(mid);
      if (!r || r.org_id !== orgId) continue;
      codeOf[mid] = r.public_code;
      matchData[r.public_code] = this.matches.publicView(r);
    }
    const tData: Record<string, any> = {};
    const tCode: Record<string, string> = {};
    for (const tid of tournamentIds) {
      const t = this.ctx.db.prepare('SELECT * FROM tournaments WHERE id = ? AND org_id = ?').get(tid, orgId) as any;
      if (!t) continue;
      tCode[tid] = t.public_code;
      tData[t.public_code] = this.tournaments.publicView(t);
      for (const m of tData[t.public_code].matches) matchData[m.code] ??= m;
    }
    const pub = views.map((v) => ({
      ...v,
      match: v.match ? codeOf[v.match] : undefined,
      matches: v.matches?.map((x: string) => codeOf[x]).filter(Boolean),
      courts: v.courts?.map((c: any) => ({ surface: c.surface, match: c.matchId ? codeOf[c.matchId] ?? null : null })),
      tournament: v.tournament ? tCode[v.tournament] : undefined,
    }));
    const org = orgId ? (this.ctx.db.prepare('SELECT name, branding FROM organizations WHERE id = ?').get(orgId) as any) : null;
    const legacy = orgId ? (this.ctx.db.prepare('SELECT name, logo_url AS logoUrl, tier FROM sponsors WHERE org_id = ? ORDER BY tier, name').all(orgId) as any[]) : [];
    const branding = orgId && this.brandingResolver ? this.brandingResolver(d, { matchIds: [...matchIds], tournamentIds: [...tournamentIds] }) : null;
    // `sponsors` keeps its original shape for older TV builds; `branding` carries placements.
    const sponsors = branding?.sponsorsCompat ?? legacy;
    const ann = orgId ? (this.ctx.db.prepare('SELECT id, text, level, expires_at AS until FROM announcements WHERE org_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(orgId, now()) as any) : null;
    const topics = [
      `display:${d.id}`,
      ...(orgId ? [`org:${orgId}`] : []),
      ...Object.keys(matchData).map((c) => `match:${c}`),
      ...Object.keys(tData).map((c) => `tournament:${c}`),
    ];
    return {
      message: {
        t: 'display.config',
        device: {
          id: d.id, name: d.name, paired: !!orgId, pairingCode: orgId ? null : d.pairing_code, orientation: d.orientation, aspect: d.aspect,
          theme: P(d.theme, {}), locked: !!d.locked, organization: org?.name ?? null, branding: P(org?.branding, {}),
        },
        views: pub,
        matches: matchData,
        tournaments: tData,
        sponsors,
        branding: branding?.view ?? null,
        announcement: ann,
      },
      topics,
    };
  }

  /** Send fresh config to every socket of a device and align its subscriptions. */
  push(did: string) {
    const d = this.ctx.db.prepare('SELECT * FROM display_devices WHERE id = ?').get(did) as any;
    if (!d) return;
    const { message, topics } = this.resolve(d);
    for (const c of this.ctx.hub.displayClients(did)) this.attach(c, message, topics);
  }

  attach(c: Client, message: any, topics: string[]) {
    this.ctx.hub.setTopics(c, topics);
    send(c, message);
  }

  dispose() {
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
  }

  /** Re-send config to every screen of an organizer (e.g. sponsor branding changed). */
  pushOrg(orgId: string) {
    const ds = this.ctx.db.prepare('SELECT id FROM display_devices WHERE org_id = ?').all(orgId) as any[];
    for (const d of ds) this.push(d.id);
  }

  scheduleOrgRefresh(orgId: string) {
    clearTimeout(this.refreshTimers.get(orgId));
    this.refreshTimers.set(
      orgId,
      setTimeout(() => {
        this.refreshTimers.delete(orgId);
        const ds = this.ctx.db.prepare('SELECT id, assignment FROM display_devices WHERE org_id = ?').all(orgId) as any[];
        for (const d of ds) {
          const a = P<Assignment>(d.assignment, { mode: 'idle' });
          const dynamic = a.mode === 'venue' || a.mode === 'tournament' || a.mode === 'playlist';
          if (dynamic) this.push(d.id);
        }
      }, 150),
    );
  }

  // ---------------------------------------------------------------- playlists
  createPlaylist(user: AuthUser, name: string, items: ViewItem[]) {
    const pid = id();
    const checked = this.checkAssignment(user.orgId, { mode: 'playlist', items }).items!;
    this.ctx.db.prepare('INSERT INTO display_playlists (id, org_id, name, items, created_at) VALUES (?,?,?,?,?)').run(pid, user.orgId, name.slice(0, 80), J(checked), now());
    return { id: pid, name, items: checked };
  }

  listPlaylists(orgId: string) {
    return (this.ctx.db.prepare('SELECT * FROM display_playlists WHERE org_id = ? ORDER BY name').all(orgId) as any[]).map((p) => ({ id: p.id, name: p.name, items: P(p.items) }));
  }
}
