/**
 * Match service: the only write path for scores.
 *   validate → persist (single transaction) → update projection → broadcast → side effects
 * Scores are never edited in place: everything is an appended event.
 */
import { MatchAggregate, EventRejected, hasSport, getDiscipline, type EventInput, type MatchEvent, type Participant } from '../../../../packages/engine/src/index.ts';
import type { AuthUser } from '../auth.ts';
import { ASSIGNMENT_SCOPED, can } from '../auth.ts';
import { HttpError, id, publicCode, type Ctx } from '../context.ts';
import { J, P, now, tx } from '../db.ts';

export interface MatchRow {
  id: string;
  org_id: string;
  tournament_id: string | null;
  fixture_key: string | null;
  round: number | null;
  label: string | null;
  grp: string | null;
  winner_to: string | null;
  sport: string;
  discipline: string;
  config: string;
  participants: string;
  entrant_ids: string;
  venue_id: string | null;
  surface_id: string | null;
  scheduled_at: string | null;
  status: string;
  visibility: string;
  public_code: string;
  version: number;
  winner: number | null;
  score: string | null;
  display: string | null;
  scorer_user_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export type EventResult =
  | { clientEventId: string; status: 'accepted' | 'duplicate'; seq: number; eventId: string }
  | { clientEventId: string; status: 'rejected'; error: string };

type CompletedHook = (row: MatchRow, agg: MatchAggregate) => void;

export class MatchService {
  private cache = new Map<string, MatchAggregate>();
  private completedHooks: CompletedHook[] = [];
  private statusHooks: ((row: MatchRow) => void)[] = [];

  constructor(private ctx: Ctx) {}

  onCompleted(fn: CompletedHook) {
    this.completedHooks.push(fn);
  }
  onStatusChange(fn: (row: MatchRow) => void) {
    this.statusHooks.push(fn);
  }

  // ------------------------------------------------------------ queries
  row(matchId: string): MatchRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as any;
  }

  rowForOrg(orgId: string, matchId: string): MatchRow {
    const r = this.row(matchId);
    if (!r || r.org_id !== orgId) throw new HttpError(404, 'Match not found', 'NOT_FOUND');
    return r;
  }

  byCode(code: string): MatchRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM matches WHERE public_code = ?').get(code.toUpperCase()) as any;
  }

  definition(r: MatchRow) {
    return { id: r.id, sport: r.sport, discipline: r.discipline, config: P(r.config, {}), participants: P<[Participant, Participant]>(r.participants) };
  }

  events(matchId: string, sinceSeq = 0): MatchEvent[] {
    return (this.ctx.db.prepare('SELECT * FROM match_events WHERE match_id = ? AND seq > ? ORDER BY seq').all(matchId, sinceSeq) as any[]).map((e) => ({
      id: e.id, clientEventId: e.client_event_id, matchId: e.match_id, seq: e.seq, type: e.type, payload: P(e.payload, {}),
      actorId: e.actor_id ?? undefined, createdAt: e.created_at, deviceTime: e.device_time ?? undefined,
    }));
  }

  aggregate(matchId: string): MatchAggregate {
    let a = this.cache.get(matchId);
    if (a) return a;
    const r = this.row(matchId);
    if (!r) throw new HttpError(404, 'Match not found', 'NOT_FOUND');
    a = new MatchAggregate(this.definition(r), this.events(matchId));
    this.cache.set(matchId, a);
    if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value!);
    return a;
  }

  list(orgId: string, f: { status?: string; tournamentId?: string; surfaceId?: string; venueId?: string } = {}): MatchRow[] {
    const where = ['org_id = ?'];
    const args: any[] = [orgId];
    if (f.status) (where.push('status = ?'), args.push(f.status));
    if (f.tournamentId) (where.push('tournament_id = ?'), args.push(f.tournamentId));
    if (f.surfaceId) (where.push('surface_id = ?'), args.push(f.surfaceId));
    if (f.venueId) (where.push('venue_id = ?'), args.push(f.venueId));
    return this.ctx.db.prepare(`SELECT * FROM matches WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at, created_at), created_at LIMIT 500`).all(...args) as any;
  }

  // ------------------------------------------------------------ commands
  create(user: AuthUser, input: {
    sport: string; discipline: string; config?: Record<string, any>; participants: Participant[];
    entrantIds?: string[]; venueId?: string; surfaceId?: string; scheduledAt?: string; tournamentId?: string;
    fixtureKey?: string; round?: number; label?: string; group?: string; winnerTo?: any; visibility?: 'public' | 'private'; scorerUserId?: string;
  }): MatchRow {
    if (!hasSport(input.sport)) throw new HttpError(400, `Unknown sport ${input.sport}`, 'VALIDATION');
    try {
      getDiscipline(input.sport, input.discipline);
    } catch (e: any) {
      throw new HttpError(400, e.message, 'VALIDATION');
    }
    if (!Array.isArray(input.participants) || input.participants.length !== 2) throw new HttpError(400, 'Exactly two participants (sides) are required', 'VALIDATION');
    const parts = input.participants.map((p, i) => ({
      id: String(p.id ?? `side-${i}`), name: String(p.name ?? `Side ${i + 1}`).slice(0, 80), short: p.short?.slice(0, 6), color: p.color,
      logoUrl: p.logoUrl, players: (p.players ?? []).map((pl) => ({ id: String(pl.id), name: String(pl.name).slice(0, 80), number: pl.number, position: pl.position })),
    }));
    if (input.surfaceId) this.assertSurface(user.orgId, input.surfaceId);
    const mid = id();
    const t = now();
    let code = publicCode();
    while (this.byCode(code)) code = publicCode();
    const venueId = input.venueId ?? (input.surfaceId ? (this.ctx.db.prepare('SELECT venue_id FROM surfaces WHERE id = ?').get(input.surfaceId) as any)?.venue_id : null);
    this.ctx.db.prepare(`INSERT INTO matches (id, org_id, tournament_id, fixture_key, round, label, grp, winner_to, sport, discipline, config, participants, entrant_ids,
      venue_id, surface_id, scheduled_at, visibility, public_code, scorer_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      mid, user.orgId, input.tournamentId ?? null, input.fixtureKey ?? null, input.round ?? null, input.label ?? null, input.group ?? null,
      input.winnerTo ? J(input.winnerTo) : null, input.sport, input.discipline, J(input.config ?? {}), J(parts), J(input.entrantIds ?? parts.map((p) => p.id)),
      venueId ?? null, input.surfaceId ?? null, input.scheduledAt ?? null, input.visibility ?? 'public', code, input.scorerUserId ?? null, t, t,
    );
    const agg = this.aggregate(mid);
    this.project(mid, agg);
    this.ctx.audit(user.orgId, user.id, 'match.create', 'match', mid, { sport: input.sport });
    return this.row(mid)!;
  }

  update(user: AuthUser, matchId: string, patch: { surfaceId?: string | null; scheduledAt?: string | null; scorerUserId?: string | null; visibility?: string; label?: string; participants?: Participant[] }) {
    const r = this.rowForOrg(user.orgId, matchId);
    if (patch.participants) {
      if (r.status !== 'scheduled') throw new HttpError(409, 'Participants can only change before the match starts', 'CONFLICT');
      this.setParticipants(matchId, patch.participants);
    }
    if (patch.surfaceId) this.assertSurface(user.orgId, patch.surfaceId);
    const venueId = patch.surfaceId ? (this.ctx.db.prepare('SELECT venue_id FROM surfaces WHERE id = ?').get(patch.surfaceId) as any)?.venue_id : r.venue_id;
    this.ctx.db.prepare('UPDATE matches SET surface_id = ?, venue_id = ?, scheduled_at = ?, scorer_user_id = ?, visibility = ?, label = ?, updated_at = ? WHERE id = ?').run(
      patch.surfaceId !== undefined ? patch.surfaceId : r.surface_id, venueId ?? null,
      patch.scheduledAt !== undefined ? patch.scheduledAt : r.scheduled_at,
      patch.scorerUserId !== undefined ? patch.scorerUserId : r.scorer_user_id,
      patch.visibility ?? r.visibility, patch.label ?? r.label, now(), matchId,
    );
    this.ctx.audit(user.orgId, user.id, 'match.update', 'match', matchId, patch);
    const row = this.row(matchId)!;
    for (const h of this.statusHooks) h(row);
    return row;
  }

  setParticipants(matchId: string, participants: Participant[]) {
    this.ctx.db.prepare('UPDATE matches SET participants = ?, entrant_ids = ?, updated_at = ? WHERE id = ?').run(J(participants), J(participants.map((p) => p.id)), now(), matchId);
    this.cache.delete(matchId);
    this.project(matchId, this.aggregate(matchId));
    this.broadcast(this.row(matchId)!);
  }

  private assertSurface(orgId: string, surfaceId: string) {
    const s = this.ctx.db.prepare('SELECT org_id FROM surfaces WHERE id = ?').get(surfaceId) as any;
    if (!s || s.org_id !== orgId) throw new HttpError(400, 'Unknown court/table/field', 'VALIDATION');
  }

  assertCanScore(user: AuthUser, r: MatchRow) {
    if (r.org_id !== user.orgId) throw new HttpError(404, 'Match not found', 'NOT_FOUND');
    if (!can(user, 'match.score')) throw new HttpError(403, 'You do not have permission to score', 'FORBIDDEN');
    if (ASSIGNMENT_SCOPED.includes(user.role) && r.scorer_user_id && r.scorer_user_id !== user.id)
      throw new HttpError(403, 'This match is assigned to a different scorer', 'FORBIDDEN');
  }

  /**
   * Apply a batch of scorer inputs in order. Used for live taps (batch of 1) and for
   * offline queue flushes. Each input carries a clientEventId, so retries are idempotent.
   * Conflict policy: server-authoritative re-validation against the latest state. An
   * offline event that is no longer legal (e.g. another device already ended the set)
   * is rejected and returned to the device for review; it is never force-applied.
   */
  appendEvents(user: AuthUser, matchId: string, inputs: EventInput[]): { results: EventResult[]; snapshot: any } {
    const r = this.row(matchId);
    if (!r) throw new HttpError(404, 'Match not found', 'NOT_FOUND');
    this.assertCanScore(user, r);
    if (!inputs.length) throw new HttpError(400, 'No events', 'VALIDATION');
    if (inputs.length > 500) throw new HttpError(413, 'Too many events in one batch', 'VALIDATION');
    const agg = this.aggregate(matchId);
    const before = agg.status;
    const results: EventResult[] = [];
    const t = now();
    const insert = this.ctx.db.prepare('INSERT INTO match_events (match_id, seq, id, client_event_id, type, payload, actor_id, created_at, device_time) VALUES (?,?,?,?,?,?,?,?,?)');
    try {
     tx(this.ctx.db, () => {
      for (const input of inputs) {
        const cid = String(input.clientEventId ?? id());
        if (typeof input.type !== 'string') {
          results.push({ clientEventId: cid, status: 'rejected', error: 'type required' });
          continue;
        }
        if (input.type === 'MATCH_START') {
          const tbd = agg.match.participants.some((p) => p.id === 'tbd');
          if (tbd) {
            results.push({ clientEventId: cid, status: 'rejected', error: 'Participants are not decided yet' });
            continue;
          }
        }
        // Device time is accepted for clocks, but clamped to a sane window around server time.
        let deviceTime = input.deviceTime && !Number.isNaN(Date.parse(input.deviceTime)) ? input.deviceTime : t;
        if (Math.abs(Date.parse(deviceTime) - Date.now()) > 7 * 864e5) deviceTime = t;
        const ev = agg.createEvent({ ...input, clientEventId: cid, actorId: user.id, deviceTime }, t);
        try {
          const { event, duplicate } = agg.append(ev);
          if (!duplicate)
            insert.run(matchId, event.seq, event.id, event.clientEventId, event.type, J(event.payload), event.actorId ?? null, event.createdAt, event.deviceTime ?? null);
          results.push({ clientEventId: cid, status: duplicate ? 'duplicate' : 'accepted', seq: event.seq, eventId: event.id });
        } catch (e: any) {
          if (e instanceof EventRejected) results.push({ clientEventId: cid, status: 'rejected', error: e.message });
          else throw e;
        }
      }
      this.project(matchId, agg);
     });
    } catch (e) {
      // The transaction rolled back; the cached aggregate may hold events that were never stored.
      this.cache.delete(matchId);
      throw e;
    }
    const row = this.row(matchId)!;
    this.broadcast(row);
    if (agg.status !== before) {
      for (const h of this.statusHooks) h(row);
      if (agg.status === 'completed') for (const h of this.completedHooks) h(row, agg);
    }
    return { results, snapshot: this.snapshot(matchId) };
  }

  undo(user: AuthUser, matchId: string) {
    const agg = this.aggregate(matchId);
    const input = agg.undoInput();
    if (!input) throw new HttpError(409, 'Nothing to undo', 'CONFLICT');
    return this.appendEvents(user, matchId, [input]);
  }

  redo(user: AuthUser, matchId: string) {
    const agg = this.aggregate(matchId);
    const input = agg.redoInput();
    if (!input) throw new HttpError(409, 'Nothing to redo', 'CONFLICT');
    return this.appendEvents(user, matchId, [input]);
  }

  /** Write the read-model columns used by lists, standings and displays. */
  private project(matchId: string, agg: MatchAggregate) {
    const display = agg.display();
    this.ctx.db.prepare('UPDATE matches SET status = ?, version = ?, winner = ?, score = ?, display = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?').run(
      agg.status, agg.version, agg.winner(), J(agg.score()), J(display), agg.startedAt ?? null, agg.endedAt ?? null, now(), matchId,
    );
  }

  snapshot(matchId: string) {
    const r = this.row(matchId)!;
    const agg = this.aggregate(matchId);
    return { ...agg.snapshot(), publicCode: r.public_code, timeline: agg.timeline.slice(-50).reverse(), statistics: agg.statistics() };
  }

  /** Public projection: only what a spectator or TV may see. */
  publicView(r: MatchRow) {
    const meta = this.meta(r);
    return { code: r.public_code, sport: r.sport, discipline: r.discipline, status: r.status, scheduledAt: r.scheduled_at, ...meta, display: P(r.display) };
  }

  meta(r: MatchRow) {
    const surface = r.surface_id ? (this.ctx.db.prepare('SELECT name FROM surfaces WHERE id = ?').get(r.surface_id) as any)?.name : null;
    const venue = r.venue_id ? (this.ctx.db.prepare('SELECT name FROM venues WHERE id = ?').get(r.venue_id) as any)?.name : null;
    const t = r.tournament_id ? (this.ctx.db.prepare('SELECT name, public_code FROM tournaments WHERE id = ?').get(r.tournament_id) as any) : null;
    const org = this.ctx.db.prepare('SELECT name, branding FROM organizations WHERE id = ?').get(r.org_id) as any;
    return { surface, venue, tournament: t?.name ?? null, tournamentCode: t?.public_code ?? null, label: r.label, organization: org?.name, branding: P(org?.branding, {}) };
  }

  broadcast(r: MatchRow) {
    // Always published; private matches are protected at subscribe time (see server WS auth).
    this.ctx.hub.publish(`match:${r.public_code}`, { t: 'match', match: this.publicView(r) });
  }
}
