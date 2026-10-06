import type { EngineContext, MatchEvent, PlayerRef, Side } from './types.ts';

export const clone = <T>(v: T): T => structuredClone(v);

export const ok = { ok: true } as const;
export const fail = (error: string) => ({ ok: false, error });

export function isSide(v: any): v is Side {
  return v === 0 || v === 1;
}

export function sideName(ctx: EngineContext, s: Side): string {
  return ctx.match.participants[s].name;
}

export function shortName(ctx: EngineContext, s: Side): string {
  const p = ctx.match.participants[s];
  return p.short ?? p.name;
}

export function findPlayer(ctx: EngineContext, id: string | undefined): (PlayerRef & { side: Side }) | undefined {
  if (!id) return undefined;
  for (const s of [0, 1] as Side[]) {
    const p = ctx.match.participants[s].players?.find((x) => x.id === id);
    if (p) return { ...p, side: s };
  }
  return undefined;
}

export function playerName(ctx: EngineContext, id: string | undefined): string {
  return findPlayer(ctx, id)?.name ?? id ?? '';
}

export function playerOptions(ctx: EngineContext, s: Side, filter?: (id: string) => boolean) {
  return (ctx.match.participants[s].players ?? [])
    .filter((p) => !filter || filter(p.id))
    .map((p) => ({ value: p.id, label: p.number != null ? `${p.number} · ${p.name}` : p.name }));
}

export const eventTime = (e: MatchEvent): number => Date.parse(e.deviceTime ?? e.createdAt);

export const pct = (num: number, den: number, digits = 0): string =>
  den > 0 ? `${((num / den) * 100).toFixed(digits)}%` : '–';

export function bump(obj: Record<string, number>, key: string, by = 1): void {
  obj[key] = (obj[key] ?? 0) + by;
}

export const pair = <T>(make: () => T): [T, T] => [make(), make()];
