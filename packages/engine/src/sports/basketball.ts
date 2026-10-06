/**
 * Basketball: 5x5 (FIBA/NBA-style configurable) and 3x3 (target score, 1/2-point values).
 * Game clock with stop/start, quarters, overtime, team fouls + bonus, player foul-out,
 * timeouts, and a full box score (FG/3PT/FT, rebounds, assists, steals, blocks, turnovers).
 */
import type { ActionInput, ScorerAction, Side, SportRuleEngine } from '../core/types.ts';
import { other } from '../core/types.ts';
import { bump, clone, eventTime, fail, findPlayer, isSide, ok, pct, playerName, playerOptions, shortName } from '../core/util.ts';
import { clockDisplay, clockStart, clockStop, fmtClock, newClock, newPossession, possessionSwitch, type ClockState, type PossessionState } from '../core/clock.ts';

export interface BasketballConfig {
  periods: number;
  periodMinutes: number;
  overtimeMinutes: number;
  /** Team foul number from which free throws are awarded (FIBA: 5th foul => bonus). */
  bonusFoul: number;
  foulOut: number;
  timeoutsPerGame: number;
  /** 3x3: game ends immediately when a team reaches this score. */
  targetScore: number | null;
  /** 3x3 overtime: first team to score this many points in OT wins. */
  overtimeTarget: number | null;
  /** Point value of a shot from beyond the arc (3 in 5x5, 2 in 3x3). */
  arcValue: number;
  shotClockSeconds: number;
}

export interface BasketballState {
  score: [number, number];
  periodIdx: number; // 0-based; >= periods means overtime
  inPeriod: boolean;
  periodScores: [number, number][];
  clock: ClockState;
  teamFouls: [number, number];
  timeouts: [number, number];
  possession: PossessionState;
  t: Record<string, [number, number]>;
  p: Record<string, Record<string, number>>;
  fouledOut: string[];
  otStartScore: [number, number] | null;
  awaiting: 'tipoff' | 'next-period' | 'overtime' | null;
  done: boolean;
  winner: Side | null;
}

const T = ['fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf'];

const periodLabel = (i: number, c: BasketballConfig) =>
  i < c.periods ? (c.periods === 4 ? `Q${i + 1}` : c.periods === 1 ? 'GAME' : `P${i + 1}`) : `OT${i - c.periods + 1 > 1 ? i - c.periods + 1 : ''}`;
const periodMs = (i: number, c: BasketballConfig) => (i < c.periods ? c.periodMinutes : c.overtimeMinutes) * 60000;

function finish(s: BasketballState, w: Side) {
  s.done = true;
  s.winner = w;
  s.inPeriod = false;
  s.awaiting = null;
}

export const basketball: SportRuleEngine<BasketballState> = {
  id: 'basketball',
  name: 'Basketball',
  family: 'timed',
  disciplines: [
    { id: '5x5', name: '5x5 (4 × 10 min)', sideSize: 5, defaults: { periods: 4, periodMinutes: 10, overtimeMinutes: 5, bonusFoul: 5, foulOut: 5, timeoutsPerGame: 5, targetScore: null, overtimeTarget: null, arcValue: 3, shotClockSeconds: 24 } },
    { id: '5x5-12min', name: '5x5 (4 × 12 min)', sideSize: 5, defaults: { periods: 4, periodMinutes: 12, overtimeMinutes: 5, bonusFoul: 5, foulOut: 6, timeoutsPerGame: 7, targetScore: null, overtimeTarget: null, arcValue: 3, shotClockSeconds: 24 } },
    { id: '3x3', name: '3x3 (10 min, first to 21)', sideSize: 3, defaults: { periods: 1, periodMinutes: 10, overtimeMinutes: 0, bonusFoul: 7, foulOut: 99, timeoutsPerGame: 1, targetScore: 21, overtimeTarget: 2, arcValue: 2, shotClockSeconds: 12 } },
  ],
  standings: { win: 2, draw: 0, loss: 1, tieBreakers: ['wins', 'headToHead', 'pointsDiff', 'pointsFor'], forLabel: 'Points' },
  eventTypes: ['PERIOD_START', 'PERIOD_END', 'CLOCK_STOP', 'CLOCK_START', 'SCORE', 'MISS', 'FOUL', 'TIMEOUT', 'SUBSTITUTION', 'REBOUND', 'STEAL', 'BLOCK', 'TURNOVER', 'POSSESSION'],

  initializeMatch() {
    return {
      score: [0, 0], periodIdx: -1, inPeriod: false, periodScores: [], clock: newClock(), teamFouls: [0, 0], timeouts: [0, 0],
      possession: newPossession(), t: Object.fromEntries(T.map((k) => [k, [0, 0]])) as any, p: {}, fouledOut: [], otStartScore: null,
      awaiting: 'tipoff', done: false, winner: null,
    };
  },

  validateEvent(s, e, ctx) {
    const c = ctx.config as BasketballConfig;
    if (s.done) return fail('Game is over');
    const side = e.payload?.side;
    switch (e.type) {
      case 'PERIOD_START':
        return s.inPeriod ? fail('Period already running') : ok;
      case 'PERIOD_END':
        if (!s.inPeriod) return fail('No period running');
        return ok;
      case 'CLOCK_STOP':
        return s.inPeriod && s.clock.running ? ok : fail('Clock is not running');
      case 'CLOCK_START':
        return s.inPeriod && !s.clock.running ? ok : fail('Clock is already running or period not started');
    }
    if (!isSide(side)) return fail('side required');
    if (!s.inPeriod && e.type !== 'SUBSTITUTION' && e.type !== 'TIMEOUT') return fail('Period has not started');
    const pid: string | undefined = e.payload.player;
    if (pid) {
      const pl = findPlayer(ctx, pid);
      if (pl && pl.side !== side) return fail('Player is on the other team');
      if (s.fouledOut.includes(pid) && e.type !== 'SUBSTITUTION') return fail(`${playerName(ctx, pid)} has fouled out`);
    }
    if (e.type === 'SCORE' || e.type === 'MISS') {
      const pts = e.payload.points;
      const allowed = [1, 2, c.arcValue];
      if (!allowed.includes(pts)) return fail(`points must be one of ${[...new Set(allowed)].join(', ')}`);
    }
    if (e.type === 'TIMEOUT' && s.timeouts[side] >= c.timeoutsPerGame) return fail('No timeouts remaining');
    return ok;
  },

  applyEvent(prev, e, ctx) {
    const c = ctx.config as BasketballConfig;
    const s = clone(prev);
    const at = eventTime(e);
    const side: Side = e.payload?.side;
    const pid: string | undefined = e.payload?.player;
    const ps = (id: string) => (s.p[id] ??= {});
    // A shot from beyond the arc: 3 in 5x5, 2 in 3x3 (where a 1-pointer can be a field goal).
    const arc = (pts: number) => pts > 1 && pts === c.arcValue;
    switch (e.type) {
      case 'PERIOD_START': {
        s.periodIdx++;
        s.inPeriod = true;
        s.awaiting = null;
        s.clock = clockStart(newClock(), e);
        s.periodScores[s.periodIdx] = [0, 0];
        // FIBA: fouls in overtime carry over from the last regular period.
        if (s.periodIdx < c.periods) s.teamFouls = [0, 0];
        if (s.periodIdx >= c.periods && !s.otStartScore) s.otStartScore = [...s.score];
        break;
      }
      case 'PERIOD_END': {
        s.inPeriod = false;
        s.clock = clockStop(s.clock, e);
        s.possession = possessionSwitch(s.possession, null, at);
        const regulationOver = s.periodIdx >= c.periods - 1;
        if (!regulationOver) s.awaiting = 'next-period';
        else if (s.score[0] !== s.score[1]) finish(s, s.score[0] > s.score[1] ? 0 : 1);
        else s.awaiting = 'overtime';
        break;
      }
      case 'CLOCK_STOP':
        s.clock = clockStop(s.clock, e);
        break;
      case 'CLOCK_START':
        s.clock = clockStart(s.clock, e);
        break;
      case 'SCORE': {
        const pts: number = e.payload.points;
        s.score[side] += pts;
        s.periodScores[s.periodIdx][side] += pts;
        if (pts === 1 && !e.payload.fieldGoal) {
          s.t.ftm[side]++;
          s.t.fta[side]++;
          if (pid) (bump(ps(pid), 'ftm'), bump(ps(pid), 'fta'));
        } else {
          s.t.fgm[side]++;
          s.t.fga[side]++;
          if (pid) (bump(ps(pid), 'fgm'), bump(ps(pid), 'fga'));
          if (arc(pts)) {
            s.t.tpm[side]++;
            s.t.tpa[side]++;
            if (pid) (bump(ps(pid), 'tpm'), bump(ps(pid), 'tpa'));
          }
        }
        if (pid) bump(ps(pid), 'pts', pts);
        if (e.payload.assist) {
          s.t.ast[side]++;
          bump(ps(e.payload.assist), 'ast');
        }
        s.possession = possessionSwitch(s.possession, other(side), at);
        if (c.targetScore && s.score[side] >= c.targetScore) finish(s, side);
        else if (c.overtimeTarget && s.otStartScore && s.score[side] - s.otStartScore[side] >= c.overtimeTarget) finish(s, side);
        break;
      }
      case 'MISS': {
        const pts: number = e.payload.points;
        if (pts === 1 && !e.payload.fieldGoal) {
          s.t.fta[side]++;
          if (pid) bump(ps(pid), 'fta');
        } else {
          s.t.fga[side]++;
          if (pid) bump(ps(pid), 'fga');
          if (arc(pts)) {
            s.t.tpa[side]++;
            if (pid) bump(ps(pid), 'tpa');
          }
        }
        break;
      }
      case 'FOUL':
        s.t.pf[side]++;
        s.teamFouls[side]++;
        if (pid) {
          bump(ps(pid), 'pf');
          if (ps(pid).pf >= c.foulOut) s.fouledOut.push(pid);
        }
        break;
      case 'TIMEOUT':
        s.timeouts[side]++;
        s.clock = clockStop(s.clock, e);
        break;
      case 'REBOUND':
        s.t[e.payload.offensive ? 'oreb' : 'dreb'][side]++;
        if (pid) bump(ps(pid), e.payload.offensive ? 'oreb' : 'dreb');
        s.possession = possessionSwitch(s.possession, side, at);
        break;
      case 'STEAL':
        s.t.stl[side]++;
        if (pid) bump(ps(pid), 'stl');
        s.t.tov[other(side)]++;
        s.possession = possessionSwitch(s.possession, side, at);
        break;
      case 'BLOCK':
        s.t.blk[side]++;
        if (pid) bump(ps(pid), 'blk');
        break;
      case 'TURNOVER':
        s.t.tov[side]++;
        if (pid) bump(ps(pid), 'tov');
        s.possession = possessionSwitch(s.possession, other(side), at);
        break;
      case 'POSSESSION':
        s.possession = possessionSwitch(s.possession, side, at);
        break;
    }
    return s;
  },

  calculateScore(s) {
    return { text: [String(s.score[0]), String(s.score[1])], primary: [...s.score] as [number, number], extra: { pointsFor: [...s.score] } };
  },

  calculateStatistics(s, _ev, ctx) {
    const t = s.t;
    const both = (f: (i: Side) => string | number) => [f(0), f(1)] as [string | number, string | number];
    const team = [
      { key: 'fg', label: 'Field goals', values: both((i) => `${t.fgm[i]}/${t.fga[i]} (${pct(t.fgm[i], t.fga[i])})`) },
      { key: '3pt', label: 'From the arc', values: both((i) => `${t.tpm[i]}/${t.tpa[i]} (${pct(t.tpm[i], t.tpa[i])})`) },
      { key: 'ft', label: 'Free throws', values: both((i) => `${t.ftm[i]}/${t.fta[i]} (${pct(t.ftm[i], t.fta[i])})`) },
      { key: 'reb', label: 'Rebounds', values: both((i) => t.oreb[i] + t.dreb[i]) },
      { key: 'oreb', label: 'Offensive rebounds', values: [...t.oreb] as any },
      { key: 'ast', label: 'Assists', values: [...t.ast] as any },
      { key: 'stl', label: 'Steals', values: [...t.stl] as any },
      { key: 'blk', label: 'Blocks', values: [...t.blk] as any },
      { key: 'tov', label: 'Turnovers', values: [...t.tov] as any },
      { key: 'pf', label: 'Fouls', values: [...t.pf] as any },
      { key: 'timeouts', label: 'Timeouts used', values: [...s.timeouts] as any },
    ];
    const pm = s.possession.ms;
    if (pm[0] + pm[1] > 0) team.push({ key: 'possession', label: 'Possession', values: [pct(pm[0], pm[0] + pm[1]), pct(pm[1], pm[0] + pm[1])] });
    const players = Object.entries(s.p).map(([id, st]) => ({
      playerId: id, name: playerName(ctx, id), side: (findPlayer(ctx, id)?.side ?? 0) as Side,
      stats: { pts: 0, reb: (st.oreb ?? 0) + (st.dreb ?? 0), ...st },
    }));
    return { team, players };
  },

  determineWinner: (s) => s.winner,
  isMatchComplete: (s) => s.done,
  getCurrentState: (s) => s,

  getDisplayState(s, ctx) {
    const c = ctx.config as BasketballConfig;
    const idx = Math.max(0, s.periodIdx);
    const phase = s.done ? (s.periodIdx >= c.periods ? 'FINAL / OT' : 'FINAL') : s.awaiting === 'tipoff' ? 'TIP-OFF' : s.inPeriod ? periodLabel(idx, c) : s.awaiting === 'overtime' ? 'OVERTIME NEXT' : `END ${periodLabel(idx, c)}`;
    const bonus = (i: Side) => s.teamFouls[other(i)] >= c.bonusFoul - 1;
    return {
      phase,
      clock: s.periodIdx >= 0 && !s.done ? clockDisplay(s.clock, periodMs(idx, c), 'down') : undefined,
      sides: ([0, 1] as Side[]).map((i) => ({
        name: ctx.match.participants[i].name,
        score: String(s.score[i]),
        detail: [`Fouls ${s.teamFouls[i]}`, `T.O. ${c.timeoutsPerGame - s.timeouts[i]}`],
        badges: !s.done && bonus(i) ? ['BONUS'] : undefined,
        serving: !s.done && s.possession.side === i,
      })) as any,
      periods: s.periodScores.length
        ? { labels: s.periodScores.map((_, i) => periodLabel(i, c)), rows: [s.periodScores.map((x) => String(x[0])), s.periodScores.map((x) => String(x[1]))] }
        : undefined,
      headline: c.targetScore && !s.done ? `FIRST TO ${c.targetScore}` : undefined,
      winner: s.winner,
      resultText: s.done && s.winner != null ? `${ctx.match.participants[s.winner].name} won ${s.score[s.winner]}–${s.score[other(s.winner)]}${s.periodIdx >= c.periods ? ' (OT)' : ''}` : undefined,
    };
  },

  getActions(s, ctx) {
    const c = ctx.config as BasketballConfig;
    const acts: ScorerAction[] = [];
    if (!s.inPeriod) {
      const next = s.periodIdx + 1;
      acts.push({ id: 'period-start', label: `Start ${periodLabel(next, c)}`, type: 'PERIOD_START', group: 'control', tone: 'positive' });
    } else {
      acts.push({ id: 'period-end', label: `End ${periodLabel(s.periodIdx, c)}`, type: 'PERIOD_END', group: 'control' });
      acts.push(s.clock.running
        ? { id: 'clock-stop', label: `Stop clock (${fmtClock(Math.max(0, periodMs(s.periodIdx, c) - s.clock.bankedMs))})`, type: 'CLOCK_STOP', group: 'control' }
        : { id: 'clock-start', label: 'Start clock', type: 'CLOCK_START', group: 'control', tone: 'positive' });
    }
    const pl = (side: Side, key = 'player', label = 'Player'): ActionInput => ({ key, label, kind: 'player', side, optional: true, options: playerOptions(ctx, side, (id) => !s.fouledOut.includes(id)) });
    const values = [...new Set([1, 2, c.arcValue])].sort();
    for (const side of [0, 1] as Side[]) {
      const sn = shortName(ctx, side);
      for (const v of values) {
        acts.push({ id: `score-${v}-${side}`, label: `+${v} ${sn}`, type: 'SCORE', payload: { side, points: v }, side, group: 'primary', tone: 'positive', inputs: [pl(side), ...(v > 1 ? [pl(side, 'assist', 'Assist')] : [])] });
        acts.push({ id: `miss-${v}-${side}`, label: `Miss ${v === 1 ? 'FT' : `${v}PT`} ${sn}`, type: 'MISS', payload: { side, points: v }, side, group: 'stat', inputs: [pl(side)] });
      }
      acts.push({ id: `foul-${side}`, label: `Foul ${sn}`, type: 'FOUL', payload: { side }, side, group: 'secondary', inputs: [pl(side)] });
      acts.push({ id: `to-${side}`, label: `Timeout ${sn}`, type: 'TIMEOUT', payload: { side }, side, group: 'secondary' });
      acts.push({ id: `dreb-${side}`, label: `Def. rebound ${sn}`, type: 'REBOUND', payload: { side, offensive: false }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `oreb-${side}`, label: `Off. rebound ${sn}`, type: 'REBOUND', payload: { side, offensive: true }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `stl-${side}`, label: `Steal ${sn}`, type: 'STEAL', payload: { side }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `blk-${side}`, label: `Block ${sn}`, type: 'BLOCK', payload: { side }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `tov-${side}`, label: `Turnover ${sn}`, type: 'TURNOVER', payload: { side }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `sub-${side}`, label: `Sub ${sn}`, type: 'SUBSTITUTION', payload: { side }, side, group: 'secondary', inputs: [pl(side, 'playerIn', 'In'), pl(side, 'playerOut', 'Out')] });
    }
    return acts;
  },

  describeEvent(e, before, ctx) {
    const c = ctx.config as BasketballConfig;
    const n = (i: Side) => ctx.match.participants[i].name;
    const who = e.payload?.player ? playerName(ctx, e.payload.player) : '';
    switch (e.type) {
      case 'PERIOD_START':
        return `Start of ${periodLabel(before.periodIdx + 1, c)}`;
      case 'PERIOD_END':
        return `End of ${periodLabel(before.periodIdx, c)} · ${before.score[0]}–${before.score[1]}`;
      case 'SCORE': {
        const sc: [number, number] = [...before.score];
        sc[e.payload.side as Side] += e.payload.points;
        const kind = e.payload.points === 1 ? 'Free throw' : e.payload.points === c.arcValue && c.arcValue > 2 ? 'Three-pointer!' : e.payload.points === c.arcValue && c.arcValue === 2 ? 'From downtown!' : 'Basket';
        return `${kind} ${who ? `${who} (${shortName(ctx, e.payload.side)})` : n(e.payload.side)} · ${sc[0]}–${sc[1]}`;
      }
      case 'FOUL': {
        const fo = e.payload.player && (before.p[e.payload.player]?.pf ?? 0) + 1 >= c.foulOut;
        return `Foul ${who || n(e.payload.side)}${fo ? ' — fouled out' : ''} (team fouls ${before.teamFouls[e.payload.side as Side] + 1})`;
      }
      case 'TIMEOUT':
        return `Timeout ${n(e.payload.side)}`;
      case 'STEAL':
        return `Steal${who ? ` by ${who}` : ''} (${shortName(ctx, e.payload.side)})`;
      case 'BLOCK':
        return `Block${who ? ` by ${who}` : ''} (${shortName(ctx, e.payload.side)})`;
    }
    return null;
  },
};
