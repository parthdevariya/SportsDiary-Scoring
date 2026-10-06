import type {
  DisplayState,
  EngineContext,
  EventInput,
  MatchDefinition,
  MatchEvent,
  MatchStatistics,
  MatchStatus,
  ScoreSummary,
  ScorerAction,
  Side,
  SportRuleEngine,
  ValidationResult,
} from './types.ts';
import { CORE_EVENTS } from './types.ts';
import { getSport, resolveConfig } from './registry.ts';

export class EventRejected extends Error {
  constructor(message: string, public code: string = 'INVALID_EVENT') {
    super(message);
  }
}

export interface ReplayIssue {
  eventId: string;
  seq: number;
  error: string;
}

export const uid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

/**
 * Event-sourced match aggregate.
 *
 * The log is append-only. Undo/corrections never delete: they append VOID / UNVOID
 * events, and the sport state is rebuilt by folding the *effective* events
 * (those not currently voided) through the pure sport engine. If a correction
 * makes a later event illegal, that event is skipped and reported in `issues`
 * so a scorer can review it — the official score never silently changes shape.
 */
export class MatchAggregate {
  readonly engine: SportRuleEngine;
  readonly ctx: EngineContext;
  events: MatchEvent[] = [];
  state: any;
  status: MatchStatus = 'scheduled';
  issues: ReplayIssue[] = [];
  /** Effective sport events in the order they were applied (for stats/timeline). */
  applied: MatchEvent[] = [];
  /** Human descriptions of applied events (verified timeline/commentary source). */
  timeline: { seq: number; eventId: string; type: string; text: string; at: string }[] = [];
  startedAt?: string;
  endedAt?: string;

  constructor(readonly match: MatchDefinition, events: MatchEvent[] = []) {
    this.engine = getSport(match.sport);
    const config = resolveConfig(match.sport, match.discipline, match.config);
    this.ctx = { match: { ...match, config }, config };
    this.events = [...events].sort((a, b) => a.seq - b.seq);
    this.rebuild();
  }

  get version(): number {
    return this.events.length ? this.events[this.events.length - 1].seq : 0;
  }

  /** Ids of events currently voided (VOID/UNVOID toggles, last one wins). */
  voidedIds(): Set<string> {
    const voided = new Set<string>();
    for (const e of this.events) {
      if (e.type === 'VOID') voided.add(e.payload.targetId);
      else if (e.type === 'UNVOID') voided.delete(e.payload.targetId);
    }
    return voided;
  }

  private rebuild(): void {
    this.state = this.engine.initializeMatch(this.ctx);
    this.status = 'scheduled';
    this.issues = [];
    this.applied = [];
    this.timeline = [];
    this.startedAt = undefined;
    this.endedAt = undefined;
    const voided = this.voidedIds();
    for (const e of this.events) {
      if (e.type === 'VOID' || e.type === 'UNVOID' || voided.has(e.id)) continue;
      const v = this.check(e);
      if (!v.ok) {
        this.issues.push({ eventId: e.id, seq: e.seq, error: v.error ?? 'invalid' });
        continue;
      }
      this.fold(e);
    }
  }

  private isCore(type: string): boolean {
    return (CORE_EVENTS as readonly string[]).includes(type);
  }

  /** Validate an event against the current state (core rules, then sport rules). */
  check(e: MatchEvent): ValidationResult {
    switch (e.type) {
      case 'MATCH_START':
        return this.status === 'scheduled' ? { ok: true } : { ok: false, error: 'Match already started' };
      case 'MATCH_PAUSE':
        return this.status === 'live' ? { ok: true } : { ok: false, error: 'Match is not live' };
      case 'MATCH_RESUME':
        return this.status === 'paused' ? { ok: true } : { ok: false, error: 'Match is not paused' };
      case 'MATCH_ABANDON':
        return this.status === 'live' || this.status === 'paused' || this.status === 'scheduled'
          ? { ok: true }
          : { ok: false, error: 'Match already finished' };
    }
    if (!this.engine.eventTypes.includes(e.type)) return { ok: false, error: `Unknown event type ${e.type} for ${this.engine.id}` };
    if (this.status === 'scheduled') return { ok: false, error: 'Match has not started' };
    if (this.status === 'paused') return { ok: false, error: 'Match is paused' };
    if (this.status === 'completed' || this.status === 'abandoned') return { ok: false, error: 'Match is finished' };
    try {
      return this.engine.validateEvent(this.state, e, this.ctx);
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  private fold(e: MatchEvent): void {
    const at = e.deviceTime ?? e.createdAt;
    if (this.isCore(e.type)) {
      if (e.type === 'MATCH_START') {
        this.status = 'live';
        this.startedAt = at;
        // Engines may track clocks; give them the start as a regular event.
        if (this.engine.eventTypes.includes('MATCH_START')) this.state = this.engine.applyEvent(this.state, e, this.ctx);
      } else if (e.type === 'MATCH_PAUSE') this.status = 'paused';
      else if (e.type === 'MATCH_RESUME') this.status = 'live';
      else if (e.type === 'MATCH_ABANDON') {
        this.status = 'abandoned';
        this.endedAt = at;
      }
      this.timeline.push({ seq: e.seq, eventId: e.id, type: e.type, text: coreText(e.type), at });
      return;
    }
    const before = this.state;
    this.state = this.engine.applyEvent(this.state, e, this.ctx);
    this.applied.push(e);
    const text = this.engine.describeEvent(e, before, this.ctx);
    if (text) this.timeline.push({ seq: e.seq, eventId: e.id, type: e.type, text, at });
    if (this.engine.isMatchComplete(this.state, this.ctx)) {
      this.status = 'completed';
      this.endedAt = at;
    }
  }

  /**
   * Build a MatchEvent from scorer input. `seq` is the next position; the server
   * (or the offline queue) is the only thing that assigns real seq values.
   */
  createEvent(input: EventInput, now: string = new Date().toISOString()): MatchEvent {
    return {
      id: input.id && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : uid(),
      clientEventId: input.clientEventId ?? uid(),
      matchId: this.match.id,
      seq: this.version + 1,
      type: input.type,
      payload: input.payload ?? {},
      actorId: input.actorId,
      createdAt: now,
      deviceTime: input.deviceTime ?? now,
    };
  }

  /** Validate + append + apply. Throws EventRejected if illegal. Idempotent on clientEventId. */
  append(event: MatchEvent): { event: MatchEvent; duplicate: boolean } {
    const dup = this.events.find((x) => x.clientEventId === event.clientEventId);
    if (dup) return { event: dup, duplicate: true };
    if (this.events.some((x) => x.id === event.id)) throw new EventRejected('Event id already used', 'CONFLICT');
    const e = { ...event, seq: this.version + 1 };
    if (e.type === 'VOID' || e.type === 'UNVOID') {
      const target = this.events.find((x) => x.id === e.payload?.targetId);
      if (!target) throw new EventRejected('Target event not found', 'NOT_FOUND');
      if (target.type === 'VOID' || target.type === 'UNVOID') throw new EventRejected('Cannot void a void');
      const isVoided = this.voidedIds().has(target.id);
      if (e.type === 'VOID' && isVoided) throw new EventRejected('Event already voided');
      if (e.type === 'UNVOID' && !isVoided) throw new EventRejected('Event is not voided');
      this.events.push(e);
      this.rebuild();
      return { event: e, duplicate: false };
    }
    const v = this.check(e);
    if (!v.ok) throw new EventRejected(v.error ?? 'Invalid event');
    this.events.push(e);
    this.fold(e);
    return { event: e, duplicate: false };
  }

  /** Convenience: create + append. */
  record(input: EventInput, now?: string): MatchEvent {
    return this.append(this.createEvent(input, now)).event;
  }

  /** The most recent effective event that can be undone (sport events and start/pause). */
  lastUndoable(): MatchEvent | undefined {
    const voided = this.voidedIds();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === 'VOID' || e.type === 'UNVOID' || voided.has(e.id)) continue;
      return e;
    }
    return undefined;
  }

  undoInput(): EventInput | null {
    const t = this.lastUndoable();
    return t ? { type: 'VOID', payload: { targetId: t.id, reason: 'undo' } } : null;
  }

  redoInput(): EventInput | null {
    const t = this.redoTarget();
    return t ? { type: 'UNVOID', payload: { targetId: t.id, reason: 'redo' } } : null;
  }

  /** Redo stack: walk back over trailing VOID/UNVOID pairs. */
  redoTarget(): MatchEvent | undefined {
    const stack: string[] = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === 'VOID') stack.push(e.payload.targetId);
      else if (e.type === 'UNVOID') {
        // an UNVOID consumes the most recent un-redone VOID: skip its pair
        stack.push('#skip');
      } else break;
    }
    // stack is newest-first; resolve skips
    let skips = 0;
    for (const id of stack) {
      if (id === '#skip') {
        skips++;
        continue;
      }
      if (skips > 0) {
        skips--;
        continue;
      }
      return this.events.find((x) => x.id === id);
    }
    return undefined;
  }

  // ---------- projections ----------

  score(): ScoreSummary {
    return this.engine.calculateScore(this.state, this.ctx);
  }

  statistics(): MatchStatistics {
    return this.engine.calculateStatistics(this.state, this.applied, this.ctx);
  }

  winner(): Side | null {
    return this.status === 'completed' ? this.engine.determineWinner(this.state, this.ctx) : null;
  }

  actions(): ScorerAction[] {
    if (this.status === 'scheduled') return [{ id: 'start', label: 'Start match', type: 'MATCH_START', group: 'control', tone: 'positive' }];
    if (this.status === 'paused') return [{ id: 'resume', label: 'Resume', type: 'MATCH_RESUME', group: 'control', tone: 'positive' }];
    if (this.status !== 'live') return [];
    return [
      ...this.engine.getActions(this.state, this.ctx),
      { id: 'pause', label: 'Pause', type: 'MATCH_PAUSE', group: 'control' },
      { id: 'abandon', label: 'Abandon', type: 'MATCH_ABANDON', group: 'control', tone: 'negative' },
    ];
  }

  display(): DisplayState {
    const d = this.engine.getDisplayState(this.state, this.ctx);
    const p = this.match.participants;
    d.sides.forEach((s, i) => {
      s.name ||= p[i].name;
      s.short ??= p[i].short;
      s.color ??= p[i].color;
    });
    const out: DisplayState = {
      sport: this.engine.id,
      sportName: this.engine.name,
      discipline: this.match.discipline,
      status: this.status,
      version: this.version,
      ...d,
    };
    if (this.status !== 'live' && out.clock) out.clock = { ...out.clock, running: false };
    if (this.status === 'scheduled') out.phase = 'UPCOMING';
    if (this.status === 'abandoned') out.resultText = 'Match abandoned';
    if (!out.ticker) out.ticker = this.timeline.slice(-5).reverse().map((t) => t.text);
    return out;
  }

  /** Full snapshot sent to scorers/admin (public clients get display() only). */
  snapshot() {
    return {
      matchId: this.match.id,
      version: this.version,
      status: this.status,
      score: this.score(),
      winner: this.winner(),
      display: this.display(),
      actions: this.actions(),
      issues: this.issues,
      canUndo: !!this.lastUndoable(),
      canRedo: !!this.redoTarget(),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }
}

function coreText(type: string): string {
  return (
    { MATCH_START: 'Match started', MATCH_PAUSE: 'Match paused', MATCH_RESUME: 'Match resumed', MATCH_ABANDON: 'Match abandoned' } as Record<string, string>
  )[type] ?? type;
}
