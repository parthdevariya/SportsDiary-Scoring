/**
 * Rally-scoring set sports: Badminton, Table Tennis, Volleyball (indoor + beach).
 * One configurable engine, three registered sports. Rules are pure config:
 *   bestOf, pointsToWin, winBy, cap, decidingPoints, serve rule, rotation, timeouts.
 */
import type { EngineContext, MatchEvent, ScorerAction, Side, SportRuleEngine, StandingsRules } from '../core/types.ts';
import { other } from '../core/types.ts';
import { bump, clone, fail, isSide, ok, pair, pct, playerName, playerOptions, shortName } from '../core/util.ts';

export interface RallyConfig {
  bestOf: number;
  pointsToWin: number;
  winBy: number;
  cap: number | null;
  decidingPoints: number | null;
  /** 'rally-winner': whoever wins the rally serves. 'alternate': fixed rotation (table tennis). */
  serve: 'rally-winner' | 'alternate';
  serveEvery: number;
  /** In deuce, serve changes every N points (table tennis: 1). */
  deuceServeEvery: number;
  newSetServer: 'previous-winner' | 'alternate';
  rotationSize: number; // 0 = no rotation tracking
  timeoutsPerSet: number;
  timeoutsPerMatch: number;
  periodName: string; // 'GAME' | 'SET'
  advancedStats: boolean;
}

export interface RallyState {
  sets: { p: [number, number]; winner?: Side; firstServer: Side }[];
  setsWon: [number, number];
  server: Side;
  rotation: [number, number];
  timeouts: [number, number]; // in current set
  matchTimeouts: [number, number];
  subs: [number, number];
  stats: Record<string, [number, number]>;
  player: Record<string, Record<string, number>>;
  serves: [number, number];
  streak: { side: Side | null; n: number; best: [number, number] };
  winner: Side | null;
}

const setsToWin = (c: RallyConfig) => Math.floor(c.bestOf / 2) + 1;

function target(s: RallyState, c: RallyConfig): number {
  const need = setsToWin(c) - 1;
  const deciding = s.setsWon[0] === need && s.setsWon[1] === need;
  return deciding && c.decidingPoints ? c.decidingPoints : c.pointsToWin;
}

function setWonBy(p: [number, number], tgt: number, c: RallyConfig): Side | null {
  for (const s of [0, 1] as Side[]) {
    const a = p[s];
    const b = p[other(s)];
    if (c.cap && a >= c.cap && a > b) return s;
    if (a >= tgt && a - b >= c.winBy) return s;
  }
  return null;
}

function alternateServer(first: Side, p: [number, number], tgt: number, c: RallyConfig): Side {
  const total = p[0] + p[1];
  const deuceStart = 2 * (tgt - 1);
  const switches =
    total < deuceStart
      ? Math.floor(total / c.serveEvery)
      : Math.floor(deuceStart / c.serveEvery) + Math.floor((total - deuceStart) / c.deuceServeEvery);
  return switches % 2 === 0 ? first : other(first);
}

/** Would `side` win the set (and maybe the match) with the next point? */
function situation(s: RallyState, c: RallyConfig): { side: Side; kind: 'set' | 'match' } | null {
  if (s.winner != null) return null;
  const cur = s.sets[s.sets.length - 1];
  const tgt = target(s, c);
  for (const side of [0, 1] as Side[]) {
    const p: [number, number] = [...cur.p];
    p[side]++;
    if (setWonBy(p, tgt, c) === side) return { side, kind: s.setsWon[side] + 1 >= setsToWin(c) ? 'match' : 'set' };
  }
  return null;
}

const ERROR_HOWS = ['serve_error', 'attack_error', 'error', 'reception_error', 'net_fault', 'fault'];

function makeRallySport(
  id: string,
  name: string,
  disciplines: SportRuleEngine['disciplines'],
  standings: StandingsRules,
  pointHows: { value: string; label: string }[],
): SportRuleEngine<RallyState> {
  const engine: SportRuleEngine<RallyState> = {
    id,
    name,
    family: 'rally',
    disciplines,
    standings,
    eventTypes: ['POINT', 'SET_SERVER', 'TIMEOUT', 'SUBSTITUTION', 'STAT'],

    initializeMatch(ctx) {
      const first: Side = isSide(ctx.config.firstServer) ? ctx.config.firstServer : 0;
      return {
        sets: [{ p: [0, 0], firstServer: first }],
        setsWon: [0, 0],
        server: first,
        rotation: [0, 0],
        timeouts: [0, 0],
        matchTimeouts: [0, 0],
        subs: [0, 0],
        stats: {},
        player: {},
        serves: [0, 0],
        streak: { side: null, n: 0, best: [0, 0] },
        winner: null,
      };
    },

    validateEvent(s, e, ctx) {
      const c = ctx.config as RallyConfig;
      const side = e.payload?.side;
      if (s.winner != null) return fail('Match is complete');
      switch (e.type) {
        case 'POINT':
          return isSide(side) ? ok : fail('POINT requires side 0 or 1');
        case 'SET_SERVER': {
          const cur = s.sets[s.sets.length - 1];
          if (!isSide(side)) return fail('side required');
          return cur.p[0] + cur.p[1] === 0 ? ok : fail(`Server can only be chosen before the first point of the ${c.periodName.toLowerCase()}`);
        }
        case 'TIMEOUT':
          if (!isSide(side)) return fail('side required');
          if (c.timeoutsPerSet && s.timeouts[side] >= c.timeoutsPerSet) return fail(`No timeouts left this ${c.periodName.toLowerCase()}`);
          if (c.timeoutsPerMatch && s.matchTimeouts[side] >= c.timeoutsPerMatch) return fail('No timeouts left this match');
          if (!c.timeoutsPerSet && !c.timeoutsPerMatch) return fail('Timeouts are not enabled for this format');
          return ok;
        case 'SUBSTITUTION':
          return isSide(side) ? ok : fail('side required');
        case 'STAT':
          return isSide(side) && typeof e.payload?.stat === 'string' ? ok : fail('STAT requires side and stat');
      }
      return fail('Unsupported event');
    },

    applyEvent(prev, e, ctx) {
      const c = ctx.config as RallyConfig;
      const s = clone(prev);
      const side: Side = e.payload?.side;
      const cur = s.sets[s.sets.length - 1];
      switch (e.type) {
        case 'SET_SERVER':
          cur.firstServer = side;
          s.server = side;
          break;
        case 'TIMEOUT':
          s.timeouts[side]++;
          s.matchTimeouts[side]++;
          break;
        case 'SUBSTITUTION':
          s.subs[side]++;
          break;
        case 'STAT': {
          const st = (s.stats[e.payload.stat] ??= [0, 0]);
          st[side]++;
          if (e.payload.player) bump((s.player[e.payload.player] ??= {}), e.payload.stat);
          break;
        }
        case 'POINT': {
          const how: string | undefined = e.payload.how;
          s.serves[s.server]++;
          if (how) {
            const isErr = ERROR_HOWS.includes(how);
            const credited: Side = isErr ? other(side) : side;
            (s.stats[how] ??= [0, 0])[credited]++;
            if (e.payload.player) bump((s.player[e.payload.player] ??= {}), how);
          }
          // streaks
          if (s.streak.side === side) s.streak.n++;
          else s.streak = { ...s.streak, side, n: 1 };
          s.streak.best[side] = Math.max(s.streak.best[side], s.streak.n);
          // rotation (volleyball): side-out => receiving team rotates
          const wasServing = s.server === side;
          cur.p[side]++;
          if (c.rotationSize && !wasServing) s.rotation[side] = (s.rotation[side] + 1) % c.rotationSize;
          const tgt = target(s, c);
          const won = setWonBy(cur.p, tgt, c);
          if (won != null) {
            cur.winner = won;
            s.setsWon[won]++;
            if (s.setsWon[won] >= setsToWin(c)) {
              s.winner = won;
              break;
            }
            const nextFirst: Side = c.newSetServer === 'previous-winner' ? won : other(cur.firstServer);
            s.sets.push({ p: [0, 0], firstServer: nextFirst });
            s.server = nextFirst;
            s.timeouts = [0, 0];
            break;
          }
          s.server = c.serve === 'rally-winner' ? side : alternateServer(cur.firstServer, cur.p, tgt, c);
          break;
        }
      }
      return s;
    },

    calculateScore(s, ctx) {
      const c = ctx.config as RallyConfig;
      const done = s.sets.filter((x) => x.winner != null);
      const pf: [number, number] = [0, 0];
      for (const st of s.sets) {
        pf[0] += st.p[0];
        pf[1] += st.p[1];
      }
      return {
        text: [String(s.setsWon[0]), String(s.setsWon[1])],
        primary: [...s.setsWon] as [number, number],
        extra: {
          setScores: done.map((x) => x.p.join('-')).join(', '),
          pointsFor: pf,
          unit: c.periodName.toLowerCase() + 's',
        },
      };
    },

    calculateStatistics(s, _events, ctx) {
      const c = ctx.config as RallyConfig;
      const team: { key: string; label: string; values: [number | string, number | string] }[] = [];
      const pts: [number, number] = [0, 0];
      s.sets.forEach((x) => {
        pts[0] += x.p[0];
        pts[1] += x.p[1];
      });
      team.push({ key: 'points', label: 'Total points', values: pts });
      team.push({ key: 'bestStreak', label: 'Longest run', values: [...s.streak.best] as [number, number] });
      const labels: Record<string, string> = {
        ace: 'Aces', kill: 'Kills', block: 'Blocks', serve_error: 'Service errors', attack_error: 'Attack errors',
        error: 'Errors', winner: 'Winners', smash: 'Smash winners', dig: 'Digs', attack_attempt: 'Attack attempts',
        reception_error: 'Reception errors', net_fault: 'Net faults', fault: 'Faults',
      };
      for (const [k, v] of Object.entries(s.stats)) team.push({ key: k, label: labels[k] ?? k, values: [...v] as [number, number] });
      if (c.rotationSize) {
        const se = s.stats.serve_error ?? [0, 0];
        team.push({ key: 'servePct', label: 'Serve %', values: [pct(s.serves[0] - se[0], s.serves[0]), pct(s.serves[1] - se[1], s.serves[1])] });
        const att = s.stats.attack_attempt;
        if (att) {
          const k = s.stats.kill ?? [0, 0];
          const ae = s.stats.attack_error ?? [0, 0];
          const ap = (i: Side) => (att[i] ? ((k[i] - ae[i]) / att[i]).toFixed(3) : '–');
          team.push({ key: 'attackPct', label: 'Attack efficiency', values: [ap(0), ap(1)] });
        }
      }
      if (c.timeoutsPerSet || c.timeoutsPerMatch) team.push({ key: 'timeouts', label: 'Timeouts', values: [...s.matchTimeouts] as [number, number] });
      const players = Object.entries(s.player).map(([pid, st]) => {
        const sideOf = ctx.match.participants[0].players?.some((p) => p.id === pid) ? 0 : 1;
        return { playerId: pid, name: playerName(ctx, pid), side: sideOf as Side, stats: st };
      });
      return { team, players };
    },

    determineWinner: (s) => s.winner,
    isMatchComplete: (s) => s.winner != null,
    getCurrentState: (s) => s,

    getDisplayState(s, ctx) {
      const c = ctx.config as RallyConfig;
      const cur = s.sets[s.sets.length - 1];
      const sit = situation(s, c);
      const dueceLine = (() => {
        const tgt = target(s, c);
        return cur.p[0] >= tgt - 1 && cur.p[1] >= tgt - 1 && cur.p[0] === cur.p[1] ? 'DEUCE' : undefined;
      })();
      const headline = s.winner != null ? undefined : sit ? `${sit.kind === 'match' ? 'MATCH' : c.periodName} POINT · ${shortName(ctx, sit.side)}` : dueceLine;
      const finished = s.winner != null;
      return {
        phase: finished ? 'FINAL' : `${c.periodName} ${s.sets.length}`,
        sides: [0, 1].map((i) => ({
          name: ctx.match.participants[i].name,
          score: String(finished ? s.setsWon[i] : cur.p[i]),
          serving: !finished && s.server === i,
          badges: [`${c.periodName}S ${s.setsWon[i]}`],
          detail: c.rotationSize ? [`Rotation ${s.rotation[i] + 1}`] : undefined,
        })) as any,
        periods: {
          labels: s.sets.map((_, i) => `${i + 1}`),
          rows: [s.sets.map((x) => String(x.p[0])), s.sets.map((x) => String(x.p[1]))],
        },
        headline,
        winner: s.winner,
        resultText: finished
          ? `${ctx.match.participants[s.winner!].name} won ${s.setsWon[s.winner!]}–${s.setsWon[other(s.winner!)]} (${s.sets.map((x) => x.p.join('-')).join(', ')})`
          : undefined,
      };
    },

    getActions(s, ctx) {
      const c = ctx.config as RallyConfig;
      const cur = s.sets[s.sets.length - 1];
      const acts: ScorerAction[] = [];
      for (const side of [0, 1] as Side[]) {
        acts.push({
          id: `point-${side}`,
          label: `Point ${shortName(ctx, side)}`,
          type: 'POINT',
          payload: { side },
          side,
          group: 'primary',
          tone: 'positive',
          inputs: pointHows.length
            ? [
                { key: 'how', label: 'How', kind: 'select', options: pointHows, optional: true },
                ...(c.advancedStats ? [{ key: 'player', label: 'Player', kind: 'player' as const, side, optional: true, options: playerOptions(ctx, side) }] : []),
              ]
            : undefined,
        });
      }
      if (cur.p[0] + cur.p[1] === 0) {
        for (const side of [0, 1] as Side[])
          if (s.server !== side) acts.push({ id: `server-${side}`, label: `${shortName(ctx, side)} serves`, type: 'SET_SERVER', payload: { side }, side, group: 'setup' });
      }
      if (c.timeoutsPerSet || c.timeoutsPerMatch)
        for (const side of [0, 1] as Side[]) acts.push({ id: `to-${side}`, label: `Timeout ${shortName(ctx, side)}`, type: 'TIMEOUT', payload: { side }, side, group: 'secondary' });
      if (c.rotationSize)
        for (const side of [0, 1] as Side[]) {
          acts.push({ id: `sub-${side}`, label: `Sub ${shortName(ctx, side)}`, type: 'SUBSTITUTION', payload: { side }, side, group: 'secondary',
            inputs: [
              { key: 'playerIn', label: 'In', kind: 'player', side, options: playerOptions(ctx, side), optional: true },
              { key: 'playerOut', label: 'Out', kind: 'player', side, options: playerOptions(ctx, side), optional: true },
            ] });
          for (const st of ['dig', 'attack_attempt'])
            acts.push({ id: `stat-${st}-${side}`, label: `${st === 'dig' ? 'Dig' : 'Attack att.'} ${shortName(ctx, side)}`, type: 'STAT', payload: { side, stat: st }, side, group: 'stat' });
        }
      return acts;
    },

    describeEvent(e, before, ctx) {
      const c = ctx.config as RallyConfig;
      const n = (side: Side) => ctx.match.participants[side].name;
      switch (e.type) {
        case 'POINT': {
          const after = engine.applyEvent(before, e, ctx);
          const how = e.payload.how ? ` (${String(e.payload.how).replace('_', ' ')})` : '';
          const prevSet = before.sets.length;
          if (after.winner != null) return `${n(e.payload.side)} win the match${how}`;
          if (after.sets.length > prevSet) {
            const fin = after.sets[prevSet - 1];
            return `${c.periodName[0]}${c.periodName.slice(1).toLowerCase()} ${prevSet} to ${n(e.payload.side)}, ${fin.p[e.payload.side]}–${fin.p[other(e.payload.side)]}${how}`;
          }
          const p = after.sets[after.sets.length - 1].p;
          return `Point ${n(e.payload.side)}${how} · ${p[0]}–${p[1]}`;
        }
        case 'TIMEOUT':
          return `Timeout ${n(e.payload.side)}`;
        case 'SUBSTITUTION':
          return `Substitution ${n(e.payload.side)}${e.payload.playerIn ? `: ${playerName(ctx, e.payload.playerIn)} on` : ''}`;
        case 'SET_SERVER':
          return `${n(e.payload.side)} to serve`;
      }
      return null;
    },
  };
  return engine;
}

const setStandings: StandingsRules = { win: 2, draw: 0, loss: 0, tieBreakers: ['wins', 'setsRatio', 'pointsDiff', 'headToHead'], forLabel: 'Sets' };

const badmintonBase: Partial<RallyConfig> = {
  bestOf: 3, pointsToWin: 21, winBy: 2, cap: 30, decidingPoints: null, serve: 'rally-winner', serveEvery: 1, deuceServeEvery: 1,
  newSetServer: 'previous-winner', rotationSize: 0, timeoutsPerSet: 0, timeoutsPerMatch: 0, periodName: 'GAME', advancedStats: false,
};

export const badminton = makeRallySport(
  'badminton',
  'Badminton',
  [
    { id: 'singles', name: 'Singles', sideSize: 1, defaults: { ...badmintonBase } },
    { id: 'doubles', name: 'Doubles', sideSize: 2, defaults: { ...badmintonBase } },
    { id: 'mixed-doubles', name: 'Mixed doubles', sideSize: 2, defaults: { ...badmintonBase } },
    { id: 'short-15', name: 'Short format (15 pts)', sideSize: 1, defaults: { ...badmintonBase, pointsToWin: 15, cap: 21 } },
  ],
  setStandings,
  [
    { value: 'smash', label: 'Smash' }, { value: 'winner', label: 'Winner' }, { value: 'error', label: 'Opponent error' }, { value: 'fault', label: 'Opponent fault' },
  ],
);

const ttBase: Partial<RallyConfig> = {
  bestOf: 5, pointsToWin: 11, winBy: 2, cap: null, decidingPoints: null, serve: 'alternate', serveEvery: 2, deuceServeEvery: 1,
  newSetServer: 'alternate', rotationSize: 0, timeoutsPerSet: 0, timeoutsPerMatch: 1, periodName: 'GAME', advancedStats: false,
};

export const tableTennis = makeRallySport(
  'table-tennis',
  'Table Tennis',
  [
    { id: 'singles', name: 'Singles', sideSize: 1, defaults: { ...ttBase } },
    { id: 'doubles', name: 'Doubles', sideSize: 2, defaults: { ...ttBase } },
    { id: 'best-of-3', name: 'Singles — best of 3', sideSize: 1, defaults: { ...ttBase, bestOf: 3 } },
    { id: 'best-of-7', name: 'Singles — best of 7', sideSize: 1, defaults: { ...ttBase, bestOf: 7 } },
  ],
  setStandings,
  [
    { value: 'ace', label: 'Service ace' }, { value: 'winner', label: 'Winner' }, { value: 'error', label: 'Opponent error' }, { value: 'serve_error', label: 'Service fault' },
  ],
);

const vbBase: Partial<RallyConfig> = {
  bestOf: 5, pointsToWin: 25, winBy: 2, cap: null, decidingPoints: 15, serve: 'rally-winner', serveEvery: 1, deuceServeEvery: 1,
  newSetServer: 'alternate', rotationSize: 6, timeoutsPerSet: 2, timeoutsPerMatch: 0, periodName: 'SET', advancedStats: true,
};

export const volleyball = makeRallySport(
  'volleyball',
  'Volleyball',
  [
    { id: 'indoor', name: 'Indoor (6v6)', sideSize: 6, defaults: { ...vbBase } },
    { id: 'indoor-best-of-3', name: 'Indoor — best of 3', sideSize: 6, defaults: { ...vbBase, bestOf: 3 } },
    { id: 'beach', name: 'Beach (2v2)', sideSize: 2, defaults: { ...vbBase, bestOf: 3, pointsToWin: 21, decidingPoints: 15, rotationSize: 2, timeoutsPerSet: 1 } },
  ],
  setStandings,
  [
    { value: 'kill', label: 'Kill' }, { value: 'ace', label: 'Ace' }, { value: 'block', label: 'Block' },
    { value: 'attack_error', label: 'Opp. attack error' }, { value: 'serve_error', label: 'Opp. service error' }, { value: 'error', label: 'Opp. other error' },
  ],
);
