import type { DisplayClock, MatchEvent } from './types.ts';
import { eventTime } from './util.ts';

/**
 * Event-sourced game clock. The clock is derived from START/STOP events with
 * device timestamps, so replaying the log reproduces it exactly and every client
 * (scorer, TV, public page) renders the same time from `anchorAt` + elapsed.
 */
export interface ClockState {
  running: boolean;
  /** Elapsed ms in the current period, banked at the last stop. */
  bankedMs: number;
  /** Epoch ms when the clock last started (if running). */
  startedAt: number | null;
}

export const newClock = (): ClockState => ({ running: false, bankedMs: 0, startedAt: null });

export function clockStart(c: ClockState, e: MatchEvent): ClockState {
  if (c.running) return c;
  return { running: true, bankedMs: c.bankedMs, startedAt: eventTime(e) };
}

export function clockStop(c: ClockState, e: MatchEvent): ClockState {
  if (!c.running || c.startedAt == null) return c;
  return { running: false, bankedMs: c.bankedMs + Math.max(0, eventTime(e) - c.startedAt), startedAt: null };
}

export function clockElapsedAt(c: ClockState, atMs: number): number {
  return c.running && c.startedAt != null ? c.bankedMs + Math.max(0, atMs - c.startedAt) : c.bankedMs;
}

export function clockDisplay(c: ClockState, periodMs: number | undefined, direction: 'up' | 'down'): DisplayClock {
  return c.running && c.startedAt != null
    ? { running: true, elapsedMs: c.bankedMs, anchorAt: new Date(c.startedAt).toISOString(), periodMs, direction }
    : { running: false, elapsedMs: c.bankedMs, periodMs, direction };
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Possession tracker accumulates in-play time per side. */
export interface PossessionState {
  side: 0 | 1 | null;
  since: number | null;
  ms: [number, number];
}

export const newPossession = (): PossessionState => ({ side: null, since: null, ms: [0, 0] });

export function possessionSwitch(p: PossessionState, side: 0 | 1 | null, atMs: number): PossessionState {
  const ms: [number, number] = [...p.ms];
  if (p.side != null && p.since != null) ms[p.side] += Math.max(0, atMs - p.since);
  return { side, since: side == null ? null : atMs, ms };
}
