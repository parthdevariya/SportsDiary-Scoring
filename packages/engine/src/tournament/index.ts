/**
 * Tournament engine (pure functions): fixtures, brackets, standings, scheduling.
 * Sport-agnostic: standings rules come from each sport's `standings` definition.
 */
import { getSport } from '../core/registry.ts';
import type { Side } from '../core/types.ts';

export interface Fixture {
  key: string;
  round: number;
  group?: string;
  home: string | null; // entrant id (null = TBD / bye)
  away: string | null;
  /** Knockout linkage: winner advances to this fixture's slot. */
  winnerTo?: { key: string; slot: 'home' | 'away' };
  label?: string;
}

/** Circle-method round robin. Odd entrant counts get a bye each round. */
export function roundRobin(entrants: string[], opts: { doubleRound?: boolean; group?: string } = {}): Fixture[] {
  const list: (string | null)[] = [...entrants];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = n - 1;
  const out: Fixture[] = [];
  const arr = [...list];
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a == null || b == null) continue;
      // alternate home/away for fairness
      const [home, away] = (r + i) % 2 === 0 ? [a, b] : [b, a];
      out.push({ key: `${opts.group ?? 'RR'}-R${r + 1}-${i + 1}`, round: r + 1, group: opts.group, home, away });
    }
    arr.splice(1, 0, arr.pop()!); // rotate all but first
  }
  if (opts.doubleRound) {
    const second = out.map((f) => ({ ...f, key: f.key.replace('-R', '-R2.'), round: f.round + rounds, home: f.away, away: f.home }));
    out.push(...second);
  }
  return out;
}

/** Split entrants into balanced groups by seed (snake order): A1 B1 C1 C2 B2 A2 ... */
export function makeGroups(entrants: string[], groupCount: number): Record<string, string[]> {
  const names = Array.from({ length: groupCount }, (_, i) => String.fromCharCode(65 + i));
  const groups: Record<string, string[]> = Object.fromEntries(names.map((n) => [n, []]));
  entrants.forEach((e, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    groups[names[row % 2 === 0 ? col : groupCount - 1 - col]].push(e);
  });
  return groups;
}

/** Standard seeding order for a bracket of size n (1 v n, 2 v n-1 placed apart). */
export function seedOrder(n: number): number[] {
  let order = [1];
  while (order.length < n) {
    const m = order.length * 2;
    order = order.flatMap((s) => [s, m + 1 - s]);
  }
  return order;
}

const roundName = (size: number) => (size === 2 ? 'Final' : size === 4 ? 'Semi-final' : size === 8 ? 'Quarter-final' : `Round of ${size}`);

/** Single-elimination bracket with byes for top seeds. Entrants are in seed order. */
export function knockout(entrants: string[], prefix = 'KO'): Fixture[] {
  let size = 1;
  while (size < entrants.length) size *= 2;
  const order = seedOrder(size);
  const slots = order.map((seed) => entrants[seed - 1] ?? null);
  const out: Fixture[] = [];
  let roundSize = size;
  let round = 1;
  let prev: Fixture[] = [];
  while (roundSize >= 2) {
    const count = roundSize / 2;
    const cur: Fixture[] = [];
    for (let i = 0; i < count; i++) {
      const f: Fixture = { key: `${prefix}-R${round}-${i + 1}`, round, home: null, away: null, label: `${roundName(roundSize)}${count > 1 ? ` ${i + 1}` : ''}` };
      if (round === 1) {
        f.home = slots[2 * i];
        f.away = slots[2 * i + 1];
      }
      cur.push(f);
    }
    prev.forEach((p, i) => (p.winnerTo = { key: cur[Math.floor(i / 2)].key, slot: i % 2 === 0 ? 'home' : 'away' }));
    out.push(...cur);
    prev = cur;
    roundSize /= 2;
    round++;
  }
  // Resolve byes: an entrant facing null in round 1 advances immediately.
  for (const f of out.filter((x) => x.round === 1)) {
    const lone = f.home && !f.away ? f.home : !f.home && f.away ? f.away : null;
    if (lone && f.winnerTo) {
      const next = out.find((x) => x.key === f.winnerTo!.key)!;
      next[f.winnerTo.slot] = lone;
      f.label = `${f.label} (bye)`;
    }
  }
  return out;
}

/** Fixtures that are actually playable (both entrants known, not a bye). */
export const playable = (fx: Fixture[]) => fx.filter((f) => f.home && f.away);

export interface ResultInput {
  home: string;
  away: string;
  winner: Side | null; // 0 = home, 1 = away
  primary: [number, number];
  extra?: Record<string, any>;
}

export interface StandingRow {
  entrant: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  for: number;
  against: number;
  diff: number;
  points: number;
  /** Secondary for/against (e.g. points within sets) for ratio tie-breaks. */
  subFor: number;
  subAgainst: number;
  nrr?: number;
  form: string[];
}

export function standings(sportId: string, entrants: string[], results: ResultInput[]): StandingRow[] {
  const rules = getSport(sportId).standings;
  const rows = new Map<string, StandingRow & { _rf: number; _bf: number; _ra: number; _ba: number; _bpo: number }>();
  for (const e of entrants)
    rows.set(e, { entrant: e, played: 0, won: 0, drawn: 0, lost: 0, for: 0, against: 0, diff: 0, points: 0, subFor: 0, subAgainst: 0, form: [], _rf: 0, _bf: 0, _ra: 0, _ba: 0, _bpo: 6 });
  for (const r of results) {
    const sides = [r.home, r.away];
    sides.forEach((id, i) => {
      const row = rows.get(id);
      if (!row) return;
      const me = i as Side;
      const op = (1 - i) as Side;
      row.played++;
      row.for += r.primary[me];
      row.against += r.primary[op];
      const pf = r.extra?.pointsFor;
      if (pf) {
        row.subFor += pf[me];
        row.subAgainst += pf[op];
      }
      if (r.winner == null) {
        row.drawn++;
        row.points += rules.draw;
        row.form.push('D');
      } else if (r.winner === me) {
        row.won++;
        row.points += rules.win;
        row.form.push('W');
      } else {
        row.lost++;
        row.points += rules.loss;
        row.form.push('L');
      }
      const nrr = r.extra?.nrr;
      if (nrr) {
        row._rf += nrr.runsFor[me];
        row._bf += nrr.ballsFaced[me];
        row._ra += nrr.runsFor[op];
        row._ba += nrr.ballsFaced[op];
        row._bpo = nrr.ballsPerOver;
      }
    });
  }
  const list = [...rows.values()].map((r) => {
    r.diff = r.for - r.against;
    if (r._bf && r._ba) r.nrr = +((r._rf / r._bf) * r._bpo - (r._ra / r._ba) * r._bpo).toFixed(3);
    r.form = r.form.slice(-5);
    return r;
  });
  const h2h = (a: string, b: string) => {
    let s = 0;
    for (const r of results) {
      if (r.home === a && r.away === b) s += r.winner === 0 ? 1 : r.winner === 1 ? -1 : 0;
      if (r.home === b && r.away === a) s += r.winner === 1 ? 1 : r.winner === 0 ? -1 : 0;
    }
    return s;
  };
  const ratio = (f: number, a: number) => (a === 0 ? (f > 0 ? Infinity : 0) : f / a);
  list.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (const t of rules.tieBreakers) {
      let d = 0;
      if (t === 'pointsDiff') d = b.diff - a.diff;
      else if (t === 'pointsFor') d = b.for - a.for;
      else if (t === 'wins') d = b.won - a.won;
      else if (t === 'netRunRate') d = (b.nrr ?? 0) - (a.nrr ?? 0);
      else if (t === 'setsRatio') d = ratio(b.for, b.against) - ratio(a.for, a.against) || ratio(b.subFor, b.subAgainst) - ratio(a.subFor, a.subAgainst);
      else if (t === 'headToHead') d = -h2h(a.entrant, b.entrant);
      if (d) return d;
    }
    return a.entrant.localeCompare(b.entrant);
  });
  return list.map(({ _rf, _bf, _ra, _ba, _bpo, ...r }) => r);
}

export interface SlotAssignment {
  key: string;
  surfaceId: string;
  start: string;
}

/**
 * Greedy multi-court scheduler: fills surfaces slot by slot, never booking an entrant
 * twice in the same slot (and respecting fixture round order). Returns assignments.
 */
export function schedule(
  fixtures: Fixture[],
  surfaces: string[],
  startISO: string,
  slotMinutes: number,
  opts: { restSlots?: number } = {},
): SlotAssignment[] {
  const rest = opts.restSlots ?? 0;
  const pending = playable(fixtures).sort((a, b) => a.round - b.round);
  const lastSlot = new Map<string, number>();
  const out: SlotAssignment[] = [];
  let slot = 0;
  const start = Date.parse(startISO);
  while (pending.length && slot < 10000) {
    const busy = new Set<string>();
    let used = 0;
    for (let i = 0; i < pending.length && used < surfaces.length; ) {
      const f = pending[i];
      const ok = [f.home!, f.away!].every((e) => !busy.has(e) && (lastSlot.get(e) ?? -Infinity) + rest < slot);
      if (ok) {
        out.push({ key: f.key, surfaceId: surfaces[used], start: new Date(start + slot * slotMinutes * 60000).toISOString() });
        busy.add(f.home!);
        busy.add(f.away!);
        lastSlot.set(f.home!, slot);
        lastSlot.set(f.away!, slot);
        pending.splice(i, 1);
        used++;
      } else i++;
    }
    slot++;
  }
  return out;
}

/** Detect conflicts in an existing schedule: same surface or same entrant overlapping. */
export function findConflicts(items: { key: string; surfaceId?: string | null; start: string; minutes: number; entrants: string[] }[]) {
  const conflicts: { a: string; b: string; reason: string }[] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const as = Date.parse(a.start), ae = as + a.minutes * 60000;
      const bs = Date.parse(b.start), be = bs + b.minutes * 60000;
      if (as >= be || bs >= ae) continue;
      if (a.surfaceId && a.surfaceId === b.surfaceId) conflicts.push({ a: a.key, b: b.key, reason: 'surface double-booked' });
      const shared = a.entrants.filter((e) => b.entrants.includes(e));
      if (shared.length) conflicts.push({ a: a.key, b: b.key, reason: `entrant double-booked: ${shared.join(', ')}` });
    }
  return conflicts;
}
