import type { SportRuleEngine, DisciplineDef } from './types.ts';

const engines = new Map<string, SportRuleEngine>();

export function registerSport(engine: SportRuleEngine): void {
  if (engines.has(engine.id)) throw new Error(`Sport already registered: ${engine.id}`);
  engines.set(engine.id, engine);
}

export function getSport(id: string): SportRuleEngine {
  const e = engines.get(id);
  if (!e) throw new Error(`Unknown sport: ${id}`);
  return e;
}

export function hasSport(id: string): boolean {
  return engines.has(id);
}

export function listSports(): SportRuleEngine[] {
  return [...engines.values()];
}

export function getDiscipline(sportId: string, disciplineId: string): DisciplineDef {
  const d = getSport(sportId).disciplines.find((x) => x.id === disciplineId);
  if (!d) throw new Error(`Unknown discipline ${disciplineId} for ${sportId}`);
  return d;
}

/** Discipline defaults merged with organizer overrides. Overrides win. */
export function resolveConfig(sportId: string, disciplineId: string, overrides: Record<string, any> = {}): Record<string, any> {
  return { ...getDiscipline(sportId, disciplineId).defaults, ...overrides };
}
