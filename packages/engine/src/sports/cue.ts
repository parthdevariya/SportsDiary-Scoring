/**
 * Cue sports.
 *  - Snooker: frame-based, reds/colours sequence, breaks, fouls (min 4), points remaining,
 *    snookers-required, re-spotted black, concessions.
 *  - Billiards: a configurable points/racks engine. Organisers define the scoring shots
 *    (pots, in-offs, cannons, …), foul values, and the win condition (target points,
 *    frames/racks to win, or timed with highest score), so English billiards, carom and
 *    pool-style formats are configuration rather than code.
 */
import type { ScorerAction, Side, SportRuleEngine, StandingsRules } from '../core/types.ts';
import { other } from '../core/types.ts';
import { clone, fail, isSide, ok, shortName } from '../core/util.ts';

const cueStandings: StandingsRules = { win: 2, draw: 0, loss: 0, tieBreakers: ['wins', 'setsRatio', 'pointsDiff', 'headToHead'], forLabel: 'Frames' };

// ------------------------------------------------------------------ SNOOKER
const COLOURS = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'] as const;
type Colour = (typeof COLOURS)[number];
const VALUE: Record<string, number> = { red: 1, yellow: 2, green: 3, brown: 4, blue: 5, pink: 6, black: 7 };

export interface SnookerConfig {
  bestOf: number;
  reds: number;
  minFoul: number;
}

export interface SnookerFrame {
  score: [number, number];
  redsLeft: number;
  /** 'red' (must pot a red), 'colour' (after a red: any colour), 'clearance' (colours in order), 'respot' (re-spotted black). */
  on: 'red' | 'colour' | 'clearance' | 'respot';
  nextColour: number; // index into COLOURS during clearance
  atTable: Side;
  breakRuns: number;
  winner?: Side;
  highBreak: [number, number];
}

export interface SnookerState {
  frames: SnookerFrame[];
  framesWon: [number, number];
  highBreak: [number, number];
  centuries: [number, number];
  fouls: [number, number];
  pots: [number, number];
  winner: Side | null;
  firstBreaker: Side;
}

function newFrame(c: SnookerConfig, breaker: Side): SnookerFrame {
  return { score: [0, 0], redsLeft: c.reds, on: 'red', nextColour: 0, atTable: breaker, breakRuns: 0, highBreak: [0, 0] };
}

/** Maximum points still available on the table. */
export function pointsRemaining(f: SnookerFrame): number {
  const coloursSum = 27; // 2+3+4+5+6+7
  if (f.on === 'respot') return 7;
  if (f.on === 'clearance') return COLOURS.slice(f.nextColour).reduce((a, c) => a + VALUE[c], 0);
  // reds still on: each red + black, plus all colours; if on a colour now, +7 for that colour
  return f.redsLeft * 8 + coloursSum + (f.on === 'colour' ? 7 : 0);
}

function endBreak(s: SnookerState, f: SnookerFrame) {
  const p = f.atTable;
  f.highBreak[p] = Math.max(f.highBreak[p], f.breakRuns);
  s.highBreak[p] = Math.max(s.highBreak[p], f.breakRuns);
  if (f.breakRuns >= 100) s.centuries[p]++;
  f.breakRuns = 0;
}

function finishFrame(s: SnookerState, c: SnookerConfig, f: SnookerFrame, w: Side) {
  endBreak(s, f);
  f.winner = w;
  s.framesWon[w]++;
  if (s.framesWon[w] >= Math.floor(c.bestOf / 2) + 1) s.winner = w;
  else {
    const breaker: Side = s.frames.length % 2 === 0 ? s.firstBreaker : other(s.firstBreaker);
    s.frames.push(newFrame(c, breaker));
  }
}

/** After the last colour of the clearance (black) is potted or fouled. */
function afterFinalBlack(s: SnookerState, c: SnookerConfig, f: SnookerFrame) {
  if (f.score[0] === f.score[1]) {
    f.on = 'respot';
    return;
  }
  finishFrame(s, c, f, f.score[0] > f.score[1] ? 0 : 1);
}

export const snooker: SportRuleEngine<SnookerState> = {
  id: 'snooker',
  name: 'Snooker',
  family: 'cue',
  disciplines: [
    { id: 'best-of-7', name: 'Best of 7 frames', sideSize: 1, defaults: { bestOf: 7, reds: 15, minFoul: 4 } },
    { id: 'best-of-5', name: 'Best of 5 frames', sideSize: 1, defaults: { bestOf: 5, reds: 15, minFoul: 4 } },
    { id: 'best-of-11', name: 'Best of 11 frames', sideSize: 1, defaults: { bestOf: 11, reds: 15, minFoul: 4 } },
    { id: 'six-red', name: '6-red, best of 7', sideSize: 1, defaults: { bestOf: 7, reds: 6, minFoul: 4 } },
  ],
  standings: cueStandings,
  eventTypes: ['POT', 'MISS', 'FOUL', 'CONCEDE', 'SET_BREAKER', 'FREE_BALL'],

  initializeMatch(ctx) {
    const c = ctx.config as SnookerConfig;
    const breaker: Side = isSide(ctx.config.firstBreaker) ? ctx.config.firstBreaker : 0;
    return { frames: [newFrame(c, breaker)], framesWon: [0, 0], highBreak: [0, 0], centuries: [0, 0], fouls: [0, 0], pots: [0, 0], winner: null, firstBreaker: breaker };
  },

  validateEvent(s, e, ctx) {
    const c = ctx.config as SnookerConfig;
    if (s.winner != null) return fail('Match is complete');
    const f = s.frames[s.frames.length - 1];
    const p = e.payload ?? {};
    switch (e.type) {
      case 'SET_BREAKER':
        if (s.frames.length > 1 || f.score[0] + f.score[1] > 0 || f.breakRuns) return fail('Breaker can only be set before the first frame starts');
        return isSide(p.side) ? ok : fail('side required');
      case 'MISS':
        return ok;
      case 'CONCEDE':
        return isSide(p.side) ? ok : fail('side (conceding player) required');
      case 'FOUL': {
        const pts = p.points ?? c.minFoul;
        if (!Number.isInteger(pts) || pts < c.minFoul || pts > 7) return fail(`Foul value must be ${c.minFoul}–7`);
        if (p.redsLost && (!Number.isInteger(p.redsLost) || p.redsLost < 0 || p.redsLost > f.redsLeft)) return fail('Invalid number of reds lost');
        return ok;
      }
      case 'FREE_BALL': {
        // Free ball nominated: counts as the ball "on" (1 if reds, else value of next colour).
        if (f.on === 'colour' || f.on === 'respot') return fail('Free ball is not available now');
        return ok;
      }
      case 'POT': {
        const ball: string = p.ball;
        if (!(ball in VALUE)) return fail('Unknown ball');
        if (f.on === 'red') {
          if (ball !== 'red') return fail('Player is on a red');
          const n = p.count ?? 1;
          if (!Number.isInteger(n) || n < 1 || n > f.redsLeft) return fail(`Only ${f.redsLeft} red(s) left`);
          return ok;
        }
        if (f.on === 'colour') return ball === 'red' ? fail('Player is on a colour') : ok;
        if (f.on === 'respot') return ball === 'black' ? ok : fail('Re-spotted black: only the black');
        return ball === COLOURS[f.nextColour] ? ok : fail(`On the ${COLOURS[f.nextColour]}`);
      }
    }
    return fail('Unsupported event');
  },

  applyEvent(prev, e, ctx) {
    const c = ctx.config as SnookerConfig;
    const s = clone(prev);
    const f = s.frames[s.frames.length - 1];
    const p = e.payload ?? {};
    switch (e.type) {
      case 'SET_BREAKER':
        s.firstBreaker = p.side;
        f.atTable = p.side;
        break;
      case 'MISS':
        endBreak(s, f);
        f.atTable = other(f.atTable);
        if (f.on === 'colour') f.on = f.redsLeft > 0 ? 'red' : 'clearance';
        break;
      case 'CONCEDE':
        finishFrame(s, c, f, other(p.side as Side));
        break;
      case 'FREE_BALL': {
        const val = f.on === 'red' ? 1 : VALUE[COLOURS[f.nextColour]];
        f.score[f.atTable] += val;
        f.breakRuns += val;
        s.pots[f.atTable]++;
        if (f.on === 'red') f.on = 'colour';
        break;
      }
      case 'FOUL': {
        const pts = p.points ?? c.minFoul;
        const offender = f.atTable;
        s.fouls[offender]++;
        f.score[other(offender)] += pts;
        endBreak(s, f);
        if (p.redsLost) f.redsLeft -= p.redsLost;
        // The non-offender comes to the table (play-again requests are recorded with MISS).
        f.atTable = other(offender);
        if (f.on === 'colour') f.on = f.redsLeft > 0 ? 'red' : 'clearance';
        else if (f.on === 'red' && f.redsLeft === 0) f.on = 'clearance';
        if (f.on === 'respot') afterFinalBlack(s, c, f);
        // A foul while only the black remains ends the frame.
        else if (f.on === 'clearance' && f.nextColour === COLOURS.length - 1) afterFinalBlack(s, c, f);
        break;
      }
      case 'POT': {
        const ball: string = p.ball;
        const pl = f.atTable;
        if (ball === 'red') {
          const n = p.count ?? 1;
          f.redsLeft -= n;
          f.score[pl] += n;
          f.breakRuns += n;
          s.pots[pl] += n;
          f.on = 'colour';
        } else {
          const v = VALUE[ball];
          f.score[pl] += v;
          f.breakRuns += v;
          s.pots[pl]++;
          if (f.on === 'colour') f.on = f.redsLeft > 0 ? 'red' : 'clearance';
          else if (f.on === 'respot') {
            afterFinalBlack(s, c, f);
            break;
          } else {
            // clearance
            if (f.nextColour === COLOURS.length - 1) {
              afterFinalBlack(s, c, f);
              break;
            }
            f.nextColour++;
          }
        }
        break;
      }
    }
    return s;
  },

  calculateScore(s) {
    const pf: [number, number] = [0, 0];
    s.frames.forEach((f) => {
      pf[0] += f.score[0];
      pf[1] += f.score[1];
    });
    return { text: [String(s.framesWon[0]), String(s.framesWon[1])], primary: [...s.framesWon] as [number, number], extra: { pointsFor: pf, unit: 'frames', setScores: s.frames.filter((f) => f.winner != null).map((f) => f.score.join('-')).join(', ') } };
  },

  calculateStatistics(s) {
    return {
      team: [
        { key: 'highBreak', label: 'Highest break', values: [...s.highBreak] as [number, number] },
        { key: 'centuries', label: 'Century breaks', values: [...s.centuries] as [number, number] },
        { key: 'pots', label: 'Balls potted', values: [...s.pots] as [number, number] },
        { key: 'fouls', label: 'Fouls', values: [...s.fouls] as [number, number] },
        { key: 'points', label: 'Total points', values: s.frames.reduce((a, f) => [a[0] + f.score[0], a[1] + f.score[1]], [0, 0]) as [number, number] },
      ],
      players: [],
      detail: { frames: s.frames.map((f) => ({ score: f.score, winner: f.winner, highBreak: f.highBreak })) },
    };
  },

  determineWinner: (s) => s.winner,
  isMatchComplete: (s) => s.winner != null,
  getCurrentState: (s) => s,

  getDisplayState(s, ctx) {
    const f = s.frames[s.frames.length - 1];
    const done = s.winner != null;
    const rem = pointsRemaining(f);
    let headline: string | undefined;
    if (!done) {
      const lead = Math.abs(f.score[0] - f.score[1]);
      const leader: Side = f.score[0] >= f.score[1] ? 0 : 1;
      const on = f.on === 'red' ? 'RED' : f.on === 'colour' ? 'COLOUR' : f.on === 'respot' ? 'RE-SPOTTED BLACK' : COLOURS[f.nextColour].toUpperCase();
      headline = `ON: ${on} · REMAINING ${rem}`;
      if (lead > rem && f.score[0] !== f.score[1]) headline += ` · ${shortName(ctx, other(leader))} NEEDS SNOOKERS`;
    }
    return {
      phase: done ? 'FINAL' : `FRAME ${s.frames.length}`,
      sides: ([0, 1] as Side[]).map((i) => ({
        name: ctx.match.participants[i].name,
        score: String(done ? s.framesWon[i] : f.score[i]),
        serving: !done && f.atTable === i,
        badges: [`FRAMES ${s.framesWon[i]}`],
        detail: done ? [`High break ${s.highBreak[i]}`] : [...(f.atTable === i && f.breakRuns ? [`BREAK ${f.breakRuns}`] : []), `Reds ${f.redsLeft}`, `High ${s.highBreak[i]}`],
      })) as any,
      periods: { labels: s.frames.map((_, i) => `${i + 1}`), rows: [s.frames.map((x) => String(x.score[0])), s.frames.map((x) => String(x.score[1]))] },
      headline,
      winner: s.winner,
      resultText: done ? `${ctx.match.participants[s.winner!].name} won ${s.framesWon[s.winner!]}–${s.framesWon[other(s.winner!)]}` : undefined,
    };
  },

  getActions(s, ctx) {
    const f = s.frames[s.frames.length - 1];
    const acts: ScorerAction[] = [];
    const balls: string[] = f.on === 'red' ? ['red'] : f.on === 'colour' ? [...COLOURS] : f.on === 'respot' ? ['black'] : [COLOURS[f.nextColour]];
    for (const b of balls) acts.push({ id: `pot-${b}`, label: `${b[0].toUpperCase()}${b.slice(1)} (${VALUE[b]})`, type: 'POT', payload: { ball: b }, group: 'primary', tone: 'positive' });
    acts.push({ id: 'miss', label: `Miss / safety — ${shortName(ctx, other(f.atTable))} to table`, type: 'MISS', group: 'primary' });
    for (const v of [4, 5, 6, 7]) acts.push({ id: `foul-${v}`, label: `Foul ${v}`, type: 'FOUL', payload: { points: v }, group: 'secondary', tone: 'negative' });
    if (f.on !== 'colour' && f.on !== 'respot') acts.push({ id: 'free-ball', label: 'Free ball potted', type: 'FREE_BALL', group: 'secondary' });
    if (f.on === 'red' && f.redsLeft > 1) acts.push({ id: 'multi-red', label: 'Multiple reds', type: 'POT', payload: { ball: 'red' }, group: 'secondary', inputs: [{ key: 'count', label: 'Reds potted', kind: 'number', default: 2 }] });
    for (const side of [0, 1] as Side[]) acts.push({ id: `concede-${side}`, label: `${shortName(ctx, side)} concedes frame`, type: 'CONCEDE', payload: { side }, group: 'control', tone: 'negative' });
    return acts;
  },

  describeEvent(e, before, ctx) {
    const f = before.frames[before.frames.length - 1];
    const n = (i: Side) => ctx.match.participants[i].name;
    const p = e.payload ?? {};
    switch (e.type) {
      case 'POT': {
        const after = snooker.applyEvent(before, e, ctx);
        if (after.frames.length > before.frames.length || after.winner != null) return `${n(f.atTable)} wins frame ${before.frames.length}`;
        return null;
      }
      case 'MISS':
        return f.breakRuns >= 20 ? `Break of ${f.breakRuns} by ${n(f.atTable)} ends` : null;
      case 'FOUL':
        return `Foul by ${n(f.atTable)} — ${p.points ?? 4} to ${n(other(f.atTable))}`;
      case 'CONCEDE':
        return `${n(p.side)} concedes frame ${before.frames.length}`;
    }
    return null;
  },
};

// ------------------------------------------------------------------ BILLIARDS
export interface BilliardsConfig {
  /** Scoring shot catalogue: id -> points. Fully editable by organisers. */
  shots: Record<string, number>;
  /** Points awarded to the opponent for a foul (0 = foul just ends the visit). */
  foulPoints: number;
  /** 'points': first to targetPoints wins a frame. 'racks': each rack/frame is won outright (pool). 'timed': highest score when time is called. */
  mode: 'points' | 'racks' | 'timed';
  targetPoints: number | null;
  framesToWin: number;
}

export interface BilliardsState {
  frames: { score: [number, number]; winner?: Side }[];
  framesWon: [number, number];
  atTable: Side;
  breakRuns: number;
  highBreak: [number, number];
  shots: Record<string, [number, number]>;
  fouls: [number, number];
  visits: [number, number];
  winner: Side | null;
}

const englishShots = { pot_red: 3, pot_white: 2, in_off_red: 3, in_off_white: 2, cannon: 2 };

export const billiards: SportRuleEngine<BilliardsState> = {
  id: 'billiards',
  name: 'Billiards',
  family: 'cue',
  disciplines: [
    { id: 'english-points', name: 'English billiards — points up', sideSize: 1, defaults: { shots: englishShots, foulPoints: 2, mode: 'points', targetPoints: 150, framesToWin: 3 } },
    { id: 'english-timed', name: 'English billiards — timed', sideSize: 1, defaults: { shots: englishShots, foulPoints: 2, mode: 'timed', targetPoints: null, framesToWin: 1 } },
    { id: 'carom-three-cushion', name: 'Carom — three-cushion', sideSize: 1, defaults: { shots: { carom: 1 }, foulPoints: 0, mode: 'points', targetPoints: 40, framesToWin: 2 } },
    { id: 'pool-8-ball', name: 'Pool — 8-ball race', sideSize: 1, defaults: { shots: {}, foulPoints: 0, mode: 'racks', targetPoints: null, framesToWin: 5 } },
    { id: 'pool-9-ball', name: 'Pool — 9-ball race', sideSize: 1, defaults: { shots: {}, foulPoints: 0, mode: 'racks', targetPoints: null, framesToWin: 7 } },
  ],
  standings: cueStandings,
  eventTypes: ['SCORE', 'END_VISIT', 'FOUL', 'RACK_WON', 'TIME_CALLED', 'SET_BREAKER'],

  initializeMatch: (ctx) => ({
    frames: [{ score: [0, 0] }], framesWon: [0, 0], atTable: isSide(ctx.config.firstBreaker) ? ctx.config.firstBreaker : 0, breakRuns: 0,
    highBreak: [0, 0], shots: {}, fouls: [0, 0], visits: [0, 0], winner: null,
  }),

  validateEvent(s, e, ctx) {
    const c = ctx.config as BilliardsConfig;
    if (s.winner != null) return fail('Match is complete');
    const p = e.payload ?? {};
    switch (e.type) {
      case 'SCORE':
        if (c.mode === 'racks') return fail('Rack-based format: record RACK_WON');
        if (!(p.shot in c.shots) && !(Number.isInteger(p.points) && p.points > 0)) return fail(`shot must be one of: ${Object.keys(c.shots).join(', ')} (or give points)`);
        return ok;
      case 'RACK_WON':
        return isSide(p.side) ? ok : fail('side required');
      case 'TIME_CALLED':
        return c.mode === 'timed' ? ok : fail('Only timed formats end on time');
      case 'SET_BREAKER':
        return isSide(p.side) ? ok : fail('side required');
      case 'END_VISIT':
      case 'FOUL':
        return ok;
    }
    return fail('Unsupported event');
  },

  applyEvent(prev, e, ctx) {
    const c = ctx.config as BilliardsConfig;
    const s = clone(prev);
    const fr = s.frames[s.frames.length - 1];
    const p = e.payload ?? {};
    const endVisit = () => {
      s.highBreak[s.atTable] = Math.max(s.highBreak[s.atTable], s.breakRuns);
      s.breakRuns = 0;
      s.visits[s.atTable]++;
      s.atTable = other(s.atTable);
    };
    const winFrame = (w: Side) => {
      s.highBreak[s.atTable] = Math.max(s.highBreak[s.atTable], s.breakRuns);
      s.breakRuns = 0;
      fr.winner = w;
      s.framesWon[w]++;
      if (s.framesWon[w] >= c.framesToWin) s.winner = w;
      else s.frames.push({ score: [0, 0] });
    };
    switch (e.type) {
      case 'SET_BREAKER':
        s.atTable = p.side;
        break;
      case 'SCORE': {
        const pts = p.shot ? c.shots[p.shot] : p.points;
        fr.score[s.atTable] += pts;
        s.breakRuns += pts;
        if (p.shot) (s.shots[p.shot] ??= [0, 0])[s.atTable]++;
        if (c.mode === 'points' && c.targetPoints && fr.score[s.atTable] >= c.targetPoints) winFrame(s.atTable);
        break;
      }
      case 'FOUL':
        s.fouls[s.atTable]++;
        fr.score[other(s.atTable)] += p.points ?? c.foulPoints;
        endVisit();
        if (c.mode === 'points' && c.targetPoints && fr.score[s.atTable] >= c.targetPoints) winFrame(s.atTable);
        break;
      case 'END_VISIT':
        endVisit();
        break;
      case 'RACK_WON':
        fr.score[p.side as Side] = 1;
        s.atTable = other(s.atTable);
        winFrame(p.side);
        break;
      case 'TIME_CALLED': {
        const w: Side = fr.score[0] >= fr.score[1] ? 0 : 1;
        if (fr.score[0] !== fr.score[1]) winFrame(w);
        break;
      }
    }
    return s;
  },

  calculateScore(s, ctx) {
    const c = ctx.config as BilliardsConfig;
    const pf: [number, number] = [0, 0];
    s.frames.forEach((f) => ((pf[0] += f.score[0]), (pf[1] += f.score[1])));
    const single = c.framesToWin === 1 && c.mode !== 'racks';
    const fr = s.frames[s.frames.length - 1];
    return single
      ? { text: [String(fr.score[0]), String(fr.score[1])], primary: [...fr.score] as [number, number], extra: { pointsFor: pf } }
      : { text: [String(s.framesWon[0]), String(s.framesWon[1])], primary: [...s.framesWon] as [number, number], extra: { pointsFor: pf, unit: c.mode === 'racks' ? 'racks' : 'frames' } };
  },

  calculateStatistics(s) {
    const team = [
      { key: 'highBreak', label: 'Highest break', values: [...s.highBreak] as [number, number] },
      { key: 'fouls', label: 'Fouls', values: [...s.fouls] as [number, number] },
      { key: 'visits', label: 'Visits', values: [...s.visits] as [number, number] },
      ...Object.entries(s.shots).map(([k, v]) => ({ key: k, label: k.replace(/_/g, ' '), values: [...v] as [number, number] })),
    ];
    return { team, players: [] };
  },

  determineWinner: (s) => s.winner,
  isMatchComplete: (s) => s.winner != null,
  getCurrentState: (s) => s,

  getDisplayState(s, ctx) {
    const c = ctx.config as BilliardsConfig;
    const done = s.winner != null;
    const fr = s.frames[s.frames.length - 1];
    const racks = c.mode === 'racks';
    return {
      phase: done ? 'FINAL' : racks ? `RACE TO ${c.framesToWin}` : c.framesToWin > 1 ? `FRAME ${s.frames.length}` : c.mode === 'timed' ? 'TIMED' : `GAME TO ${c.targetPoints}`,
      sides: ([0, 1] as Side[]).map((i) => ({
        name: ctx.match.participants[i].name,
        score: String(racks || (done && c.framesToWin > 1) ? s.framesWon[i] : fr.score[i]),
        serving: !done && s.atTable === i,
        badges: !racks && c.framesToWin > 1 ? [`FRAMES ${s.framesWon[i]}`] : undefined,
        detail: [...(s.atTable === i && s.breakRuns ? [`BREAK ${s.breakRuns}`] : []), `High ${s.highBreak[i]}`],
      })) as any,
      periods: !racks && c.framesToWin > 1 ? { labels: s.frames.map((_, i) => `${i + 1}`), rows: [s.frames.map((f) => String(f.score[0])), s.frames.map((f) => String(f.score[1]))] } : undefined,
      headline: !done && c.mode === 'points' && c.targetPoints ? `${shortName(ctx, s.atTable)} AT TABLE · NEEDS ${c.targetPoints - fr.score[s.atTable]}` : undefined,
      winner: s.winner,
      resultText: done ? `${ctx.match.participants[s.winner!].name} won` : undefined,
    };
  },

  getActions(s, ctx) {
    const c = ctx.config as BilliardsConfig;
    const acts: ScorerAction[] = [];
    if (c.mode === 'racks') {
      for (const side of [0, 1] as Side[]) acts.push({ id: `rack-${side}`, label: `Rack to ${shortName(ctx, side)}`, type: 'RACK_WON', payload: { side }, group: 'primary', tone: 'positive' });
      return acts;
    }
    for (const [shot, pts] of Object.entries(c.shots))
      acts.push({ id: `shot-${shot}`, label: `${shot.replace(/_/g, ' ')} (+${pts})`, type: 'SCORE', payload: { shot }, group: 'primary', tone: 'positive' });
    acts.push({ id: 'end-visit', label: `End visit — ${shortName(ctx, other(s.atTable))} to table`, type: 'END_VISIT', group: 'primary' });
    acts.push({ id: 'foul', label: `Foul (${c.foulPoints} to opponent)`, type: 'FOUL', group: 'secondary', tone: 'negative' });
    if (c.mode === 'timed') acts.push({ id: 'time', label: 'Time called', type: 'TIME_CALLED', group: 'control' });
    return acts;
  },

  describeEvent(e, before, ctx) {
    const n = (i: Side) => ctx.match.participants[i].name;
    if (e.type === 'RACK_WON') return `Rack to ${n(e.payload.side)}`;
    if (e.type === 'FOUL') return `Foul by ${n(before.atTable)}`;
    if (e.type === 'END_VISIT' && before.breakRuns >= 20) return `Break of ${before.breakRuns} by ${n(before.atTable)}`;
    if (e.type === 'TIME_CALLED') return 'Time called';
    return null;
  },
};
