/**
 * Cricket: ball-by-ball engine for limited-overs (T10/T20/ODI/custom) and multi-day
 * (two innings per side) formats.
 *
 * Covers: toss, openers, strike rotation, overs and maidens, bowler rotation rules
 * (no consecutive overs, per-bowler over limits), wides/no-balls/byes/leg-byes/penalty
 * runs, every mode of dismissal with legality rules (free hit, wide, no-ball), new batter
 * placement (caught => new batter on strike), retirements, partnerships, fall of wickets,
 * powerplay, chase equations, declarations, innings victories, ties and Super Overs,
 * revised targets (hook for DLS) and net-run-rate inputs for standings.
 */
import type { ActionInput, EngineContext, MatchEvent, ScorerAction, Side, SportRuleEngine } from '../core/types.ts';
import { other } from '../core/types.ts';
import { clone, fail, isSide, ok, playerName, playerOptions, shortName } from '../core/util.ts';

export interface CricketConfig {
  oversPerInnings: number | null;
  ballsPerOver: number;
  inningsPerSide: 1 | 2;
  playersPerSide: number;
  wideRuns: number;
  noBallRuns: number;
  freeHit: boolean;
  powerplayOvers: number;
  maxOversPerBowler: number | null;
  superOver: boolean;
  superOverOvers: number;
  reviewsPerInnings: number;
}

export type ExtraType = 'wide' | 'noball' | 'bye' | 'legbye';
export type WicketKind =
  | 'bowled' | 'caught' | 'lbw' | 'stumped' | 'hit_wicket' | 'run_out' | 'retired_out' | 'obstructing' | 'hit_twice' | 'timed_out';

const BOWLER_CREDIT: WicketKind[] = ['bowled', 'caught', 'lbw', 'stumped', 'hit_wicket'];
const ON_WIDE: WicketKind[] = ['stumped', 'run_out', 'hit_wicket', 'obstructing'];
const ON_NOBALL: WicketKind[] = ['run_out', 'obstructing', 'hit_twice'];
const ON_FREEHIT: WicketKind[] = ['run_out', 'obstructing', 'hit_twice'];

interface BatterCard { runs: number; balls: number; fours: number; sixes: number; dots: number; out?: { kind: WicketKind | 'retired_hurt'; text: string }; order: number; }
interface BowlerCard { balls: number; runs: number; wickets: number; maidens: number; dots: number; wides: number; noBalls: number; order: number; }
interface OverSummary { bowler: string; runs: number; wickets: number; balls: string[]; }

export interface Innings {
  number: number;
  battingSide: Side;
  isSuperOver: boolean;
  maxBalls: number | null;
  maxWickets: number;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: { wd: number; nb: number; b: number; lb: number; pen: number };
  batters: Record<string, BatterCard>;
  bowlers: Record<string, BowlerCard>;
  striker: string | null;
  nonStriker: string | null;
  bowler: string | null;
  lastOverBowler: string | null;
  over: { balls: string[]; charged: number; runs: number; wickets: number; legal: number };
  overs: OverSummary[];
  partnership: { a: string | null; b: string | null; runs: number; balls: number };
  partnerships: { a: string; b: string; runs: number; balls: number }[];
  fow: { wicket: number; runs: number; over: string; player: string }[];
  freeHit: boolean;
  target: number | null;
  closed: boolean;
  closeReason?: 'all_out' | 'overs' | 'target' | 'declared' | 'forfeit' | 'time';
  boundaries: { fours: number; sixes: number };
  dots: number;
  reviewsUsed: number;
}

export interface CricketState {
  toss: { winner: Side; decision: 'bat' | 'bowl' } | null;
  innings: Innings[];
  pendingPenalty: [number, number];
  revisedTarget: { target: number; overs: number | null } | null;
  result: { winner: Side | null; text: string; kind: 'runs' | 'wickets' | 'innings' | 'tie' | 'draw' | 'no_result' | 'super_over' } | null;
  superOvers: number;
}

const oversText = (balls: number, bpo: number) => `${Math.floor(balls / bpo)}.${balls % bpo}`;
const cur = (s: CricketState): Innings | undefined => s.innings[s.innings.length - 1];

function sideTotals(s: CricketState, side: Side, includeSuperOver = false): number {
  return s.innings.filter((i) => i.battingSide === side && (includeSuperOver || !i.isSuperOver)).reduce((a, i) => a + i.runs, 0);
}

function dismissalText(kind: WicketKind, bowler: string, fielder: string | undefined, ctx: EngineContext): string {
  const b = playerName(ctx, bowler);
  const f = fielder ? playerName(ctx, fielder) : '';
  switch (kind) {
    case 'bowled': return `b ${b}`;
    case 'caught': return fielder && fielder !== bowler ? `c ${f} b ${b}` : `c & b ${b}`;
    case 'lbw': return `lbw b ${b}`;
    case 'stumped': return `st ${f || '†'} b ${b}`;
    case 'hit_wicket': return `hit wicket b ${b}`;
    case 'run_out': return `run out${f ? ` (${f})` : ''}`;
    case 'retired_out': return 'retired out';
    case 'obstructing': return 'obstructing the field';
    case 'hit_twice': return 'hit the ball twice';
    case 'timed_out': return 'timed out';
  }
}

function nextBattingSide(s: CricketState, c: CricketConfig): Side | null {
  const n = s.innings.length;
  if (n === 0) {
    if (!s.toss) return null;
    return s.toss.decision === 'bat' ? s.toss.winner : other(s.toss.winner);
  }
  const first = s.innings[0].battingSide;
  const last = cur(s)!;
  if (last.isSuperOver) return other(last.battingSide);
  const regular = s.innings.filter((i) => !i.isSuperOver).length;
  if (regular < 2 * c.inningsPerSide) return regular % 2 === 0 ? first : other(first);
  // super over: side batting second in the match bats first
  return other(first);
}

function openInnings(s: CricketState, side: Side, c: CricketConfig, e: MatchEvent): Innings {
  const regularDone = s.innings.filter((i) => !i.isSuperOver).length >= 2 * c.inningsPerSide;
  const isSO = regularDone;
  const inn: Innings = {
    number: s.innings.length + 1,
    battingSide: side,
    isSuperOver: isSO,
    maxBalls: isSO ? c.superOverOvers * c.ballsPerOver : c.oversPerInnings ? c.oversPerInnings * c.ballsPerOver : null,
    maxWickets: isSO ? 2 : c.playersPerSide - 1,
    runs: s.pendingPenalty[side],
    wickets: 0,
    legalBalls: 0,
    extras: { wd: 0, nb: 0, b: 0, lb: 0, pen: s.pendingPenalty[side] },
    batters: {},
    bowlers: {},
    striker: e.payload.striker,
    nonStriker: e.payload.nonStriker,
    bowler: e.payload.bowler,
    lastOverBowler: null,
    over: { balls: [], charged: 0, runs: 0, wickets: 0, legal: 0 },
    overs: [],
    partnership: { a: e.payload.striker, b: e.payload.nonStriker, runs: 0, balls: 0 },
    partnerships: [],
    fow: [],
    freeHit: false,
    target: null,
    closed: false,
    boundaries: { fours: 0, sixes: 0 },
    dots: 0,
    reviewsUsed: 0,
  };
  s.pendingPenalty[side] = 0;
  addBatter(inn, e.payload.striker);
  addBatter(inn, e.payload.nonStriker);
  addBowler(inn, e.payload.bowler);
  // Target for the chasing innings
  const regular = s.innings.filter((i) => !i.isSuperOver);
  if (isSO) {
    const prevSO = cur(s);
    if (prevSO?.isSuperOver && prevSO.battingSide !== side && s.innings.filter((i) => i.isSuperOver).length % 2 === 1) inn.target = prevSO.runs + 1;
  } else if (regular.length === 2 * c.inningsPerSide - 1) {
    const opp = sideTotals(s, other(side));
    const mine = sideTotals(s, side);
    inn.target = opp - mine + 1;
    if (s.revisedTarget) {
      inn.target = s.revisedTarget.target;
      if (s.revisedTarget.overs) inn.maxBalls = s.revisedTarget.overs * c.ballsPerOver;
    }
  }
  s.innings.push(inn);
  return inn;
}

function addBatter(inn: Innings, id: string | null) {
  if (id && !inn.batters[id]) inn.batters[id] = { runs: 0, balls: 0, fours: 0, sixes: 0, dots: 0, order: Object.keys(inn.batters).length + 1 };
}
function addBowler(inn: Innings, id: string | null) {
  if (id && !inn.bowlers[id]) inn.bowlers[id] = { balls: 0, runs: 0, wickets: 0, maidens: 0, dots: 0, wides: 0, noBalls: 0, order: Object.keys(inn.bowlers).length + 1 };
}

function closePartnership(inn: Innings) {
  const p = inn.partnership;
  if (p.a && p.b) inn.partnerships.push({ a: p.a, b: p.b, runs: p.runs, balls: p.balls });
}

function checkClose(s: CricketState, inn: Innings, c: CricketConfig) {
  if (inn.closed) return;
  if (inn.target != null && inn.runs >= inn.target) return closeInnings(s, inn, 'target', c);
  if (inn.wickets >= inn.maxWickets) return closeInnings(s, inn, 'all_out', c);
  if (inn.maxBalls != null && inn.legalBalls >= inn.maxBalls) return closeInnings(s, inn, 'overs', c);
}

function closeInnings(s: CricketState, inn: Innings, reason: Innings['closeReason'], c: CricketConfig) {
  inn.closed = true;
  inn.closeReason = reason;
  closePartnership(inn);
  if (inn.over.balls.length) {
    inn.overs.push({ bowler: inn.bowler ?? '', runs: inn.over.runs, wickets: inn.over.wickets, balls: inn.over.balls });
    inn.over = { balls: [], charged: 0, runs: 0, wickets: 0, legal: 0 };
  }
  decide(s, c);
}

/** Work out whether the match is over after an innings closes. */
function decide(s: CricketState, c: CricketConfig) {
  const inn = cur(s)!;
  const regular = s.innings.filter((i) => !i.isSuperOver);
  const total = 2 * c.inningsPerSide;
  const name = (side: Side) => side;
  void name;
  if (inn.isSuperOver) {
    const so = s.innings.filter((i) => i.isSuperOver);
    if (so.length % 2 === 1) return; // other side still to bat
    const [a, b] = so.slice(-2);
    if (a.runs === b.runs) {
      if (c.superOver) return; // another super over
      s.result = { winner: null, kind: 'tie', text: 'Match tied (Super Over tied)' };
      return;
    }
    const w = a.runs > b.runs ? a.battingSide : b.battingSide;
    s.result = { winner: w, kind: 'super_over', text: 'won the Super Over' };
    return;
  }
  // Innings victory check after 3rd innings of a two-innings match
  if (c.inningsPerSide === 2 && regular.length === 3) {
    const twice = inn.battingSide; // batted 1st & 3rd (or follow-on side)
    const behind = sideTotals(s, other(twice)) - sideTotals(s, twice);
    if (behind > 0 && inn.closeReason !== 'declared') {
      s.result = { winner: other(twice), kind: 'innings', text: `won by an innings and ${behind} run${behind === 1 ? '' : 's'}` };
    }
    return;
  }
  if (regular.length < total) return;
  // Final regular innings closed
  const chase = inn;
  if (chase.target != null && chase.runs >= chase.target) {
    const left = chase.maxWickets - chase.wickets;
    const ballsLeft = chase.maxBalls != null ? chase.maxBalls - chase.legalBalls : null;
    s.result = { winner: chase.battingSide, kind: 'wickets', text: `won by ${left} wicket${left === 1 ? '' : 's'}${ballsLeft ? ` (${ballsLeft} ball${ballsLeft === 1 ? '' : 's'} left)` : ''}` };
    return;
  }
  if (chase.closeReason === 'time') {
    s.result = { winner: null, kind: 'draw', text: 'Match drawn' };
    return;
  }
  const deficit = (chase.target ?? 0) - 1 - chase.runs;
  if (deficit === 0) {
    if (c.superOver && c.inningsPerSide === 1) return; // super over to follow
    s.result = { winner: null, kind: 'tie', text: 'Match tied' };
    return;
  }
  if (chase.closeReason === 'declared' && c.inningsPerSide === 2) {
    s.result = { winner: null, kind: 'draw', text: 'Match drawn' };
    return;
  }
  s.result = { winner: other(chase.battingSide), kind: 'runs', text: `won by ${deficit} run${deficit === 1 ? '' : 's'}` };
}

function ballLabel(runs: number, extra: ExtraType | undefined, extraTotal: number, wicket: boolean): string {
  let t: string;
  if (extra === 'wide') t = `${extraTotal}wd`;
  else if (extra === 'noball') t = runs ? `${runs}+nb` : 'nb';
  else if (extra === 'bye') t = `${runs}b`;
  else if (extra === 'legbye') t = `${runs}lb`;
  else t = runs === 0 ? '•' : String(runs);
  return wicket ? (t === '•' ? 'W' : `${t}+W`) : t;
}

const awaitingOf = (s: CricketState, c: CricketConfig): string | null => {
  if (s.result) return null;
  const inn = cur(s);
  if (!inn || inn.closed) return 'innings';
  if (!inn.striker || !inn.nonStriker) return 'batter';
  if (!inn.bowler) return 'bowler';
  void c;
  return null;
};

export const cricket: SportRuleEngine<CricketState> = {
  id: 'cricket',
  name: 'Cricket',
  family: 'cricket',
  disciplines: [
    { id: 't20', name: 'T20', sideSize: 11, defaults: { oversPerInnings: 20, ballsPerOver: 6, inningsPerSide: 1, playersPerSide: 11, wideRuns: 1, noBallRuns: 1, freeHit: true, powerplayOvers: 6, maxOversPerBowler: 4, superOver: true, superOverOvers: 1, reviewsPerInnings: 2 } },
    { id: 'odi', name: 'One Day (50 overs)', sideSize: 11, defaults: { oversPerInnings: 50, ballsPerOver: 6, inningsPerSide: 1, playersPerSide: 11, wideRuns: 1, noBallRuns: 1, freeHit: true, powerplayOvers: 10, maxOversPerBowler: 10, superOver: true, superOverOvers: 1, reviewsPerInnings: 2 } },
    { id: 't10', name: 'T10', sideSize: 11, defaults: { oversPerInnings: 10, ballsPerOver: 6, inningsPerSide: 1, playersPerSide: 11, wideRuns: 1, noBallRuns: 1, freeHit: true, powerplayOvers: 3, maxOversPerBowler: 2, superOver: true, superOverOvers: 1, reviewsPerInnings: 1 } },
    { id: 'test', name: 'Test / multi-day', sideSize: 11, defaults: { oversPerInnings: null, ballsPerOver: 6, inningsPerSide: 2, playersPerSide: 11, wideRuns: 1, noBallRuns: 1, freeHit: false, powerplayOvers: 0, maxOversPerBowler: null, superOver: false, superOverOvers: 1, reviewsPerInnings: 3 } },
    { id: 'custom-6-a-side', name: 'Box / indoor 6-a-side (5 overs)', sideSize: 6, defaults: { oversPerInnings: 5, ballsPerOver: 6, inningsPerSide: 1, playersPerSide: 6, wideRuns: 1, noBallRuns: 1, freeHit: true, powerplayOvers: 1, maxOversPerBowler: 1, superOver: true, superOverOvers: 1, reviewsPerInnings: 0 } },
  ],
  standings: { win: 2, draw: 1, loss: 0, tieBreakers: ['wins', 'netRunRate', 'headToHead'], forLabel: 'Runs' },
  eventTypes: ['TOSS', 'INNINGS_START', 'BALL', 'NEW_BATTER', 'NEW_BOWLER', 'RETIRE', 'SWAP_STRIKE', 'PENALTY_RUNS', 'INNINGS_END', 'REVISED_TARGET', 'DECLARE_RESULT', 'REVIEW', 'COMMENT'],

  initializeMatch: () => ({ toss: null, innings: [], pendingPenalty: [0, 0], revisedTarget: null, result: null, superOvers: 0 }),

  validateEvent(s, e, ctx) {
    const c = ctx.config as CricketConfig;
    if (s.result) return fail('Match is complete');
    const inn = cur(s);
    const p = e.payload ?? {};
    switch (e.type) {
      case 'TOSS':
        if (s.innings.length) return fail('Toss must happen before play');
        return isSide(p.winner) && ['bat', 'bowl'].includes(p.decision) ? ok : fail('winner and decision (bat|bowl) required');
      case 'INNINGS_START': {
        if (inn && !inn.closed) return fail('Current innings is still in progress');
        if (!p.striker || !p.nonStriker || !p.bowler) return fail('striker, nonStriker and bowler required');
        if (p.striker === p.nonStriker) return fail('Openers must be different players');
        const side = isSide(p.battingSide) ? p.battingSide : nextBattingSide(s, c);
        if (side == null) return fail('Record the toss or specify battingSide');
        return ok;
      }
      case 'COMMENT':
        return typeof p.text === 'string' && p.text.trim() ? ok : fail('text required');
      case 'REVISED_TARGET':
        return Number.isInteger(p.target) && p.target > 0 ? ok : fail('target must be a positive integer');
      case 'DECLARE_RESULT':
        return ['draw', 'no_result', 'tie'].includes(p.kind) ? ok : fail('kind must be draw | no_result | tie');
    }
    if (!inn || inn.closed) return fail('No innings in progress');
    switch (e.type) {
      case 'NEW_BATTER': {
        if (!p.player) return fail('player required');
        if (inn.striker && inn.nonStriker) return fail('Both batters are already in');
        const card = inn.batters[p.player];
        if (card && card.out && card.out.kind !== 'retired_hurt') return fail(`${playerName(ctx, p.player)} is already out`);
        if (p.player === inn.striker || p.player === inn.nonStriker) return fail('Player is already batting');
        return ok;
      }
      case 'NEW_BOWLER': {
        if (!p.player) return fail('player required');
        if (inn.bowler && inn.over.balls.length) return fail('Cannot change bowler mid-over (use a correction)');
        if (p.player === inn.lastOverBowler) return fail('A bowler cannot bowl consecutive overs');
        const b = inn.bowlers[p.player];
        if (c.maxOversPerBowler && !inn.isSuperOver && b && b.balls >= c.maxOversPerBowler * c.ballsPerOver)
          return fail(`${playerName(ctx, p.player)} has bowled the maximum ${c.maxOversPerBowler} overs`);
        return ok;
      }
      case 'RETIRE':
        if (p.player !== inn.striker && p.player !== inn.nonStriker) return fail('Only a batter at the crease can retire');
        return ['hurt', 'out'].includes(p.kind) ? ok : fail('kind must be hurt|out');
      case 'SWAP_STRIKE':
        return inn.striker && inn.nonStriker ? ok : fail('Both batters must be in');
      case 'PENALTY_RUNS':
        return isSide(p.side) && Number.isInteger(p.runs) && p.runs > 0 ? ok : fail('side and positive runs required');
      case 'INNINGS_END':
        return ['declared', 'forfeit', 'time'].includes(p.reason) ? ok : fail('reason must be declared | forfeit | time');
      case 'REVIEW':
        if (!isSide(p.side)) return fail('side required');
        return ok;
      case 'BALL': {
        if (!inn.striker || !inn.nonStriker) return fail('Waiting for a new batter');
        if (!inn.bowler) return fail('Select the bowler for this over');
        const runs = p.runs ?? 0;
        if (!Number.isInteger(runs) || runs < 0 || runs > 7) return fail('runs must be 0–7');
        const extra: ExtraType | undefined = p.extra;
        if (extra && !['wide', 'noball', 'bye', 'legbye'].includes(extra)) return fail('Unknown extra');
        if (p.wicket) {
          const k: WicketKind = p.wicket.kind;
          if (!['bowled', 'caught', 'lbw', 'stumped', 'hit_wicket', 'run_out', 'retired_out', 'obstructing', 'hit_twice', 'timed_out'].includes(k)) return fail('Unknown dismissal');
          if (extra === 'wide' && !ON_WIDE.includes(k)) return fail(`Cannot be out ${k.replace('_', ' ')} off a wide`);
          if (extra === 'noball' && !ON_NOBALL.includes(k)) return fail(`Cannot be out ${k.replace('_', ' ')} off a no-ball`);
          if (inn.freeHit && !ON_FREEHIT.includes(k)) return fail(`Free hit: cannot be out ${k.replace('_', ' ')}`);
          const out = p.wicket.playerOut ?? inn.striker;
          if (out !== inn.striker && out !== inn.nonStriker) return fail('Dismissed player must be at the crease');
          if (['bowled', 'lbw', 'stumped', 'hit_wicket', 'caught'].includes(k) && out !== inn.striker) return fail('Only the striker can be out that way');
          if (k === 'caught' && runs > 0 && extra !== 'noball') return fail('No runs count when a batter is caught');
        }
        return ok;
      }
    }
    return fail('Unsupported event');
  },

  applyEvent(prev, e, ctx) {
    const c = ctx.config as CricketConfig;
    const s = clone(prev);
    const p = e.payload ?? {};
    const inn = cur(s)!;
    switch (e.type) {
      case 'TOSS':
        s.toss = { winner: p.winner, decision: p.decision };
        return s;
      case 'INNINGS_START': {
        const side: Side = isSide(p.battingSide) ? p.battingSide : nextBattingSide(s, c)!;
        if (s.innings.length >= 2 * c.inningsPerSide) s.superOvers++;
        openInnings(s, side, c, e);
        return s;
      }
      case 'COMMENT':
        return s;
      case 'REVISED_TARGET': {
        s.revisedTarget = { target: p.target, overs: p.overs ?? null };
        if (inn && !inn.closed && inn.target != null) {
          inn.target = p.target;
          if (p.overs) inn.maxBalls = p.overs * c.ballsPerOver;
          checkClose(s, inn, c);
        }
        return s;
      }
      case 'DECLARE_RESULT':
        if (inn && !inn.closed) {
          inn.closed = true;
          inn.closeReason = 'time';
          closePartnership(inn);
        }
        s.result = { winner: null, kind: p.kind, text: p.kind === 'draw' ? 'Match drawn' : p.kind === 'tie' ? 'Match tied' : 'No result' };
        return s;
      case 'NEW_BATTER': {
        addBatter(inn, p.player);
        const card = inn.batters[p.player];
        if (card.out?.kind === 'retired_hurt') delete card.out;
        const pos = p.position ?? (inn.striker ? 'nonStriker' : 'striker');
        if (pos === 'striker' && !inn.striker) inn.striker = p.player;
        else if (!inn.nonStriker) inn.nonStriker = p.player;
        else inn.striker = p.player;
        inn.partnership = { a: inn.striker, b: inn.nonStriker, runs: 0, balls: 0 };
        return s;
      }
      case 'NEW_BOWLER':
        // Replacing an injured bowler mid-over is done by voiding; a fresh over needs no previous bowler.
        inn.bowler = p.player;
        addBowler(inn, p.player);
        return s;
      case 'SWAP_STRIKE':
        [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
        return s;
      case 'PENALTY_RUNS': {
        if (p.side === inn.battingSide) {
          inn.runs += p.runs;
          inn.extras.pen += p.runs;
        } else s.pendingPenalty[p.side as Side] += p.runs;
        checkClose(s, inn, c);
        return s;
      }
      case 'RETIRE': {
        const card = inn.batters[p.player];
        if (p.kind === 'out') {
          card.out = { kind: 'retired_out', text: 'retired out' };
          inn.wickets++;
          inn.fow.push({ wicket: inn.wickets, runs: inn.runs, over: oversText(inn.legalBalls, c.ballsPerOver), player: p.player });
        } else card.out = { kind: 'retired_hurt', text: 'retired hurt' };
        closePartnership(inn);
        inn.partnership = { a: null, b: null, runs: 0, balls: 0 };
        if (inn.striker === p.player) inn.striker = null;
        else inn.nonStriker = null;
        checkClose(s, inn, c);
        return s;
      }
      case 'INNINGS_END':
        closeInnings(s, inn, p.reason, c);
        return s;
      case 'REVIEW':
        if (p.outcome === 'struck_down' || p.outcome === 'unsuccessful') inn.reviewsUsed += p.side === inn.battingSide ? 1 : 0;
        return s;
      case 'BALL':
        applyBall(s, inn, e, ctx);
        return s;
    }
    return s;
  },

  calculateScore(s, ctx) {
    const c = ctx.config as CricketConfig;
    const text = ([0, 1] as Side[]).map((side) => {
      const inns = s.innings.filter((i) => i.battingSide === side && !i.isSuperOver);
      if (!inns.length) return 'Yet to bat';
      return inns.map((i) => `${i.runs}${i.wickets < i.maxWickets ? `/${i.wickets}` : ''}${i.closeReason === 'declared' ? 'd' : ''}`).join(' & ');
    }) as [string, string];
    // NRR inputs: an all-out side is deemed to have faced its full quota of overs.
    const runsFor: [number, number] = [0, 0];
    const ballsFaced: [number, number] = [0, 0];
    for (const i of s.innings.filter((x) => !x.isSuperOver)) {
      runsFor[i.battingSide] += i.runs;
      ballsFaced[i.battingSide] += i.closeReason === 'all_out' && i.maxBalls ? i.maxBalls : i.legalBalls;
    }
    return {
      text,
      primary: [sideTotals(s, 0), sideTotals(s, 1)],
      extra: { pointsFor: [sideTotals(s, 0), sideTotals(s, 1)], nrr: { runsFor, ballsFaced, ballsPerOver: c.ballsPerOver }, resultKind: s.result?.kind },
    };
  },

  calculateStatistics(s, _events, ctx) {
    const c = ctx.config as CricketConfig;
    const bpo = c.ballsPerOver;
    const sr = (r: number, b: number) => (b ? ((r / b) * 100).toFixed(1) : '–');
    const econ = (r: number, b: number) => (b ? ((r / b) * bpo).toFixed(2) : '–');
    const cards = s.innings.map((i) => ({
      number: i.number,
      battingSide: i.battingSide,
      isSuperOver: i.isSuperOver,
      total: `${i.runs}/${i.wickets}`,
      overs: oversText(i.legalBalls, bpo),
      runRate: i.legalBalls ? ((i.runs / i.legalBalls) * bpo).toFixed(2) : '0.00',
      extras: { ...i.extras, total: i.extras.wd + i.extras.nb + i.extras.b + i.extras.lb + i.extras.pen },
      batting: Object.entries(i.batters).sort((a, b) => a[1].order - b[1].order).map(([id, b]) => ({
        playerId: id, name: playerName(ctx, id), runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes, dots: b.dots,
        strikeRate: sr(b.runs, b.balls), dismissal: b.out?.text ?? (id === i.striker || id === i.nonStriker ? 'not out' : 'did not bat'),
        onStrike: id === i.striker,
      })),
      bowling: Object.entries(i.bowlers).sort((a, b) => a[1].order - b[1].order).map(([id, b]) => ({
        playerId: id, name: playerName(ctx, id), overs: oversText(b.balls, bpo), maidens: b.maidens, runs: b.runs, wickets: b.wickets,
        economy: econ(b.runs, b.balls), dots: b.dots, wides: b.wides, noBalls: b.noBalls,
      })),
      fallOfWickets: i.fow.map((f) => ({ ...f, name: playerName(ctx, f.player) })),
      partnerships: [...i.partnerships, ...(!i.closed && i.partnership.a && i.partnership.b ? [{ ...i.partnership, current: true }] : [])].map((p) => ({
        ...p, names: `${playerName(ctx, p.a!)} & ${playerName(ctx, p.b!)}`,
      })),
      overByOver: i.overs.map((o) => ({ runs: o.runs, wickets: o.wickets, bowler: playerName(ctx, o.bowler) })),
    }));
    const agg = (side: Side) => s.innings.filter((i) => i.battingSide === side && !i.isSuperOver);
    const sum = (side: Side, f: (i: Innings) => number) => agg(side).reduce((a, i) => a + f(i), 0);
    const team = [
      { key: 'runRate', label: 'Run rate', values: ([0, 1] as Side[]).map((x) => { const b = sum(x, (i) => i.legalBalls); return b ? ((sum(x, (i) => i.runs) / b) * bpo).toFixed(2) : '–'; }) },
      { key: 'fours', label: 'Fours', values: ([0, 1] as Side[]).map((x) => sum(x, (i) => i.boundaries.fours)) },
      { key: 'sixes', label: 'Sixes', values: ([0, 1] as Side[]).map((x) => sum(x, (i) => i.boundaries.sixes)) },
      { key: 'extras', label: 'Extras received', values: ([0, 1] as Side[]).map((x) => sum(x, (i) => i.extras.wd + i.extras.nb + i.extras.b + i.extras.lb + i.extras.pen)) },
      { key: 'dotPct', label: 'Dot ball %', values: ([0, 1] as Side[]).map((x) => { const b = sum(x, (i) => i.legalBalls); return b ? `${Math.round((sum(x, (i) => i.dots) / b) * 100)}%` : '–'; }) },
    ] as any;
    // Player aggregates across innings (for career/tournament stats and rankings)
    const players: Record<string, { side: Side; stats: Record<string, number> }> = {};
    for (const i of s.innings) {
      for (const [id, b] of Object.entries(i.batters)) {
        const r = (players[id] ??= { side: i.battingSide, stats: {} }).stats;
        r.runs = (r.runs ?? 0) + b.runs;
        r.ballsFaced = (r.ballsFaced ?? 0) + b.balls;
        r.fours = (r.fours ?? 0) + b.fours;
        r.sixes = (r.sixes ?? 0) + b.sixes;
        if (b.out && b.out.kind !== 'retired_hurt') r.dismissals = (r.dismissals ?? 0) + 1;
      }
      for (const [id, b] of Object.entries(i.bowlers)) {
        const r = (players[id] ??= { side: other(i.battingSide), stats: {} }).stats;
        r.wickets = (r.wickets ?? 0) + b.wickets;
        r.ballsBowled = (r.ballsBowled ?? 0) + b.balls;
        r.runsConceded = (r.runsConceded ?? 0) + b.runs;
        r.maidens = (r.maidens ?? 0) + b.maidens;
      }
    }
    return {
      team,
      players: Object.entries(players).map(([id, v]) => ({ playerId: id, name: playerName(ctx, id), side: v.side, stats: v.stats })),
      detail: { innings: cards, toss: s.toss, result: s.result },
    };
  },

  determineWinner: (s) => s.result?.winner ?? null,
  isMatchComplete: (s) => !!s.result,
  getCurrentState: (s) => s,

  getDisplayState(s, ctx) {
    const c = ctx.config as CricketConfig;
    const bpo = c.ballsPerOver;
    const inn = cur(s);
    const n = (side: Side) => ctx.match.participants[side].name;
    const sideScore = (side: Side): { score: string; detail: string[] } => {
      const inns = s.innings.filter((i) => i.battingSide === side);
      if (!inns.length) return { score: '–', detail: ['Yet to bat'] };
      const live = inn && !inn.closed && inn.battingSide === side ? inn : null;
      const show = live ?? inns[inns.length - 1];
      const prevRegular = inns.filter((i) => i !== show && !i.isSuperOver);
      const det: string[] = [`${show.isSuperOver ? 'SUPER OVER · ' : ''}OVERS ${oversText(show.legalBalls, bpo)}${show.maxBalls ? `/${show.maxBalls / bpo}` : ''}`];
      if (prevRegular.length) det.push(`1st inns ${prevRegular.map((i) => `${i.runs}/${i.wickets}`).join(' & ')}`);
      if (live) {
        for (const id of [live.striker, live.nonStriker]) {
          if (!id) continue;
          const b = live.batters[id];
          det.push(`${id === live.striker ? '▶ ' : ''}${playerName(ctx, id)} ${b.runs} (${b.balls})`);
        }
      }
      return { score: `${show.runs}/${show.wickets}`, detail: det };
    };
    const sides = ([0, 1] as Side[]).map((i) => {
      const sc = sideScore(i);
      const d: any = { name: n(i), score: sc.score, detail: sc.detail, serving: !!inn && !inn.closed && inn.battingSide === i };
      if (inn && !inn.closed && inn.battingSide !== i && inn.bowler) {
        const b = inn.bowlers[inn.bowler];
        d.detail = [...sc.detail, `● ${playerName(ctx, inn.bowler)} ${b.wickets}-${b.runs} (${oversText(b.balls, bpo)})`];
      }
      return d;
    });
    let headline: string | undefined;
    let phase = 'TOSS';
    if (inn) {
      const ordinal = ['1ST', '2ND', '3RD', '4TH'][inn.number - 1] ?? `${inn.number}TH`;
      phase = inn.isSuperOver ? 'SUPER OVER' : `${ordinal} INNINGS`;
      if (!inn.closed) {
        const pp = !inn.isSuperOver && c.powerplayOvers && inn.legalBalls < c.powerplayOvers * bpo;
        if (pp) phase += ' · POWERPLAY';
        const crr = inn.legalBalls ? ((inn.runs / inn.legalBalls) * bpo).toFixed(2) : '0.00';
        if (inn.target != null) {
          const need = inn.target - inn.runs;
          if (inn.maxBalls != null) {
            const left = inn.maxBalls - inn.legalBalls;
            const rrr = left > 0 ? ((need / left) * bpo).toFixed(2) : '–';
            headline = `NEED ${need} OFF ${left} BALL${left === 1 ? '' : 'S'} · RRR ${rrr} · CRR ${crr}`;
          } else headline = `NEED ${need} TO WIN · ${inn.maxWickets - inn.wickets} WKTS LEFT`;
        } else if (c.inningsPerSide === 2 && s.innings.length > 1) {
          const lead = sideTotals(s, inn.battingSide) - sideTotals(s, other(inn.battingSide));
          headline = lead >= 0 ? `LEAD BY ${lead}` : `TRAIL BY ${-lead}`;
        } else headline = `CRR ${crr}${inn.freeHit ? ' · FREE HIT' : ''}`;
        if (inn.freeHit && headline && !headline.includes('FREE HIT')) headline += ' · FREE HIT';
      } else if (!s.result) phase = 'INNINGS BREAK';
    }
    if (s.result) phase = 'RESULT';
    const thisOver = inn && !inn.closed ? inn.over.balls : inn?.overs[inn.overs.length - 1]?.balls ?? [];
    return {
      phase,
      sides: sides as any,
      // Innings-by-innings table only adds information beyond two innings (Tests, Super Overs).
      periods: s.innings.length > 2
        ? {
            labels: s.innings.map((i) => (i.isSuperOver ? 'SO' : `Inn ${i.number}`)),
            rows: ([0, 1] as Side[]).map((side) => s.innings.map((i) => (i.battingSide === side ? `${i.runs}/${i.wickets}` : ''))) as [string[], string[]],
          }
        : undefined,
      headline,
      ticker: thisOver.length ? [`THIS OVER  ${thisOver.join('  ')}`] : undefined,
      winner: s.result?.winner ?? null,
      resultText: s.result ? (s.result.winner != null ? `${n(s.result.winner)} ${s.result.text}` : s.result.text) : s.toss && !s.innings.length ? `${n(s.toss.winner)} won the toss and chose to ${s.toss.decision}` : undefined,
    };
  },

  getActions(s, ctx) {
    const c = ctx.config as CricketConfig;
    const inn = cur(s);
    const acts: ScorerAction[] = [];
    const waiting = awaitingOf(s, c);
    if (waiting === 'innings') {
      if (!s.innings.length && !s.toss)
        acts.push({ id: 'toss', label: 'Record toss', type: 'TOSS', group: 'setup', inputs: [
          { key: 'winner', label: 'Toss won by', kind: 'select', options: [0, 1].map((i) => ({ value: String(i), label: ctx.match.participants[i].name })) },
          { key: 'decision', label: 'Elected to', kind: 'select', options: [{ value: 'bat', label: 'Bat' }, { value: 'bowl', label: 'Bowl' }] },
        ] });
      const bat = nextBattingSide(s, c) ?? 0;
      const bowl = other(bat);
      acts.push({ id: 'innings-start', label: `Start innings — ${shortName(ctx, bat)} batting`, type: 'INNINGS_START', payload: { battingSide: bat }, group: 'control', tone: 'positive', inputs: [
        { key: 'striker', label: 'Striker', kind: 'player', side: bat, options: playerOptions(ctx, bat) },
        { key: 'nonStriker', label: 'Non-striker', kind: 'player', side: bat, options: playerOptions(ctx, bat) },
        { key: 'bowler', label: 'Opening bowler', kind: 'player', side: bowl, options: playerOptions(ctx, bowl) },
      ] });
      if (c.inningsPerSide === 2 || s.innings.length) acts.push({ id: 'declare-result', label: 'Declare result (draw / no result)', type: 'DECLARE_RESULT', group: 'control', inputs: [
        { key: 'kind', label: 'Result', kind: 'select', options: [{ value: 'draw', label: 'Draw' }, { value: 'no_result', label: 'No result' }, { value: 'tie', label: 'Tie' }] },
      ] });
      return acts;
    }
    if (!inn) return acts;
    const bat = inn.battingSide;
    const bowl = other(bat);
    if (waiting === 'batter') {
      const avail = (id: string) => !(inn.batters[id]?.out && inn.batters[id].out!.kind !== 'retired_hurt') && id !== inn.striker && id !== inn.nonStriker;
      acts.push({ id: 'new-batter', label: 'New batter', type: 'NEW_BATTER', group: 'primary', tone: 'positive', inputs: [
        { key: 'player', label: 'Batter', kind: 'player', side: bat, options: playerOptions(ctx, bat, avail) },
      ] });
      return acts;
    }
    if (waiting === 'bowler') {
      acts.push({ id: 'new-bowler', label: `Bowler for over ${Math.floor(inn.legalBalls / c.ballsPerOver) + 1}`, type: 'NEW_BOWLER', group: 'primary', tone: 'positive', inputs: [
        { key: 'player', label: 'Bowler', kind: 'player', side: bowl, options: playerOptions(ctx, bowl, (id) => {
          if (id === inn.lastOverBowler) return false;
          const b = inn.bowlers[id];
          return !(c.maxOversPerBowler && !inn.isSuperOver && b && b.balls >= c.maxOversPerBowler * c.ballsPerOver);
        }) },
      ] });
      return acts;
    }
    for (const r of [0, 1, 2, 3, 4, 6])
      acts.push({ id: `runs-${r}`, label: r === 0 ? 'Dot' : String(r), type: 'BALL', payload: { runs: r }, group: 'primary', tone: r >= 4 ? 'positive' : 'neutral' });
    const runsInput: ActionInput = { key: 'runs', label: 'Runs ran', kind: 'number', default: 0, optional: true };
    acts.push({ id: 'wide', label: 'Wide', type: 'BALL', payload: { extra: 'wide', runs: 0 }, group: 'primary', inputs: [runsInput] });
    acts.push({ id: 'noball', label: 'No ball', type: 'BALL', payload: { extra: 'noball', runs: 0 }, group: 'primary', inputs: [{ ...runsInput, label: 'Runs off bat' }] });
    acts.push({ id: 'bye', label: 'Bye', type: 'BALL', payload: { extra: 'bye', runs: 1 }, group: 'primary', inputs: [{ ...runsInput, default: 1 }] });
    acts.push({ id: 'legbye', label: 'Leg bye', type: 'BALL', payload: { extra: 'legbye', runs: 1 }, group: 'primary', inputs: [{ ...runsInput, default: 1 }] });
    const atCrease = [inn.striker!, inn.nonStriker!].map((id) => ({ value: id, label: playerName(ctx, id) }));
    acts.push({ id: 'wicket', label: 'WICKET', type: 'BALL', payload: { runs: 0 }, group: 'primary', tone: 'negative', inputs: [
      { key: 'wicket.kind', label: 'How out', kind: 'select', options: (inn.freeHit ? ON_FREEHIT : ['bowled', 'caught', 'lbw', 'run_out', 'stumped', 'hit_wicket', 'obstructing', 'hit_twice', 'retired_out', 'timed_out']).map((k) => ({ value: k, label: k.replace('_', ' ') })) },
      { key: 'wicket.playerOut', label: 'Batter out', kind: 'select', options: atCrease, default: inn.striker },
      { key: 'wicket.fielder', label: 'Fielder', kind: 'player', side: bowl, optional: true, options: playerOptions(ctx, bowl) },
      { key: 'runs', label: 'Runs completed', kind: 'number', optional: true, default: 0 },
      { key: 'extra', label: 'Off a', kind: 'select', optional: true, options: [{ value: 'wide', label: 'Wide' }, { value: 'noball', label: 'No ball' }] },
    ] });
    acts.push({ id: 'swap', label: 'Swap strike', type: 'SWAP_STRIKE', group: 'secondary' });
    acts.push({ id: 'retire', label: 'Retire batter', type: 'RETIRE', group: 'secondary', inputs: [
      { key: 'player', label: 'Batter', kind: 'select', options: atCrease },
      { key: 'kind', label: 'Type', kind: 'select', options: [{ value: 'hurt', label: 'Retired hurt' }, { value: 'out', label: 'Retired out' }] },
    ] });
    acts.push({ id: 'penalty', label: 'Penalty runs', type: 'PENALTY_RUNS', group: 'secondary', inputs: [
      { key: 'side', label: 'Awarded to', kind: 'select', options: [0, 1].map((i) => ({ value: String(i), label: ctx.match.participants[i].name })) },
      { key: 'runs', label: 'Runs', kind: 'number', default: 5 },
    ] });
    acts.push({ id: 'review', label: 'Review (DRS)', type: 'REVIEW', group: 'secondary', inputs: [
      { key: 'side', label: 'Reviewed by', kind: 'select', options: [0, 1].map((i) => ({ value: String(i), label: ctx.match.participants[i].name })) },
      { key: 'outcome', label: 'Outcome', kind: 'select', options: [{ value: 'upheld', label: 'Successful' }, { value: 'struck_down', label: 'Unsuccessful' }, { value: 'retained', label: "Umpire's call (retained)" }] },
    ] });
    acts.push({ id: 'comment', label: 'Add commentary', type: 'COMMENT', group: 'secondary', inputs: [{ key: 'text', label: 'Commentary', kind: 'text' }] });
    acts.push({ id: 'revised', label: 'Revised target (DLS)', type: 'REVISED_TARGET', group: 'control', inputs: [
      { key: 'target', label: 'Target', kind: 'number' }, { key: 'overs', label: 'Overs', kind: 'number', optional: true },
    ] });
    acts.push({ id: 'declare', label: c.inningsPerSide === 2 ? 'Declare / close innings' : 'Close innings', type: 'INNINGS_END', payload: { reason: 'declared' }, group: 'control' });
    return acts;
  },

  describeEvent(e, before, ctx) {
    const c = ctx.config as CricketConfig;
    const p = e.payload ?? {};
    const inn = cur(before);
    const n = (i: Side) => ctx.match.participants[i].name;
    switch (e.type) {
      case 'TOSS':
        return `${n(p.winner)} won the toss and elected to ${p.decision}`;
      case 'INNINGS_START': {
        const side: Side = isSide(p.battingSide) ? p.battingSide : nextBattingSide(before, c)!;
        return `${n(side)} innings begins: ${playerName(ctx, p.striker)} & ${playerName(ctx, p.nonStriker)}; ${playerName(ctx, p.bowler)} to open the bowling`;
      }
      case 'NEW_BATTER':
        return `${playerName(ctx, p.player)} comes to the crease`;
      case 'NEW_BOWLER':
        return `${playerName(ctx, p.player)} into the attack`;
      case 'COMMENT':
        return p.text;
      case 'INNINGS_END':
        return `Innings closed (${p.reason}) at ${inn?.runs}/${inn?.wickets}`;
      case 'REVISED_TARGET':
        return `Revised target: ${p.target}${p.overs ? ` from ${p.overs} overs` : ''}`;
      case 'PENALTY_RUNS':
        return `${p.runs} penalty runs to ${n(p.side)}`;
      case 'RETIRE':
        return `${playerName(ctx, p.player)} retired ${p.kind}`;
      case 'REVIEW':
        return `Review by ${n(p.side)}: ${p.outcome === 'upheld' ? 'successful' : p.outcome === 'retained' ? "umpire's call" : 'unsuccessful'}`;
      case 'BALL': {
        if (!inn) return null;
        const over = `${Math.floor(inn.legalBalls / c.ballsPerOver)}.${(inn.legalBalls % c.ballsPerOver) + 1}`;
        const who = `${playerName(ctx, inn.bowler!)} to ${playerName(ctx, inn.striker!)}`;
        const runs = p.runs ?? 0;
        let what: string;
        if (p.wicket) {
          const out = p.wicket.playerOut ?? inn.striker;
          const b = inn.batters[out];
          const extraRuns = p.extra === 'noball' ? 0 : 0;
          void extraRuns;
          what = `OUT! ${playerName(ctx, out)} ${dismissalText(p.wicket.kind, inn.bowler!, p.wicket.fielder, ctx)} ${b.runs + (out === inn.striker && !p.extra ? runs : 0)} (${b.balls + (out === inn.striker && p.extra !== 'wide' ? 1 : 0)})`;
        } else if (p.extra === 'wide') what = `wide${runs ? `, ${runs} run${runs > 1 ? 's' : ''} taken` : ''}`;
        else if (p.extra === 'noball') what = `no ball${runs ? `, ${runs === 4 ? 'FOUR' : runs === 6 ? 'SIX' : `${runs} off the bat`}` : ''}${c.freeHit ? ' — free hit next' : ''}`;
        else if (p.extra === 'bye') what = `${runs} bye${runs === 1 ? '' : 's'}`;
        else if (p.extra === 'legbye') what = `${runs} leg bye${runs === 1 ? '' : 's'}`;
        else what = runs === 4 ? 'FOUR' : runs === 6 ? 'SIX!' : runs === 0 ? 'no run' : `${runs} run${runs > 1 ? 's' : ''}`;
        return `${over} ${who}, ${what}`;
      }
    }
    return null;
  },
};

function applyBall(s: CricketState, inn: Innings, e: MatchEvent, ctx: EngineContext) {
  const c = ctx.config as CricketConfig;
  const p = e.payload ?? {};
  const runs: number = p.runs ?? 0;
  const extra: ExtraType | undefined = p.extra;
  const striker = inn.striker!;
  const bowlerId = inn.bowler!;
  const bat = inn.batters[striker];
  const bowl = inn.bowlers[bowlerId];
  const legal = extra !== 'wide' && extra !== 'noball';
  const wasFreeHit = inn.freeHit;

  let total = runs;
  let charged = 0;
  if (extra === 'wide') {
    total = c.wideRuns + runs;
    inn.extras.wd += total;
    bowl.wides += total;
    charged = total;
  } else if (extra === 'noball') {
    total = c.noBallRuns + runs;
    inn.extras.nb += c.noBallRuns;
    bowl.noBalls++;
    charged = total;
    bat.runs += runs;
    bat.balls++;
    if (runs === 4 && p.boundary !== false) (bat.fours++, inn.boundaries.fours++);
    if (runs === 6) (bat.sixes++, inn.boundaries.sixes++);
  } else if (extra === 'bye' || extra === 'legbye') {
    inn.extras[extra === 'bye' ? 'b' : 'lb'] += runs;
    bat.balls++;
    bat.dots++;
    bowl.dots++;
  } else {
    bat.runs += runs;
    bat.balls++;
    charged = runs;
    if (runs === 0) (bat.dots++, bowl.dots++, inn.dots++);
    if (runs === 4 && p.boundary !== false) (bat.fours++, inn.boundaries.fours++);
    if (runs === 6) (bat.sixes++, inn.boundaries.sixes++);
  }
  if ((extra === 'bye' || extra === 'legbye') && runs === 0) inn.dots++;
  inn.runs += total;
  bowl.runs += charged;
  inn.partnership.runs += total;
  if (legal) {
    inn.legalBalls++;
    bowl.balls++;
    inn.partnership.balls++;
    inn.over.legal++;
  }
  inn.over.charged += charged;
  inn.over.runs += total;
  inn.freeHit = c.freeHit && extra === 'noball' ? true : extra === 'wide' ? wasFreeHit : false;

  // Strike rotation from runs physically completed (boundaries don't count as crossings).
  const ran = runs;
  const boundary = !extra && (runs === 4 || runs === 6) && p.boundary !== false;
  if (ran % 2 === 1 && !boundary) [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];

  // Wicket
  let wicketFell = false;
  if (p.wicket) {
    const kind: WicketKind = p.wicket.kind;
    const outId: string = p.wicket.playerOut ?? striker;
    const card = inn.batters[outId];
    card.out = { kind, text: dismissalText(kind, bowlerId, p.wicket.fielder, ctx) };
    inn.wickets++;
    inn.over.wickets++;
    wicketFell = true;
    if (BOWLER_CREDIT.includes(kind)) bowl.wickets++;
    inn.fow.push({ wicket: inn.wickets, runs: inn.runs, over: oversText(inn.legalBalls, c.ballsPerOver), player: outId });
    closePartnership(inn);
    inn.partnership = { a: null, b: null, runs: 0, balls: 0 };
    if (kind === 'caught') {
      // Law 18.11: new batter takes the striker's end; the not-out batter stays at their end.
      const survivor = outId === inn.striker ? inn.nonStriker : inn.striker;
      inn.striker = null;
      inn.nonStriker = survivor;
    } else if (inn.striker === outId) inn.striker = null;
    else inn.nonStriker = null;
  }
  inn.over.balls.push(ballLabel(runs, extra, total, wicketFell));

  // End of over
  if (legal && inn.legalBalls % c.ballsPerOver === 0) {
    if (inn.over.charged === 0 && inn.over.legal === c.ballsPerOver) bowl.maidens++;
    inn.overs.push({ bowler: bowlerId, runs: inn.over.runs, wickets: inn.over.wickets, balls: inn.over.balls });
    inn.over = { balls: [], charged: 0, runs: 0, wickets: 0, legal: 0 };
    [inn.striker, inn.nonStriker] = [inn.nonStriker, inn.striker];
    inn.lastOverBowler = bowlerId;
    inn.bowler = null;
  }
  checkClose(s, inn, c);
}
