/**
 * Tournament service: entrants, fixture generation, multi-court scheduling,
 * standings, knockout progression, and per-player stat rollups when matches finish.
 */
import { MatchAggregate, type Participant } from '../../../../packages/engine/src/index.ts';
import { roundRobin, knockout, makeGroups, schedule, standings, type Fixture } from '../../../../packages/engine/src/tournament/index.ts';
import type { AuthUser } from '../auth.ts';
import { HttpError, id, publicCode, type Ctx } from '../context.ts';
import { J, P, now, tx } from '../db.ts';
import type { MatchRow, MatchService } from './matches.ts';

export type Format = 'round_robin' | 'double_round_robin' | 'knockout' | 'groups_knockout';
const TBD: Participant = { id: 'tbd', name: 'TBD' };

export class TournamentService {
  constructor(private ctx: Ctx, private matches: MatchService) {
    matches.onCompleted((row, agg) => this.onMatchCompleted(row, agg));
  }

  row(orgId: string, tid: string) {
    const t = this.ctx.db.prepare('SELECT * FROM tournaments WHERE id = ? AND org_id = ?').get(tid, orgId) as any;
    if (!t) throw new HttpError(404, 'Tournament not found', 'NOT_FOUND');
    return t;
  }

  list(orgId: string) {
    return this.ctx.db.prepare('SELECT * FROM tournaments WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
  }

  /** Resolve a team, a set of players, or a free-text name into a match participant. */
  participantFor(orgId: string, e: { teamId?: string; playerIds?: string[]; name?: string }): Participant {
    if (e.teamId) {
      const t = this.ctx.db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?').get(e.teamId, orgId) as any;
      if (!t) throw new HttpError(400, `Unknown team ${e.teamId}`, 'VALIDATION');
      const players = this.ctx.db.prepare('SELECT p.id, p.name, tp.number, tp.position FROM team_players tp JOIN players p ON p.id = tp.player_id WHERE tp.team_id = ? ORDER BY CAST(tp.number AS INTEGER)').all(t.id) as any[];
      return { id: t.id, name: t.name, short: t.short ?? undefined, color: t.color ?? undefined, logoUrl: t.logo_url ?? undefined, players: players.map((p) => ({ id: p.id, name: p.name, number: p.number ?? undefined, position: p.position ?? undefined })) };
    }
    if (e.playerIds?.length) {
      const ps = e.playerIds.map((pid) => {
        const p = this.ctx.db.prepare('SELECT id, name FROM players WHERE id = ? AND org_id = ?').get(pid, orgId) as any;
        if (!p) throw new HttpError(400, `Unknown player ${pid}`, 'VALIDATION');
        return p;
      });
      const surname = (n: string) => n.split(' ').slice(-1)[0];
      return { id: ps.map((p) => p.id).join('+'), name: ps.length === 1 ? ps[0].name : ps.map((p) => surname(p.name)).join(' / '), players: ps.map((p) => ({ id: p.id, name: p.name })) };
    }
    if (e.name) return { id: `n:${e.name}`, name: e.name };
    throw new HttpError(400, 'Entrant needs teamId, playerIds or name', 'VALIDATION');
  }

  create(user: AuthUser, input: { name: string; sport: string; discipline: string; format: Format; config?: any; venueId?: string; entrants: any[]; groups?: number; matchConfig?: any }) {
    if (!['round_robin', 'double_round_robin', 'knockout', 'groups_knockout'].includes(input.format)) throw new HttpError(400, 'Unsupported format', 'VALIDATION');
    if (!input.entrants?.length || input.entrants.length < 2) throw new HttpError(400, 'At least two entrants required', 'VALIDATION');
    const tid = id();
    let code = publicCode();
    while (this.ctx.db.prepare('SELECT 1 FROM tournaments WHERE public_code = ?').get(code)) code = publicCode();
    const parts = input.entrants.map((e) => this.participantFor(user.orgId, e));
    tx(this.ctx.db, () => {
      this.ctx.db.prepare('INSERT INTO tournaments (id, org_id, name, sport, discipline, format, config, status, public_code, venue_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        tid, user.orgId, input.name, input.sport, input.discipline, input.format, J({ groups: input.groups ?? 2, matchConfig: input.matchConfig ?? {}, ...(input.config ?? {}) }), 'draft', code, input.venueId ?? null, now(),
      );
      const ins = this.ctx.db.prepare('INSERT INTO tournament_entrants (tournament_id, entrant_id, seed, participant) VALUES (?,?,?,?)');
      parts.forEach((p, i) => ins.run(tid, p.id, i + 1, J(p)));
    });
    this.ctx.audit(user.orgId, user.id, 'tournament.create', 'tournament', tid, { name: input.name });
    return this.row(user.orgId, tid);
  }

  entrants(tid: string): { id: string; seed: number; participant: Participant; grp: string | null }[] {
    return (this.ctx.db.prepare('SELECT * FROM tournament_entrants WHERE tournament_id = ? ORDER BY seed').all(tid) as any[]).map((r) => ({ id: r.entrant_id, seed: r.seed, participant: P(r.participant), grp: r.grp }));
  }

  /** Generate all fixtures as matches and lay them out across courts/tables/fields. */
  generate(user: AuthUser, tid: string, opts: { startAt?: string; slotMinutes?: number; surfaceIds?: string[] } = {}) {
    const t = this.row(user.orgId, tid);
    if (this.ctx.db.prepare('SELECT 1 FROM matches WHERE tournament_id = ? LIMIT 1').get(tid)) throw new HttpError(409, 'Fixtures already generated', 'CONFLICT');
    const ents = this.entrants(tid);
    const ids = ents.map((e) => e.id);
    const cfg = P(t.config, {} as any);
    let fixtures: Fixture[] = [];
    if (t.format === 'round_robin' || t.format === 'double_round_robin') fixtures = roundRobin(ids, { doubleRound: t.format === 'double_round_robin' });
    else if (t.format === 'knockout') fixtures = knockout(ids);
    else {
      const groups = makeGroups(ids, cfg.groups ?? 2);
      const setGrp = this.ctx.db.prepare('UPDATE tournament_entrants SET grp = ? WHERE tournament_id = ? AND entrant_id = ?');
      for (const [g, members] of Object.entries(groups)) {
        members.forEach((m) => setGrp.run(g, tid, m));
        fixtures.push(...roundRobin(members, { group: g }));
      }
    }
    const surfaces = opts.surfaceIds?.length
      ? opts.surfaceIds
      : t.venue_id ? (this.ctx.db.prepare('SELECT id FROM surfaces WHERE venue_id = ? ORDER BY sort, name').all(t.venue_id) as any[]).map((s) => s.id) : [];
    const plan = surfaces.length ? schedule(fixtures, surfaces, opts.startAt ?? new Date(Date.now() + 3600e3).toISOString(), opts.slotMinutes ?? 30) : [];
    const byKey = new Map(plan.map((p) => [p.key, p]));
    const partOf = (eid: string | null) => (eid ? ents.find((e) => e.id === eid)!.participant : TBD);
    const created: MatchRow[] = [];
    for (const f of fixtures) {
      if (f.round === 1 && t.format === 'knockout' && (!f.home || !f.away)) continue; // byes
      const slot = byKey.get(f.key);
      created.push(
        this.matches.create(user, {
          sport: t.sport, discipline: t.discipline, config: cfg.matchConfig ?? {}, participants: [partOf(f.home), partOf(f.away)],
          tournamentId: tid, fixtureKey: f.key, round: f.round, label: f.label ?? (f.group ? `Group ${f.group} · Round ${f.round}` : `Round ${f.round}`),
          group: f.group, winnerTo: f.winnerTo, surfaceId: slot?.surfaceId, scheduledAt: slot?.start, venueId: t.venue_id ?? undefined,
        }),
      );
    }
    this.ctx.db.prepare("UPDATE tournaments SET status = 'scheduled' WHERE id = ?").run(tid);
    this.ctx.audit(user.orgId, user.id, 'tournament.generate', 'tournament', tid, { matches: created.length });
    return created;
  }

  standings(tid: string) {
    const t = this.ctx.db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tid) as any;
    const ents = this.entrants(tid);
    const done = this.ctx.db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND status = 'completed'").all(tid) as any as MatchRow[];
    const name = (eid: string) => ents.find((e) => e.id === eid)?.participant.name ?? eid;
    const groupsOf = [...new Set(ents.map((e) => e.grp ?? ''))];
    const tables = groupsOf.map((g) => {
      const members = ents.filter((e) => (e.grp ?? '') === g).map((e) => e.id);
      const results = done
        .filter((m) => (m.grp ?? '') === g || !g)
        .map((m) => {
          const [h, a] = P<string[]>(m.entrant_ids);
          const sc = P(m.score, {} as any);
          return { home: h, away: a, winner: m.winner as 0 | 1 | null, primary: sc.primary ?? [0, 0], extra: sc.extra };
        })
        .filter((r) => members.includes(r.home) && members.includes(r.away));
      return { group: g || null, rows: standings(t.sport, members, results).map((r) => ({ ...r, name: name(r.entrant) })) };
    });
    return { sport: t.sport, format: t.format, tables };
  }

  publicView(t: any) {
    const matches = (this.ctx.db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, COALESCE(scheduled_at, created_at)').all(t.id) as any[]) as MatchRow[];
    return {
      code: t.public_code, name: t.name, sport: t.sport, discipline: t.discipline, format: t.format, status: t.status,
      standings: t.format === 'knockout' ? null : this.standings(t.id),
      matches: matches.filter((m) => m.visibility === 'public').map((m) => this.matches.publicView(m)),
    };
  }

  broadcast(tid: string) {
    const t = this.ctx.db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tid) as any;
    if (t) this.ctx.hub.publish(`tournament:${t.public_code}`, { t: 'tournament', tournament: this.publicView(t) });
  }

  private onMatchCompleted(row: MatchRow, agg: MatchAggregate) {
    // Player statistics rollup (match → tournament/season/career queries aggregate this table).
    const stats = agg.statistics();
    const ins = this.ctx.db.prepare('INSERT OR REPLACE INTO player_match_stats (match_id, player_id, org_id, sport, side, won, stats) VALUES (?,?,?,?,?,?,?)');
    const winner = agg.winner();
    for (const p of stats.players) ins.run(row.id, p.playerId, row.org_id, row.sport, p.side, winner == null ? null : winner === p.side ? 1 : 0, J(p.stats));
    // Also record participation for every rostered player, so win/loss and Elo work for racket sports.
    for (const side of [0, 1] as const)
      for (const pl of agg.match.participants[side].players ?? [])
        this.ctx.db.prepare('INSERT OR IGNORE INTO player_match_stats (match_id, player_id, org_id, sport, side, won, stats) VALUES (?,?,?,?,?,?,?)').run(row.id, pl.id, row.org_id, row.sport, side, winner == null ? null : winner === side ? 1 : 0, '{}');
    this.updateRatings(row, agg);
    if (!row.tournament_id) return;
    // Knockout progression: winner fills the next fixture's slot.
    const to = P<{ key: string; slot: 'home' | 'away' } | null>(row.winner_to, null);
    if (to && winner != null) {
      const next = this.ctx.db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND fixture_key = ?').get(row.tournament_id, to.key) as any as MatchRow;
      if (next && next.status === 'scheduled') {
        const parts = P<Participant[]>(next.participants);
        parts[to.slot === 'home' ? 0 : 1] = agg.match.participants[winner];
        this.matches.setParticipants(next.id, parts);
      }
    }
    const remaining = this.ctx.db.prepare("SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ? AND status NOT IN ('completed','abandoned')").get(row.tournament_id) as any;
    this.ctx.db.prepare('UPDATE tournaments SET status = ? WHERE id = ?').run(remaining.n === 0 ? 'completed' : 'live', row.tournament_id);
    this.broadcast(row.tournament_id);
  }

  /** Elo per sport for every rostered player (team sports use team average opponent rating). */
  private updateRatings(row: MatchRow, agg: MatchAggregate) {
    const w = agg.winner();
    const sides = agg.match.participants.map((p) => (p.players ?? []).map((pl) => pl.id));
    if (!sides[0].length || !sides[1].length) return;
    const get = this.ctx.db.prepare('SELECT rating FROM players WHERE id = ?');
    const set = this.ctx.db.prepare('UPDATE players SET rating = ? WHERE id = ?');
    const rating = (pid: string) => P(((get.get(pid) as any) ?? {}).rating, {} as any)[row.sport] ?? 1500;
    const avg = (ids: string[]) => ids.reduce((a, b) => a + rating(b), 0) / ids.length;
    const ra = avg(sides[0]);
    const rb = avg(sides[1]);
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    const sa = w == null ? 0.5 : w === 0 ? 1 : 0;
    const K = 24;
    const delta = [K * (sa - ea), K * (1 - sa - (1 - ea))];
    sides.forEach((ids, i) =>
      ids.forEach((pid) => {
        const cur = (get.get(pid) as any)?.rating;
        if (cur === undefined) return;
        const r = P(cur, {} as any);
        r[row.sport] = Math.round((r[row.sport] ?? 1500) + delta[i]);
        set.run(J(r), pid);
      }),
    );
  }
}
