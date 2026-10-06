/**
 * Football (soccer): configurable team size and period length, extra time and penalty
 * shoot-out for knockout ties, cards (2nd yellow => red), substitutions, VAR review log,
 * time-weighted possession and full team/player statistics.
 */
import type { ActionInput, EngineContext, MatchEvent, ScorerAction, Side, SportRuleEngine } from '../core/types.ts';
import { other } from '../core/types.ts';
import { bump, clone, eventTime, fail, findPlayer, isSide, ok, pair, pct, playerName, playerOptions, shortName } from '../core/util.ts';
import { clockDisplay, clockElapsedAt, clockStart, clockStop, newClock, newPossession, possessionSwitch, type ClockState, type PossessionState } from '../core/clock.ts';

export interface FootballConfig {
  periods: number;
  periodMinutes: number;
  /** Knockout: a winner is required (extra time / shoot-out if level). */
  knockout: boolean;
  extraTime: boolean;
  extraTimeMinutes: number;
  shootout: boolean;
  shootoutKicks: number;
  maxSubstitutions: number | null;
  playersPerSide: number;
}

interface Period {
  key: string;
  label: string;
  minutes: number;
  offset: number; // minutes elapsed before this period (for match-minute display)
  kind: 'regular' | 'extra';
}

export interface FootballState {
  goals: [number, number];
  periodIdx: number; // index into plan of the current/last period, -1 before kickoff
  inPlay: boolean;
  plan: Period[];
  periodGoals: [number, number][];
  clock: ClockState;
  possession: PossessionState;
  t: Record<string, [number, number]>; // team stats
  p: Record<string, Record<string, number>>; // player stats
  yellow: Record<string, number>;
  sentOff: string[];
  subs: [number, number];
  shootout: { kicks: [boolean[], boolean[]]; first: Side | null } | null;
  awaiting: 'kickoff' | 'next-period' | 'extra-time' | 'shootout' | null;
  winner: Side | null;
  done: boolean;
  scorers: { side: Side; text: string }[];
}

function buildPlan(c: FootballConfig): Period[] {
  const out: Period[] = [];
  let off = 0;
  const names = c.periods === 2 ? ['1ST HALF', '2ND HALF'] : Array.from({ length: c.periods }, (_, i) => `PERIOD ${i + 1}`);
  for (let i = 0; i < c.periods; i++) {
    out.push({ key: c.periods === 2 ? `${i + 1}H` : `P${i + 1}`, label: names[i], minutes: c.periodMinutes, offset: off, kind: 'regular' });
    off += c.periodMinutes;
  }
  if (c.knockout && c.extraTime) {
    out.push({ key: 'ET1', label: 'EXTRA TIME 1', minutes: c.extraTimeMinutes, offset: off, kind: 'extra' });
    off += c.extraTimeMinutes;
    out.push({ key: 'ET2', label: 'EXTRA TIME 2', minutes: c.extraTimeMinutes, offset: off, kind: 'extra' });
  }
  return out;
}

function matchMinute(s: FootballState, atMs: number): string {
  const per = s.plan[Math.max(0, s.periodIdx)];
  if (!per) return '';
  const el = clockElapsedAt(s.clock, atMs);
  const m = Math.floor(el / 60000);
  if (m >= per.minutes) return `${per.offset + per.minutes}+${m - per.minutes + 1}'`;
  return `${per.offset + m + 1}'`;
}

function shootoutDecided(k: [boolean[], boolean[]], n: number): Side | null {
  const g = (i: Side) => k[i].filter(Boolean).length;
  const taken = (i: Side) => k[i].length;
  const a = g(0), b = g(1);
  if (taken(0) <= n && taken(1) <= n) {
    const remA = n - taken(0), remB = n - taken(1);
    if (a > b + remB) return 0;
    if (b > a + remA) return 1;
    return null;
  }
  // sudden death: equal number of kicks taken
  if (taken(0) === taken(1) && a !== b) return a > b ? 0 : 1;
  return null;
}

const TEAM_STATS = ['shots', 'shotsOnTarget', 'fouls', 'yellow', 'red', 'corners', 'offsides', 'saves', 'passes', 'passesCompleted', 'penaltiesMissed'];

export const football: SportRuleEngine<FootballState> = {
  id: 'football',
  name: 'Football',
  family: 'timed',
  disciplines: [
    { id: '11-a-side', name: '11-a-side', sideSize: 11, defaults: { periods: 2, periodMinutes: 45, knockout: false, extraTime: true, extraTimeMinutes: 15, shootout: true, shootoutKicks: 5, maxSubstitutions: 5, playersPerSide: 11 } },
    { id: '9-a-side', name: '9-a-side', sideSize: 9, defaults: { periods: 2, periodMinutes: 30, knockout: false, extraTime: false, extraTimeMinutes: 10, shootout: true, shootoutKicks: 5, maxSubstitutions: null, playersPerSide: 9 } },
    { id: '7-a-side', name: '7-a-side', sideSize: 7, defaults: { periods: 2, periodMinutes: 25, knockout: false, extraTime: false, extraTimeMinutes: 5, shootout: true, shootoutKicks: 3, maxSubstitutions: null, playersPerSide: 7 } },
    { id: '5-a-side', name: '5-a-side', sideSize: 5, defaults: { periods: 2, periodMinutes: 20, knockout: false, extraTime: false, extraTimeMinutes: 5, shootout: true, shootoutKicks: 3, maxSubstitutions: null, playersPerSide: 5 } },
    { id: '11-a-side-knockout', name: '11-a-side knockout (ET + penalties)', sideSize: 11, defaults: { periods: 2, periodMinutes: 45, knockout: true, extraTime: true, extraTimeMinutes: 15, shootout: true, shootoutKicks: 5, maxSubstitutions: 5, playersPerSide: 11 } },
  ],
  standings: { win: 3, draw: 1, loss: 0, tieBreakers: ['pointsDiff', 'pointsFor', 'headToHead', 'wins'], forLabel: 'Goals' },
  eventTypes: ['PERIOD_START', 'PERIOD_END', 'GOAL', 'PENALTY_MISS', 'CARD', 'SUBSTITUTION', 'FOUL', 'OFFSIDE', 'CORNER', 'SHOT', 'SAVE', 'PASS', 'POSSESSION', 'REVIEW', 'SHOOTOUT_KICK'],

  initializeMatch(ctx) {
    const c = ctx.config as FootballConfig;
    return {
      goals: [0, 0], periodIdx: -1, inPlay: false, plan: buildPlan(c), periodGoals: [], clock: newClock(), possession: newPossession(),
      t: Object.fromEntries(TEAM_STATS.map((k) => [k, [0, 0]])) as any, p: {}, yellow: {}, sentOff: [], subs: [0, 0],
      shootout: null, awaiting: 'kickoff', winner: null, done: false, scorers: [],
    };
  },

  validateEvent(s, e, ctx) {
    const c = ctx.config as FootballConfig;
    if (s.done) return fail('Match is complete');
    const side = e.payload?.side;
    switch (e.type) {
      case 'PERIOD_START':
        if (s.inPlay) return fail('A period is already in play');
        if (s.awaiting === 'shootout') return fail('Regulation and extra time are over — record shoot-out kicks');
        if (s.periodIdx + 1 >= s.plan.length) return fail('No further periods');
        return ok;
      case 'PERIOD_END':
        return s.inPlay ? ok : fail('No period in play');
      case 'SHOOTOUT_KICK': {
        if (s.awaiting !== 'shootout') return fail('Not in a penalty shoot-out');
        if (!isSide(side) || typeof e.payload.scored !== 'boolean') return fail('side and scored required');
        const k = s.shootout!.kicks;
        if (k[side].length > k[other(side)].length) return fail(`${shortName(ctx, other(side))} must take the next kick`);
        const first = s.shootout!.first;
        if (first != null && k[0].length === k[1].length && side !== first) return fail(`${shortName(ctx, first)} must take the next kick`);
        return ok;
      }
      case 'REVIEW':
        return ok;
    }
    if (!isSide(side)) return fail('side required');
    if (!s.inPlay && !['CARD', 'SUBSTITUTION'].includes(e.type)) return fail('Ball is not in play — start the period first');
    const pid: string | undefined = e.payload.player;
    if (pid && s.sentOff.includes(pid) && e.type !== 'CARD') return fail(`${playerName(ctx, pid)} has been sent off`);
    if (e.type === 'GOAL' && pid && !e.payload.ownGoal) {
      const pl = findPlayer(ctx, pid);
      if (pl && pl.side !== side) return fail('Scorer does not play for this team (use ownGoal)');
    }
    if (e.type === 'CARD' && !['yellow', 'red'].includes(e.payload.color)) return fail('color must be yellow or red');
    if (e.type === 'CARD' && pid && s.sentOff.includes(pid)) return fail('Player already sent off');
    if (e.type === 'SUBSTITUTION') {
      if (c.maxSubstitutions != null && s.subs[side] >= c.maxSubstitutions) return fail('Substitution limit reached');
      if (e.payload.playerOut && s.sentOff.includes(e.payload.playerOut)) return fail('A sent-off player cannot be substituted');
    }
    return ok;
  },

  applyEvent(prev, e, ctx) {
    const c = ctx.config as FootballConfig;
    const s = clone(prev);
    const at = eventTime(e);
    const side: Side = e.payload?.side;
    const pid: string | undefined = e.payload?.player;
    const ps = (id: string) => (s.p[id] ??= {});
    switch (e.type) {
      case 'PERIOD_START':
        s.periodIdx++;
        s.inPlay = true;
        s.awaiting = null;
        s.clock = clockStart(newClock(), e);
        s.periodGoals[s.periodIdx] = [0, 0];
        if (isSide(e.payload?.kickoff)) s.possession = possessionSwitch(s.possession, e.payload.kickoff, at);
        break;
      case 'PERIOD_END': {
        s.inPlay = false;
        s.clock = clockStop(s.clock, e);
        s.possession = possessionSwitch(s.possession, null, at);
        const lastRegular = s.plan.filter((p) => p.kind === 'regular').length - 1;
        const level = s.goals[0] === s.goals[1];
        if (s.periodIdx < lastRegular) s.awaiting = 'next-period';
        else if (s.periodIdx === lastRegular) {
          if (c.knockout && level && c.extraTime) s.awaiting = 'extra-time';
          else if (c.knockout && level && c.shootout) {
            s.awaiting = 'shootout';
            s.shootout = { kicks: [[], []], first: null };
          } else s.done = true;
        } else if (s.periodIdx < s.plan.length - 1) s.awaiting = 'next-period';
        else if (level && c.shootout) {
          s.awaiting = 'shootout';
          s.shootout = { kicks: [[], []], first: null };
        } else s.done = true;
        if (s.done) s.winner = level ? null : s.goals[0] > s.goals[1] ? 0 : 1;
        break;
      }
      case 'GOAL':
        s.goals[side]++;
        s.periodGoals[s.periodIdx][side]++;
        s.t.shots[side]++;
        s.t.shotsOnTarget[side]++;
        if (pid) bump(ps(pid), e.payload.ownGoal ? 'ownGoals' : 'goals');
        if (pid && !e.payload.ownGoal) {
          bump(ps(pid), 'shots');
          bump(ps(pid), 'shotsOnTarget');
        }
        if (e.payload.assist) bump(ps(e.payload.assist), 'assists');
        if (pid) s.scorers.push({ side, text: `${playerName(ctx, pid)} ${matchMinute(prev, at)}${e.payload.penalty ? ' (P)' : ''}${e.payload.ownGoal ? ' (OG)' : ''}` });
        s.possession = possessionSwitch(s.possession, other(side), at);
        break;
      case 'PENALTY_MISS':
        s.t.penaltiesMissed[side]++;
        s.t.shots[side]++;
        if (e.payload.saved) s.t.saves[other(side)]++;
        if (pid) bump(ps(pid), 'penaltiesMissed');
        break;
      case 'CARD': {
        if (e.payload.color === 'yellow') {
          s.t.yellow[side]++;
          if (pid) {
            s.yellow[pid] = (s.yellow[pid] ?? 0) + 1;
            bump(ps(pid), 'yellow');
            if (s.yellow[pid] >= 2) {
              s.t.red[side]++;
              s.sentOff.push(pid);
              bump(ps(pid), 'red');
            }
          }
        } else {
          s.t.red[side]++;
          if (pid) {
            s.sentOff.push(pid);
            bump(ps(pid), 'red');
          }
        }
        break;
      }
      case 'SUBSTITUTION':
        s.subs[side]++;
        break;
      case 'FOUL':
        s.t.fouls[side]++;
        if (pid) bump(ps(pid), 'fouls');
        break;
      case 'OFFSIDE':
        s.t.offsides[side]++;
        break;
      case 'CORNER':
        s.t.corners[side]++;
        break;
      case 'SHOT':
        s.t.shots[side]++;
        if (e.payload.onTarget) s.t.shotsOnTarget[side]++;
        if (pid) {
          bump(ps(pid), 'shots');
          if (e.payload.onTarget) bump(ps(pid), 'shotsOnTarget');
        }
        if (e.payload.onTarget && e.payload.saved !== false) s.t.saves[other(side)]++;
        break;
      case 'SAVE':
        s.t.saves[side]++;
        if (pid) bump(ps(pid), 'saves');
        break;
      case 'PASS':
        s.t.passes[side] += e.payload.count ?? 1;
        if (e.payload.completed !== false) s.t.passesCompleted[side] += e.payload.count ?? 1;
        break;
      case 'POSSESSION':
        if (s.inPlay) s.possession = possessionSwitch(s.possession, side, at);
        break;
      case 'SHOOTOUT_KICK': {
        s.shootout!.first ??= side;
        s.shootout!.kicks[side].push(!!e.payload.scored);
        const w = shootoutDecided(s.shootout!.kicks, c.shootoutKicks);
        if (w != null) {
          s.winner = w;
          s.done = true;
          s.awaiting = null;
        }
        break;
      }
    }
    return s;
  },

  calculateScore(s) {
    const pso = s.shootout ? s.shootout.kicks.map((k) => k.filter(Boolean).length) : null;
    return {
      text: [String(s.goals[0]), String(s.goals[1])],
      primary: [...s.goals] as [number, number],
      extra: { pointsFor: [...s.goals], shootout: pso },
    };
  },

  calculateStatistics(s, _events, ctx) {
    const poss = s.possession.ms;
    const total = poss[0] + poss[1];
    const L: Record<string, string> = {
      shots: 'Shots', shotsOnTarget: 'Shots on target', corners: 'Corners', fouls: 'Fouls', yellow: 'Yellow cards', red: 'Red cards',
      offsides: 'Offsides', saves: 'Saves', passes: 'Passes', penaltiesMissed: 'Penalties missed',
    };
    const team = [
      { key: 'possession', label: 'Possession', values: total ? [pct(poss[0], total), pct(poss[1], total)] : ['–', '–'] },
      ...Object.keys(L).filter((k) => k !== 'passes' || s.t.passes[0] + s.t.passes[1] > 0).map((k) => ({ key: k, label: L[k], values: [...s.t[k]] })),
    ] as any;
    if (s.t.passes[0] + s.t.passes[1] > 0)
      team.push({ key: 'passAccuracy', label: 'Pass accuracy', values: [pct(s.t.passesCompleted[0], s.t.passes[0]), pct(s.t.passesCompleted[1], s.t.passes[1])] });
    const players = Object.entries(s.p).map(([id, st]) => ({ playerId: id, name: playerName(ctx, id), side: (findPlayer(ctx, id)?.side ?? 0) as Side, stats: st }));
    return { team, players, detail: { scorers: s.scorers, shootout: s.shootout } };
  },

  determineWinner: (s) => s.winner,
  isMatchComplete: (s) => s.done,
  getCurrentState: (s) => s,

  getDisplayState(s, ctx) {
    const c = ctx.config as FootballConfig;
    const per = s.plan[s.periodIdx];
    let phase = 'KICK-OFF';
    if (s.done) phase = s.shootout ? 'FT · PENS' : s.periodIdx >= c.periods ? 'AET' : 'FULL TIME';
    else if (s.awaiting === 'shootout') phase = 'PENALTIES';
    else if (s.inPlay && per) phase = per.label;
    else if (s.awaiting === 'next-period') phase = s.periodIdx === 0 && c.periods === 2 ? 'HALF TIME' : 'BREAK';
    else if (s.awaiting === 'extra-time') phase = 'END OF NORMAL TIME';
    const pso = s.shootout?.kicks;
    const sides = ([0, 1] as Side[]).map((i) => ({
      name: ctx.match.participants[i].name,
      score: String(s.goals[i]),
      detail: [
        ...(s.t.red[i] ? [`${'■'.repeat(Math.min(3, s.t.red[i]))} RED`] : []),
        ...s.scorers.filter((x) => x.side === i).slice(-3).map((x) => x.text),
      ],
      badges: pso ? [pso[i].map((k) => (k ? '●' : '○')).join(''), `PENS ${pso[i].filter(Boolean).length}`] : undefined,
    }));
    const winnerName = s.winner != null ? ctx.match.participants[s.winner].name : null;
    return {
      phase,
      clock: s.periodIdx >= 0 && !s.done ? { ...clockDisplay(s.clock, per ? per.minutes * 60000 : undefined, 'up'), elapsedMs: s.clock.bankedMs + (per ? per.offset * 60000 : 0) } : undefined,
      sides: sides as any,
      periods: s.periodGoals.length
        ? { labels: s.plan.slice(0, s.periodGoals.length).map((p) => p.key), rows: [s.periodGoals.map((g) => String(g[0])), s.periodGoals.map((g) => String(g[1]))] }
        : undefined,
      headline: s.awaiting === 'shootout' && pso ? `SHOOT-OUT ${pso[0].filter(Boolean).length}–${pso[1].filter(Boolean).length}` : undefined,
      winner: s.winner,
      resultText: s.done
        ? winnerName
          ? `${winnerName} won ${Math.max(...s.goals)}–${Math.min(...s.goals)}${pso ? ` (${pso[s.winner!].filter(Boolean).length}–${pso[other(s.winner!)].filter(Boolean).length} pens)` : s.periodIdx >= c.periods ? ' a.e.t.' : ''}`
          : `Draw ${s.goals[0]}–${s.goals[1]}`
        : undefined,
    };
  },

  getActions(s, ctx) {
    const c = ctx.config as FootballConfig;
    const acts: ScorerAction[] = [];
    const pl = (side: Side, key = 'player', label = 'Player', optional = true): ActionInput => ({
      key, label, kind: 'player', side, optional, options: playerOptions(ctx, side, (id) => !s.sentOff.includes(id)),
    });
    if (s.awaiting === 'shootout') {
      for (const side of [0, 1] as Side[]) {
        acts.push({ id: `pso-goal-${side}`, label: `${shortName(ctx, side)} scores`, type: 'SHOOTOUT_KICK', payload: { side, scored: true }, side, group: 'primary', tone: 'positive', inputs: [pl(side)] });
        acts.push({ id: `pso-miss-${side}`, label: `${shortName(ctx, side)} misses`, type: 'SHOOTOUT_KICK', payload: { side, scored: false }, side, group: 'primary', tone: 'negative', inputs: [pl(side)] });
      }
      return acts;
    }
    if (!s.inPlay) {
      const next = s.plan[s.periodIdx + 1];
      if (next) acts.push({ id: 'period-start', label: `Start ${next.label.toLowerCase()}`, type: 'PERIOD_START', group: 'control', tone: 'positive' });
    } else {
      const per = s.plan[s.periodIdx];
      acts.push({ id: 'period-end', label: `End ${per.label.toLowerCase()}`, type: 'PERIOD_END', group: 'control' });
    }
    for (const side of [0, 1] as Side[]) {
      const sn = shortName(ctx, side);
      acts.push({
        id: `goal-${side}`, label: `GOAL ${sn}`, type: 'GOAL', payload: { side }, side, group: 'primary', tone: 'positive',
        inputs: [pl(side, 'player', 'Scorer'), pl(side, 'assist', 'Assist'),
          { key: 'penalty', label: 'Penalty', kind: 'select', optional: true, options: [{ value: 'true', label: 'Penalty kick' }] }],
      });
      acts.push({ id: `og-${side}`, label: `Own goal (for ${sn})`, type: 'GOAL', payload: { side, ownGoal: true }, side, group: 'secondary', inputs: [pl(other(side), 'player', 'Player (scored own goal)')] });
      acts.push({ id: `shot-on-${side}`, label: `Shot on target ${sn}`, type: 'SHOT', payload: { side, onTarget: true }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `shot-off-${side}`, label: `Shot off target ${sn}`, type: 'SHOT', payload: { side, onTarget: false }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `corner-${side}`, label: `Corner ${sn}`, type: 'CORNER', payload: { side }, side, group: 'stat' });
      acts.push({ id: `foul-${side}`, label: `Foul ${sn}`, type: 'FOUL', payload: { side }, side, group: 'stat', inputs: [pl(side)] });
      acts.push({ id: `offside-${side}`, label: `Offside ${sn}`, type: 'OFFSIDE', payload: { side }, side, group: 'stat' });
      acts.push({ id: `poss-${side}`, label: `${sn} in possession`, type: 'POSSESSION', payload: { side }, side, group: 'stat' });
      acts.push({ id: `yc-${side}`, label: `Yellow ${sn}`, type: 'CARD', payload: { side, color: 'yellow' }, side, group: 'secondary', inputs: [pl(side, 'player', 'Player', false)] });
      acts.push({ id: `rc-${side}`, label: `Red ${sn}`, type: 'CARD', payload: { side, color: 'red' }, side, group: 'secondary', tone: 'negative', inputs: [pl(side, 'player', 'Player', false)] });
      acts.push({ id: `pen-miss-${side}`, label: `Penalty missed ${sn}`, type: 'PENALTY_MISS', payload: { side }, side, group: 'secondary', inputs: [pl(side)] });
      acts.push({ id: `sub-${side}`, label: `Sub ${sn}`, type: 'SUBSTITUTION', payload: { side }, side, group: 'secondary', inputs: [pl(side, 'playerIn', 'On'), pl(side, 'playerOut', 'Off')] });
    }
    acts.push({ id: 'review', label: 'VAR / review', type: 'REVIEW', group: 'secondary', inputs: [
      { key: 'decision', label: 'Outcome', kind: 'select', options: ['goal stands', 'goal disallowed', 'penalty awarded', 'red card', 'no action'].map((v) => ({ value: v, label: v })) },
      { key: 'note', label: 'Note', kind: 'text', optional: true },
    ] });
    void c;
    return acts;
  },

  describeEvent(e, before, ctx) {
    const at = eventTime(e);
    const n = (i: Side) => ctx.match.participants[i].name;
    const min = matchMinute(before, at);
    const who = e.payload?.player ? playerName(ctx, e.payload.player) : '';
    switch (e.type) {
      case 'PERIOD_START':
        return `Kick-off: ${before.plan[before.periodIdx + 1]?.label.toLowerCase()}`;
      case 'PERIOD_END':
        return `End of ${before.plan[before.periodIdx]?.label.toLowerCase()} · ${before.goals[0]}–${before.goals[1]}`;
      case 'GOAL': {
        const g: [number, number] = [...before.goals];
        g[e.payload.side as Side]++;
        const ast = e.payload.assist ? `, assisted by ${playerName(ctx, e.payload.assist)}` : '';
        if (e.payload.ownGoal) return `${min} Own goal${who ? ` by ${who}` : ''} — ${n(e.payload.side)} benefit · ${g[0]}–${g[1]}`;
        return `${min} GOAL! ${who ? `${who} scores for ${n(e.payload.side)}` : n(e.payload.side)}${e.payload.penalty ? ' from the spot' : ''}${ast} · ${g[0]}–${g[1]}`;
      }
      case 'CARD': {
        const second = e.payload.color === 'yellow' && e.payload.player && (before.yellow[e.payload.player] ?? 0) >= 1;
        return `${min} ${second ? 'Second yellow — sent off' : e.payload.color === 'red' ? 'Red card' : 'Yellow card'}: ${who || n(e.payload.side)}`;
      }
      case 'SUBSTITUTION':
        return `${min} Substitution ${n(e.payload.side)}${e.payload.playerIn ? `: ${playerName(ctx, e.payload.playerIn)} on` : ''}${e.payload.playerOut ? ` for ${playerName(ctx, e.payload.playerOut)}` : ''}`;
      case 'PENALTY_MISS':
        return `${min} Penalty missed${who ? ` by ${who}` : ''} (${n(e.payload.side)})`;
      case 'REVIEW':
        return `${min} Review: ${e.payload.decision ?? 'checked'}${e.payload.note ? ` — ${e.payload.note}` : ''}`;
      case 'SHOOTOUT_KICK':
        return `Shoot-out: ${who || n(e.payload.side)} ${e.payload.scored ? 'scores' : 'misses'}`;
      case 'SHOT':
        return e.payload.onTarget ? `${min} Shot on target${who ? ` by ${who}` : ''} (${n(e.payload.side)})` : null;
    }
    return null;
  },
};

export type { Period };
void pair;
