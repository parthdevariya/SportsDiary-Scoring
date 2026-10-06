/**
 * Pickleball: traditional side-out scoring (only the serving side scores, doubles
 * server numbers 1/2, the "first server exception" at the start of each game) and
 * rally scoring, configurable per discipline.
 */
import type { ScorerAction, Side, SportRuleEngine } from '../core/types.ts';
import { other } from '../core/types.ts';
import { clone, fail, isSide, ok, shortName } from '../core/util.ts';

export interface PickleballConfig {
  bestOf: number;
  pointsToWin: number;
  winBy: number;
  scoring: 'side-out' | 'rally';
  doubles: boolean;
  timeoutsPerGame: number;
  /** Rally scoring: freeze at game point unless serving (MLP-style). Off by default. */
  rallyFreezeAtGamePoint: boolean;
}

export interface PickleballState {
  games: { p: [number, number]; winner?: Side; firstServer: Side }[];
  gamesWon: [number, number];
  serving: Side;
  serverNumber: 1 | 2;
  timeouts: [number, number];
  rallies: [number, number];
  sideOuts: [number, number];
  winner: Side | null;
}

const toWin = (c: PickleballConfig) => Math.floor(c.bestOf / 2) + 1;

function gameWinner(p: [number, number], c: PickleballConfig): Side | null {
  for (const s of [0, 1] as Side[]) if (p[s] >= c.pointsToWin && p[s] - p[other(s)] >= c.winBy) return s;
  return null;
}

function newGame(s: PickleballState, first: Side, c: PickleballConfig) {
  s.games.push({ p: [0, 0], firstServer: first });
  s.serving = first;
  // First-server exception: the first serving team of a doubles game starts on server #2.
  s.serverNumber = c.doubles ? 2 : 1;
  s.timeouts = [0, 0];
}

export const pickleball: SportRuleEngine<PickleballState> = {
  id: 'pickleball',
  name: 'Pickleball',
  family: 'rally',
  disciplines: [
    { id: 'doubles', name: 'Doubles — side-out, to 11', sideSize: 2, defaults: { bestOf: 3, pointsToWin: 11, winBy: 2, scoring: 'side-out', doubles: true, timeoutsPerGame: 2, rallyFreezeAtGamePoint: false } },
    { id: 'singles', name: 'Singles — side-out, to 11', sideSize: 1, defaults: { bestOf: 3, pointsToWin: 11, winBy: 2, scoring: 'side-out', doubles: false, timeoutsPerGame: 2, rallyFreezeAtGamePoint: false } },
    { id: 'doubles-rally', name: 'Doubles — rally scoring, to 21', sideSize: 2, defaults: { bestOf: 1, pointsToWin: 21, winBy: 2, scoring: 'rally', doubles: true, timeoutsPerGame: 2, rallyFreezeAtGamePoint: false } },
    { id: 'tournament-15', name: 'Doubles — single game to 15', sideSize: 2, defaults: { bestOf: 1, pointsToWin: 15, winBy: 2, scoring: 'side-out', doubles: true, timeoutsPerGame: 2, rallyFreezeAtGamePoint: false } },
  ],
  standings: { win: 2, draw: 0, loss: 0, tieBreakers: ['wins', 'setsRatio', 'pointsDiff', 'headToHead'], forLabel: 'Games' },
  eventTypes: ['RALLY', 'SET_SERVER', 'TIMEOUT'],

  initializeMatch(ctx) {
    const c = ctx.config as PickleballConfig;
    const s: PickleballState = { games: [], gamesWon: [0, 0], serving: 0, serverNumber: 1, timeouts: [0, 0], rallies: [0, 0], sideOuts: [0, 0], winner: null };
    newGame(s, isSide(ctx.config.firstServer) ? ctx.config.firstServer : 0, c);
    return s;
  },

  validateEvent(s, e, ctx) {
    const c = ctx.config as PickleballConfig;
    if (s.winner != null) return fail('Match is complete');
    const side = e.payload?.side;
    if (!isSide(side)) return fail('side required (winner of the rally / team)');
    if (e.type === 'SET_SERVER') {
      const g = s.games[s.games.length - 1];
      return g.p[0] + g.p[1] === 0 && s.rallies[0] + s.rallies[1] === 0 ? ok : fail('Server can only be chosen before the first rally of the match');
    }
    if (e.type === 'TIMEOUT') return s.timeouts[side] < c.timeoutsPerGame ? ok : fail('No timeouts left this game');
    return ok;
  },

  applyEvent(prev, e, ctx) {
    const c = ctx.config as PickleballConfig;
    const s = clone(prev);
    const side: Side = e.payload.side;
    const g = s.games[s.games.length - 1];
    if (e.type === 'SET_SERVER') {
      g.firstServer = side;
      s.serving = side;
      return s;
    }
    if (e.type === 'TIMEOUT') {
      s.timeouts[side]++;
      return s;
    }
    // RALLY won by `side`
    s.rallies[side]++;
    if (c.scoring === 'rally') {
      const gp = g.p[side] + 1 >= c.pointsToWin && g.p[side] + 1 - g.p[other(side)] >= c.winBy;
      if (!(c.rallyFreezeAtGamePoint && gp && s.serving !== side)) g.p[side]++;
      if (s.serving !== side) s.sideOuts[s.serving]++;
      s.serving = side;
    } else if (side === s.serving) {
      g.p[side]++;
    } else if (c.doubles && s.serverNumber === 1) {
      s.serverNumber = 2;
    } else {
      s.sideOuts[s.serving]++;
      s.serving = other(s.serving);
      s.serverNumber = 1;
    }
    const w = gameWinner(g.p, c);
    if (w != null) {
      g.winner = w;
      s.gamesWon[w]++;
      if (s.gamesWon[w] >= toWin(c)) s.winner = w;
      else newGame(s, other(g.firstServer), c);
    }
    return s;
  },

  calculateScore(s) {
    const pf: [number, number] = [0, 0];
    s.games.forEach((g) => {
      pf[0] += g.p[0];
      pf[1] += g.p[1];
    });
    return { text: [String(s.gamesWon[0]), String(s.gamesWon[1])], primary: [...s.gamesWon] as [number, number], extra: { setScores: s.games.filter((g) => g.winner != null).map((g) => g.p.join('-')).join(', '), pointsFor: pf, unit: 'games' } };
  },

  calculateStatistics(s) {
    const pts: [number, number] = [0, 0];
    s.games.forEach((g) => {
      pts[0] += g.p[0];
      pts[1] += g.p[1];
    });
    return {
      team: [
        { key: 'points', label: 'Points', values: pts },
        { key: 'rallies', label: 'Rallies won', values: [...s.rallies] as [number, number] },
        { key: 'sideOuts', label: 'Side-outs conceded', values: [...s.sideOuts] as [number, number] },
      ],
      players: [],
    };
  },

  determineWinner: (s) => s.winner,
  isMatchComplete: (s) => s.winner != null,
  getCurrentState: (s) => s,

  getDisplayState(s, ctx) {
    const c = ctx.config as PickleballConfig;
    const g = s.games[s.games.length - 1];
    const done = s.winner != null;
    // Traditional call: serving score – receiving score – server number
    const call = c.scoring === 'side-out' && !done
      ? `${g.p[s.serving]}–${g.p[other(s.serving)]}${c.doubles ? `–${s.serverNumber}` : ''}`
      : undefined;
    let headline: string | undefined = call ? `CALL ${call}` : undefined;
    if (!done) {
      for (const side of [0, 1] as Side[]) {
        const canScore = c.scoring === 'rally' || side === s.serving;
        if (canScore && g.p[side] + 1 >= c.pointsToWin && g.p[side] + 1 - g.p[other(side)] >= c.winBy) {
          headline = `${s.gamesWon[side] + 1 >= toWin(c) ? 'MATCH' : 'GAME'} POINT · ${shortName(ctx, side)}${call ? ` · ${call}` : ''}`;
        }
      }
    }
    return {
      phase: done ? 'FINAL' : `GAME ${s.games.length}`,
      sides: ([0, 1] as Side[]).map((i) => ({
        name: ctx.match.participants[i].name,
        score: String(done ? s.gamesWon[i] : g.p[i]),
        serving: !done && s.serving === i,
        badges: [`GAMES ${s.gamesWon[i]}`, ...(!done && s.serving === i && c.doubles && c.scoring === 'side-out' ? [`SERVER ${s.serverNumber}`] : [])],
      })) as any,
      periods: { labels: s.games.map((_, i) => `${i + 1}`), rows: [s.games.map((x) => String(x.p[0])), s.games.map((x) => String(x.p[1]))] },
      headline,
      winner: s.winner,
      resultText: done ? `${ctx.match.participants[s.winner!].name} won ${s.games.map((x) => `${x.p[s.winner!]}-${x.p[other(s.winner!)]}`).join(', ')}` : undefined,
    };
  },

  getActions(s, ctx) {
    const acts: ScorerAction[] = ([0, 1] as Side[]).map((side) => ({
      id: `rally-${side}`, label: `Rally ${shortName(ctx, side)}`, type: 'RALLY', payload: { side }, side, group: 'primary' as const, tone: 'positive' as const,
    }));
    for (const side of [0, 1] as Side[]) acts.push({ id: `to-${side}`, label: `Timeout ${shortName(ctx, side)}`, type: 'TIMEOUT', payload: { side }, side, group: 'secondary' });
    if (s.rallies[0] + s.rallies[1] === 0)
      acts.push({ id: 'server', label: `${shortName(ctx, other(s.serving))} serves first`, type: 'SET_SERVER', payload: { side: other(s.serving) }, group: 'setup' });
    return acts;
  },

  describeEvent(e, before, ctx) {
    const n = (i: Side) => ctx.match.participants[i].name;
    if (e.type === 'TIMEOUT') return `Timeout ${n(e.payload.side)}`;
    if (e.type === 'SET_SERVER') return `${n(e.payload.side)} to serve`;
    const after = pickleball.applyEvent(before, e, ctx);
    if (after.winner != null) return `${n(e.payload.side)} win the match`;
    if (after.games.length > before.games.length) return `Game ${before.games.length} to ${n(e.payload.side)}`;
    const ga = after.games[after.games.length - 1].p;
    const gb = before.games[before.games.length - 1].p;
    if (ga[0] !== gb[0] || ga[1] !== gb[1]) return `Point ${n(e.payload.side)} · ${ga[0]}–${ga[1]}`;
    return after.serving !== before.serving ? `Side out — ${n(after.serving)} to serve` : `Second server ${n(after.serving)}`;
  },
};
