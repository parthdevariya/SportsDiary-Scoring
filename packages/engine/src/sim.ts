/**
 * Match simulator: plays a match using only the actions the engine offers the scorer,
 * filling inputs the way a scorer would. Used for demo data and as a fuzz test —
 * if any engine can reach a state with no legal way forward, this finds it.
 */
import type { MatchAggregate } from './core/aggregate.ts';
import type { EventInput, ScorerAction } from './core/types.ts';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKIP = new Set(['MATCH_ABANDON', 'MATCH_PAUSE', 'DECLARE_RESULT', 'REVISED_TARGET', 'COMMENT', 'REVIEW', 'RETIRE', 'PENALTY_RUNS', 'SET_SERVER', 'SWAP_STRIKE', 'TIME_CALLED']);

function fill(a: ScorerAction, r: () => number, used: Set<string>): EventInput {
  const payload: any = JSON.parse(JSON.stringify(a.payload ?? {}));
  for (const inp of a.inputs ?? []) {
    if (inp.optional && r() < 0.6) continue;
    let v: any;
    if (inp.options?.length) {
      const fresh = inp.options.filter((o) => !used.has(o.value));
      const pool = inp.kind === 'player' && a.type !== 'NEW_BOWLER' && fresh.length ? fresh : inp.options;
      v = inp.key === 'wicket.playerOut' ? (inp.default ?? pool[0].value) : pool[Math.floor(r() * pool.length)].value;
      if (inp.key === 'wicket.kind') v = ['bowled', 'caught', 'lbw', 'run_out', 'stumped'][Math.floor(r() * 5)];
      if (inp.key === 'extra') continue;
    } else if (inp.kind === 'number') v = inp.default ?? 1;
    else if (inp.kind === 'player') v = `Player ${Math.floor(r() * 9000) + 1000}`;
    else v = 'note';
    if (/^\d+$/.test(String(v)) && inp.kind !== 'text') v = Number(v);
    const parts = inp.key.split('.');
    let o = payload;
    parts.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
    o[parts[parts.length - 1]] = v;
  }
  // cricket openers/new batters must be different people
  for (const k of ['striker', 'nonStriker', 'player']) if (typeof payload[k] === 'string' && a.type !== 'NEW_BOWLER') used.add(payload[k]);
  return { type: a.type, payload };
}

export interface SimOptions {
  seed?: number;
  /** Bias toward side 0 winning points (0.5 = even). */
  bias?: number;
  maxSteps?: number;
  /** Stop when this many sport events were applied (for "in progress" demo matches). */
  stopAfter?: number;
  /** Simulated time between events (ms) for clocks/possession. */
  stepMs?: number;
  startAt?: number;
}

export function simulate(m: MatchAggregate, opts: SimOptions = {}): { steps: number; stuck: string | null } {
  const r = rng(opts.seed ?? 1);
  const bias = opts.bias ?? 0.5;
  const maxSteps = opts.maxSteps ?? 6000;
  let now = opts.startAt ?? Date.parse('2026-10-06T09:00:00Z');
  const used = new Set<string>();
  let periodEvents = 0;
  let steps = 0;
  const at = () => new Date((now += (opts.stepMs ?? 20000) * (0.5 + r()))).toISOString();
  if (m.status === 'scheduled') m.record({ type: 'MATCH_START', deviceTime: at() }, at());
  while (m.status === 'live' && steps < maxSteps) {
    if (opts.stopAfter != null && m.applied.length >= opts.stopAfter) break;
    steps++;
    const acts = m.actions().filter((a) => !SKIP.has(a.type));
    if (!acts.length) return { steps, stuck: 'no actions' };
    let pick: ScorerAction | undefined;
    const ctl = (type: string) => acts.find((a) => a.type === type);
    // Timed sports: end periods after a reasonable number of events.
    const periodEnd = ctl('PERIOD_END');
    if (periodEnd && periodEvents > 12 + r() * 25) {
      pick = periodEnd;
      periodEvents = 0;
    }
    // Timed formats (e.g. timed billiards) end when the referee calls time.
    if (!pick && steps > 150 && r() < 0.05) pick = m.actions().find((a) => a.type === 'TIME_CALLED');
    pick ??= ctl('PERIOD_START') ?? ctl('INNINGS_START') ?? ctl('NEW_BATTER') ?? ctl('NEW_BOWLER') ?? ctl('TOSS') ?? ctl('CLOCK_START');
    if (!pick) {
      const primary = acts.filter((a) => a.group === 'primary');
      const sided = primary.filter((a) => a.side != null);
      if (sided.length && r() < 0.85) {
        const side = r() < bias ? 0 : 1;
        const mine = sided.filter((a) => a.side === side);
        pick = mine[Math.floor(r() * mine.length)];
      } else if (m.engine.id === 'cricket') {
        // realistic ball distribution: mostly 0/1, some boundaries, rare wickets/extras
        const x = r();
        const id = x < 0.35 ? 'runs-0' : x < 0.65 ? 'runs-1' : x < 0.75 ? 'runs-2' : x < 0.84 ? 'runs-4' : x < 0.89 ? 'runs-6' : x < 0.93 ? 'wide' : x < 0.945 ? 'noball' : x < 0.955 ? 'legbye' : 'wicket';
        pick = acts.find((a) => a.id === id) ?? primary[0];
      } else {
        const pool = r() < 0.8 && primary.length ? primary : acts.filter((a) => a.group !== 'control');
        pick = pool[Math.floor(r() * pool.length)] ?? acts[0];
      }
    }
    const input = fill(pick, r, used);
    try {
      const t = at();
      m.record({ ...input, deviceTime: t }, t);
      periodEvents++;
    } catch {
      /* the engine refused this random choice — exactly what it should do; try again */
    }
  }
  return { steps, stuck: m.status === 'live' && steps >= maxSteps ? 'max steps' : null };
}
