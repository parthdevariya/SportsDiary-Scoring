/**
 * @arenaos/engine — isomorphic (Node + browser) scoring engine.
 * The same code runs on the server (authoritative) and on scoring devices (offline).
 */
import { registerSport, hasSport } from './core/registry.ts';
import { football } from './sports/football.ts';
import { cricket } from './sports/cricket.ts';
import { badminton, tableTennis, volleyball } from './sports/rally.ts';
import { tennis, padel } from './sports/tennis.ts';
import { basketball } from './sports/basketball.ts';
import { pickleball } from './sports/pickleball.ts';
import { snooker, billiards } from './sports/cue.ts';

export * from './core/types.ts';
export * from './core/registry.ts';
export * from './core/aggregate.ts';
export { fmtClock } from './core/clock.ts';

/** Built-in sports. A new sport = one engine file + one line here. */
export const BUILT_IN_SPORTS = [football, badminton, tableTennis, snooker, billiards, cricket, volleyball, basketball, tennis, pickleball, padel];

for (const s of BUILT_IN_SPORTS) if (!hasSport(s.id)) registerSport(s);

export function catalog() {
  return BUILT_IN_SPORTS.map((s) => ({
    id: s.id,
    name: s.name,
    family: s.family,
    disciplines: s.disciplines.map((d) => ({ id: d.id, name: d.name, sideSize: d.sideSize, defaults: d.defaults })),
    standings: s.standings,
  }));
}
