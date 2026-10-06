import { MatchAggregate, type MatchDefinition, type Participant } from '../../packages/engine/src/index.ts';

export function roster(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix.toUpperCase()} Player ${i + 1}`, number: i + 1 }));
}

export function makeMatch(sport: string, discipline: string, config: Record<string, any> = {}, rosters = 0): MatchAggregate {
  const p: [Participant, Participant] = [
    { id: 'A', name: 'Alpha', short: 'ALP', players: rosters ? roster('a', rosters) : undefined },
    { id: 'B', name: 'Bravo', short: 'BRV', players: rosters ? roster('b', rosters) : undefined },
  ];
  const def: MatchDefinition = { id: `m-${sport}`, sport, discipline, config, participants: p };
  const m = new MatchAggregate(def);
  m.record({ type: 'MATCH_START' });
  return m;
}

let t = Date.parse('2026-10-06T10:00:00Z');
/** Deterministic, advancing device clock for timed sports. */
export function at(secondsLater = 0): string {
  t += secondsLater * 1000;
  return new Date(t).toISOString();
}

export function points(m: MatchAggregate, side: 0 | 1, n: number, type = 'POINT', extra: Record<string, any> = {}) {
  for (let i = 0; i < n; i++) m.record({ type, payload: { side, ...extra } });
}
