/**
 * MATCH → SET → GAME → POINT engine, shared by Tennis and Padel.
 * Handles advantage, deciding point (no-ad / golden point / "decide after N deuces"),
 * tie-breaks, final-set super tie-break, service rotation incl. tie-break serving order,
 * break points, set/match point detection and serve statistics.
 */
import type { EngineContext, ScorerAction, Side, SportRuleEngine, StandingsRules } from '../core/types.ts';
import { other } from '../core/types.ts';
import { clone, fail, isSide, ok, pct, shortName } from '../core/util.ts';

export interface TennisConfig {
  bestOf: number;
  gamesPerSet: number;
  /** Games-all score at which a tie-break is played. null = advantage sets. */
  tiebreakAt: number | null;
  tiebreakPoints: number;
  finalSet: 'tiebreak' | 'advantage' | 'super-tiebreak';
  superTiebreakPoints: number;
  /** null = always advantage; 0 = deciding point at first deuce (no-ad / golden point); n = decide after n deuces. */
  decidingPointAfterDeuces: number | null;
  decidingPointName: string;
}

interface SetState {
  g: [number, number];
  tb?: [number, number];
  superTb?: boolean;
  winner?: Side;
}

export interface TennisState {
  sets: SetState[];
  setsWon: [number, number];
  game: [number, number];
  inTiebreak: boolean;
  tbFirstServer: Side | null;
  server: Side;
  started: boolean;
  winner: Side | null;
  st: {
    points: [number, number];
    aces: [number, number];
    doubleFaults: [number, number];
    winners: [number, number];
    unforced: [number, number];
    firstServeIn: [number, number];
    serveTracked: [number, number];
    firstServeWon: [number, number];
    secondServeWon: [number, number];
    secondServeTracked: [number, number];
    servicePoints: [number, number];
    servicePointsWon: [number, number];
    bpFaced: [number, number];
    bpSaved: [number, number];
    bpChances: [number, number];
    bpConverted: [number, number];
    serviceGames: [number, number];
    serviceGamesWon: [number, number];
  };
}

const PTS = ['0', '15', '30', '40'];
const setsToWin = (c: TennisConfig) => Math.floor(c.bestOf / 2) + 1;
const isDeciding = (s: TennisState, c: TennisConfig) => s.setsWon[0] === setsToWin(c) - 1 && s.setsWon[1] === setsToWin(c) - 1;

function tbTarget(set: SetState, c: TennisConfig) {
  return set.superTb ? c.superTiebreakPoints : c.tiebreakPoints;
}

/** Who wins the regular game if `side` wins the next point? */
function gameWonIfPoint(p: [number, number], side: Side, c: TennisConfig): boolean {
  const a = p[side] + 1;
  const b = p[other(side)];
  if (p[0] === p[1] && p[0] >= 3 && c.decidingPointAfterDeuces != null && p[0] - 2 > c.decidingPointAfterDeuces) return true;
  return a >= 4 && a - b >= 2;
}

function tbWonIfPoint(tb: [number, number], side: Side, tgt: number): boolean {
  const a = tb[side] + 1;
  return a >= tgt && a - tb[other(side)] >= 2;
}

function setWonIfGame(set: SetState, side: Side, s: TennisState, c: TennisConfig): boolean {
  const a = set.g[side] + 1;
  const b = set.g[other(side)];
  return a >= c.gamesPerSet && a - b >= 2;
}

function tiebreakApplies(s: TennisState, c: TennisConfig): boolean {
  if (c.tiebreakAt == null) return false;
  if (isDeciding(s, c) && c.finalSet === 'advantage') return false;
  return true;
}

/** Server for the n-th point (0-based) of a tie-break. */
function tbServer(first: Side, n: number): Side {
  return Math.floor((n + 1) / 2) % 2 === 0 ? first : other(first);
}

function startSet(s: TennisState, c: TennisConfig) {
  const superTb = isDeciding(s, c) && c.finalSet === 'super-tiebreak';
  s.sets.push(superTb ? { g: [0, 0], tb: [0, 0], superTb: true } : { g: [0, 0] });
  s.game = [0, 0];
  s.inTiebreak = superTb;
  s.tbFirstServer = superTb ? s.server : null;
}

/** Point situation BEFORE a point is played: what would `side` win with it? */
function stakes(s: TennisState, side: Side, c: TennisConfig): 'match' | 'set' | 'game' | null {
  if (s.winner != null) return null;
  const set = s.sets[s.sets.length - 1];
  let gameWon: boolean;
  let setWon = false;
  if (s.inTiebreak) {
    gameWon = tbWonIfPoint(set.tb!, side, tbTarget(set, c));
    setWon = gameWon;
  } else {
    gameWon = gameWonIfPoint(s.game, side, c);
    setWon = gameWon && setWonIfGame(set, side, s, c);
  }
  if (setWon) return s.setsWon[side] + 1 >= setsToWin(c) ? 'match' : 'set';
  return gameWon ? 'game' : null;
}

function makeRacketSport(id: string, name: string, disciplines: SportRuleEngine['disciplines'], standings: StandingsRules): SportRuleEngine<TennisState> {
  const z = (): [number, number] => [0, 0];
  const engine: SportRuleEngine<TennisState> = {
    id,
    name,
    family: 'racket',
    disciplines,
    standings,
    eventTypes: ['POINT', 'SET_SERVER'],

    initializeMatch(ctx) {
      const s: TennisState = {
        sets: [],
        setsWon: [0, 0],
        game: [0, 0],
        inTiebreak: false,
        tbFirstServer: null,
        server: isSide(ctx.config.firstServer) ? ctx.config.firstServer : 0,
        started: false,
        winner: null,
        st: {
          points: z(), aces: z(), doubleFaults: z(), winners: z(), unforced: z(), firstServeIn: z(), serveTracked: z(),
          firstServeWon: z(), secondServeWon: z(), secondServeTracked: z(), servicePoints: z(), servicePointsWon: z(),
          bpFaced: z(), bpSaved: z(), bpChances: z(), bpConverted: z(), serviceGames: z(), serviceGamesWon: z(),
        },
      };
      startSet(s, ctx.config as TennisConfig);
      return s;
    },

    validateEvent(s, e) {
      if (s.winner != null) return fail('Match is complete');
      const side = e.payload?.side;
      if (!isSide(side)) return fail('side required');
      if (e.type === 'SET_SERVER') return s.started ? fail('Server can only be set before the first point') : ok;
      if (e.type === 'POINT') {
        const how = e.payload.how;
        if (how === 'ace' && side !== s.server) return fail('An ace can only be won by the server');
        if (how === 'double_fault' && side === s.server) return fail('A double fault gives the point to the receiver');
        if (e.payload.serve != null && ![1, 2].includes(e.payload.serve)) return fail('serve must be 1 or 2');
        return ok;
      }
      return fail('Unsupported event');
    },

    applyEvent(prev, e, ctx) {
      const c = ctx.config as TennisConfig;
      const s = clone(prev);
      const side: Side = e.payload.side;
      if (e.type === 'SET_SERVER') {
        s.server = side;
        if (s.inTiebreak) s.tbFirstServer = side;
        return s;
      }
      s.started = true;
      const set = s.sets[s.sets.length - 1];
      const server = s.server;
      const receiver = other(server);
      const st = s.st;
      // --- stats ---
      st.points[side]++;
      st.servicePoints[server]++;
      if (side === server) st.servicePointsWon[server]++;
      const how = e.payload.how;
      if (how === 'ace') st.aces[server]++;
      if (how === 'double_fault') st.doubleFaults[server]++;
      if (how === 'winner') st.winners[side]++;
      if (how === 'unforced_error') st.unforced[other(side)]++;
      const serve = how === 'double_fault' ? 2 : e.payload.serve;
      if (serve === 1 || serve === 2) {
        st.serveTracked[server]++;
        if (serve === 1) {
          st.firstServeIn[server]++;
          if (side === server) st.firstServeWon[server]++;
        } else {
          st.secondServeTracked[server]++;
          if (side === server) st.secondServeWon[server]++;
        }
      }
      if (!s.inTiebreak) {
        const breakPoint = gameWonIfPoint(s.game, receiver, c);
        if (breakPoint) {
          st.bpFaced[server]++;
          st.bpChances[receiver]++;
          if (side === server) st.bpSaved[server]++;
          else st.bpConverted[receiver]++;
        }
      }
      // --- scoring ---
      if (s.inTiebreak) {
        const tb = set.tb!;
        const won = tbWonIfPoint(tb, side, tbTarget(set, c));
        tb[side]++;
        if (won) {
          if (!set.superTb) set.g[side]++;
          else set.g[side] = 1;
          set.winner = side;
          s.setsWon[side]++;
          s.inTiebreak = false;
          s.server = other(s.tbFirstServer!);
          if (s.setsWon[side] >= setsToWin(c)) {
            s.winner = side;
            return s;
          }
          startSet(s, c);
          return s;
        }
        s.server = tbServer(s.tbFirstServer!, tb[0] + tb[1]);
        return s;
      }
      const gameWon = gameWonIfPoint(s.game, side, c);
      s.game[side]++;
      if (!gameWon) return s;
      // game over
      st.serviceGames[server]++;
      if (side === server) st.serviceGamesWon[server]++;
      const setWon = setWonIfGame(set, side, s, c);
      set.g[side]++;
      s.game = [0, 0];
      s.server = other(server);
      if (setWon) {
        set.winner = side;
        s.setsWon[side]++;
        if (s.setsWon[side] >= setsToWin(c)) {
          s.winner = side;
          return s;
        }
        startSet(s, c);
        return s;
      }
      if (tiebreakApplies(s, c) && set.g[0] === c.tiebreakAt && set.g[1] === c.tiebreakAt) {
        s.inTiebreak = true;
        set.tb = [0, 0];
        s.tbFirstServer = s.server;
      }
      return s;
    },

    calculateScore(s) {
      const games: [number, number] = [0, 0];
      s.sets.forEach((x) => {
        games[0] += x.g[0];
        games[1] += x.g[1];
      });
      return {
        text: [String(s.setsWon[0]), String(s.setsWon[1])],
        primary: [...s.setsWon] as [number, number],
        extra: { setScores: setScoresText(s), pointsFor: games, unit: 'sets' },
      };
    },

    calculateStatistics(s) {
      const st = s.st;
      const line = (key: string, label: string, v: [number | string, number | string]) => ({ key, label, values: v });
      const both = (f: (i: Side) => string | number): [string | number, string | number] => [f(0), f(1)];
      return {
        team: [
          line('aces', 'Aces', [...st.aces] as any),
          line('doubleFaults', 'Double faults', [...st.doubleFaults] as any),
          line('firstServePct', '1st serve in', both((i) => pct(st.firstServeIn[i], st.serveTracked[i]))),
          line('firstServeWon', '1st serve pts won', both((i) => pct(st.firstServeWon[i], st.firstServeIn[i]))),
          line('secondServeWon', '2nd serve pts won', both((i) => pct(st.secondServeWon[i], st.secondServeTracked[i]))),
          line('breakPoints', 'Break points won', both((i) => `${st.bpConverted[i]}/${st.bpChances[i]}`)),
          line('bpSaved', 'Break points saved', both((i) => `${st.bpSaved[i]}/${st.bpFaced[i]}`)),
          line('serviceGames', 'Service games won', both((i) => `${st.serviceGamesWon[i]}/${st.serviceGames[i]}`)),
          line('breaks', 'Breaks of serve', both((i) => st.serviceGames[other(i)] - st.serviceGamesWon[other(i)])),
          line('winners', 'Winners', [...st.winners] as any),
          line('unforced', 'Unforced errors', [...st.unforced] as any),
          line('points', 'Total points won', [...st.points] as any),
        ],
        players: [],
      };
    },

    determineWinner: (s) => s.winner,
    isMatchComplete: (s) => s.winner != null,
    getCurrentState: (s) => s,

    getDisplayState(s, ctx) {
      const c = ctx.config as TennisConfig;
      const set = s.sets[s.sets.length - 1];
      const done = s.winner != null;
      const pointText = (i: Side): string => {
        if (done) return String(s.setsWon[i]);
        if (s.inTiebreak) return String(set.tb![i]);
        const [a, b] = s.game;
        if (a >= 3 && b >= 3) {
          if (a === b) return '40';
          return s.game[i] > s.game[other(i)] ? 'AD' : '40';
        }
        return PTS[s.game[i]];
      };
      let headline: string | undefined;
      if (!done) {
        const st = (stakes(s, 0, c) ?? stakes(s, 1, c)) ? ([0, 1] as Side[]).map((i) => ({ i, k: stakes(s, i, c) })).find((x) => x.k) : undefined;
        const [a, b] = s.game;
        const deucePoint = !s.inTiebreak && a === b && a >= 3;
        const decider = deucePoint && c.decidingPointAfterDeuces != null && a - 2 > c.decidingPointAfterDeuces;
        if (st?.k === 'match') headline = `MATCH POINT · ${shortName(ctx, st.i)}`;
        else if (st?.k === 'set') headline = `SET POINT · ${shortName(ctx, st.i)}`;
        else if (st?.k === 'game' && st.i !== s.server && !s.inTiebreak) headline = `BREAK POINT · ${shortName(ctx, st.i)}`;
        if (decider) headline = c.decidingPointName + (headline ? ` · ${headline}` : '');
        else if (!headline && deucePoint) headline = 'DEUCE';
        if (!headline && s.inTiebreak) headline = set.superTb ? 'MATCH TIE-BREAK' : 'TIE-BREAK';
      }
      return {
        phase: done ? 'FINAL' : `SET ${s.sets.length}`,
        sides: ([0, 1] as Side[]).map((i) => ({
          name: ctx.match.participants[i].name,
          score: pointText(i),
          serving: !done && s.server === i,
          badges: [`SETS ${s.setsWon[i]}`],
          detail: done ? undefined : [`Games ${set.g[i]}`],
        })) as any,
        periods: {
          labels: s.sets.map((_, i) => `${i + 1}`),
          rows: ([0, 1] as Side[]).map((i) =>
            s.sets.map((x) => (x.superTb ? String(x.tb![i]) : x.tb && x.winner != null && x.winner !== i ? `${x.g[i]}(${x.tb[i]})` : String(x.g[i]))),
          ) as [string[], string[]],
        },
        headline,
        winner: s.winner,
        resultText: done ? `${ctx.match.participants[s.winner!].name} won ${setScoresText(s, s.winner!)}` : undefined,
      };
    },

    getActions(s, ctx) {
      const acts: ScorerAction[] = [];
      const hows = [
        { value: 'winner', label: 'Winner' }, { value: 'unforced_error', label: 'Opp. unforced error' }, { value: 'forced_error', label: 'Opp. forced error' },
      ];
      for (const side of [0, 1] as Side[]) {
        acts.push({
          id: `point-${side}`, label: `Point ${shortName(ctx, side)}`, type: 'POINT', payload: { side }, side, group: 'primary', tone: 'positive',
          inputs: [
            { key: 'how', label: 'How', kind: 'select', optional: true, options: hows },
            { key: 'serve', label: 'Serve', kind: 'select', optional: true, options: [{ value: '1', label: '1st serve in' }, { value: '2', label: '2nd serve' }] },
          ],
        });
      }
      acts.push({ id: 'ace', label: `Ace ${shortName(ctx, s.server)}`, type: 'POINT', payload: { side: s.server, how: 'ace', serve: 1 }, side: s.server, group: 'stat' });
      acts.push({ id: 'df', label: `Double fault ${shortName(ctx, s.server)}`, type: 'POINT', payload: { side: other(s.server), how: 'double_fault' }, side: s.server, group: 'stat', tone: 'negative' });
      if (!s.started)
        acts.push({ id: 'server', label: `${shortName(ctx, other(s.server))} serves first`, type: 'SET_SERVER', payload: { side: other(s.server) }, group: 'setup' });
      return acts;
    },

    describeEvent(e, before, ctx) {
      const n = (i: Side) => ctx.match.participants[i].name;
      if (e.type === 'SET_SERVER') return `${n(e.payload.side)} to serve`;
      const c = ctx.config as TennisConfig;
      const side: Side = e.payload.side;
      const k = stakes(before, side, c);
      const how = e.payload.how === 'ace' ? 'Ace! ' : e.payload.how === 'double_fault' ? 'Double fault. ' : '';
      if (k === 'match') return `${how}${n(side)} win the match`;
      if (k === 'set') return `${how}${n(side)} take set ${before.sets.length}`;
      if (k === 'game') {
        if (before.inTiebreak) return null;
        const brk = side !== before.server;
        return `${how}${brk ? 'Break! ' : ''}Game ${n(side)}`;
      }
      return how ? `${how}Point ${n(side)}` : null;
    },
  };
  return engine;
}

function setScoresText(s: TennisState, perspective: Side = 0): string {
  return s.sets
    .filter((x) => x.winner != null || x.g[0] + x.g[1] > 0)
    .map((x) => {
      if (x.superTb) return `[${x.tb![perspective]}-${x.tb![other(perspective)]}]`;
      const base = `${x.g[perspective]}-${x.g[other(perspective)]}`;
      return x.tb && x.winner != null ? `${base}(${Math.min(x.tb[0], x.tb[1])})` : base;
    })
    .join(', ');
}

const racketStandings: StandingsRules = { win: 2, draw: 0, loss: 0, tieBreakers: ['wins', 'setsRatio', 'pointsDiff', 'headToHead'], forLabel: 'Sets' };

const tennisBase: TennisConfig = {
  bestOf: 3, gamesPerSet: 6, tiebreakAt: 6, tiebreakPoints: 7, finalSet: 'tiebreak', superTiebreakPoints: 10,
  decidingPointAfterDeuces: null, decidingPointName: 'DECIDING POINT',
};

export const tennis = makeRacketSport(
  'tennis',
  'Tennis',
  [
    { id: 'singles', name: 'Singles — best of 3', sideSize: 1, defaults: { ...tennisBase } },
    { id: 'singles-bo5', name: 'Singles — best of 5', sideSize: 1, defaults: { ...tennisBase, bestOf: 5 } },
    { id: 'doubles', name: 'Doubles (no-ad, match tie-break)', sideSize: 2, defaults: { ...tennisBase, decidingPointAfterDeuces: 0, finalSet: 'super-tiebreak' } },
    { id: 'mixed-doubles', name: 'Mixed doubles', sideSize: 2, defaults: { ...tennisBase, decidingPointAfterDeuces: 0, finalSet: 'super-tiebreak' } },
    { id: 'fast4', name: 'Short sets (first to 4)', sideSize: 1, defaults: { ...tennisBase, gamesPerSet: 4, tiebreakAt: 3, decidingPointAfterDeuces: 0 } },
  ],
  racketStandings,
);

const padelBase: TennisConfig = { ...tennisBase, decidingPointAfterDeuces: 0, decidingPointName: 'GOLDEN POINT' };

export const padel = makeRacketSport(
  'padel',
  'Padel',
  [
    { id: 'doubles', name: 'Doubles (golden point)', sideSize: 2, defaults: { ...padelBase } },
    { id: 'doubles-advantage', name: 'Doubles (advantage)', sideSize: 2, defaults: { ...padelBase, decidingPointAfterDeuces: null } },
    { id: 'doubles-star-point', name: 'Doubles (decider after 2 advantages)', sideSize: 2, defaults: { ...padelBase, decidingPointAfterDeuces: 2, decidingPointName: 'STAR POINT' } },
    { id: 'doubles-super-tb', name: 'Doubles (match tie-break 3rd set)', sideSize: 2, defaults: { ...padelBase, finalSet: 'super-tiebreak' } },
    { id: 'singles', name: 'Singles', sideSize: 1, defaults: { ...padelBase } },
  ],
  racketStandings,
);
