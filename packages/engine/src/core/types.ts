/**
 * Universal match model. Nothing in this file knows about any specific sport.
 * Sports plug in by implementing SportRuleEngine and registering themselves.
 */

export type Side = 0 | 1;
export const other = (s: Side): Side => (s === 0 ? 1 : 0);

export type MatchStatus = 'scheduled' | 'live' | 'paused' | 'completed' | 'abandoned';

/** A person taking part (player, or a member of a team roster). */
export interface PlayerRef {
  id: string;
  name: string;
  number?: string | number;
  position?: string;
}

/** One side of a match: a team, a singles player, or a doubles pair. */
export interface Participant {
  id: string;
  name: string;
  short?: string;
  color?: string;
  logoUrl?: string;
  players?: PlayerRef[];
}

/** Everything the engine needs to know about a match that is not an event. */
export interface MatchDefinition {
  id: string;
  sport: string;
  discipline: string;
  config: Record<string, any>;
  participants: [Participant, Participant];
}

/** Core event types understood by the aggregate itself (sport-agnostic). */
export const CORE_EVENTS = ['MATCH_START', 'MATCH_PAUSE', 'MATCH_RESUME', 'MATCH_ABANDON', 'VOID', 'UNVOID'] as const;
export type CoreEventType = (typeof CORE_EVENTS)[number];

/** Immutable, append-only scoring event. */
export interface MatchEvent<P = any> {
  /** Server-assigned id (client generates a provisional one offline). */
  id: string;
  /** Idempotency key generated on the scoring device. Re-sending is safe. */
  clientEventId: string;
  matchId: string;
  /** Server-assigned position in the match log (1-based). 0 = not yet accepted. */
  seq: number;
  type: string;
  payload: P;
  actorId?: string;
  /** Server receive time (authoritative ordering). */
  createdAt: string;
  /** Time on the scoring device when the action happened (used for clocks/possession). */
  deviceTime?: string;
}

/** Input the scorer submits; the platform turns it into a MatchEvent. */
export interface EventInput<P = any> {
  /** Optional device-generated UUID, so offline events (and undos that target them) keep stable ids. */
  id?: string;
  type: string;
  payload?: P;
  clientEventId?: string;
  deviceTime?: string;
  actorId?: string;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Score summary used for results, standings and share cards. */
export interface ScoreSummary {
  /** Big, human-readable score per side (e.g. "2", "187/4", "1 set"). */
  text: [string, string];
  /** Numeric primary score per side (goals, points, sets, frames, runs). */
  primary: [number, number];
  /** Optional numbers standings may need (e.g. goals for/against, runs+overs for NRR). */
  extra?: Record<string, any>;
}

export interface StatLine {
  key: string;
  label: string;
  values: [number | string, number | string];
}

export interface PlayerStatRow {
  playerId: string;
  name: string;
  side: Side;
  stats: Record<string, number | string>;
}

export interface MatchStatistics {
  team: StatLine[];
  players: PlayerStatRow[];
  /** Sport-specific structured stats (e.g. cricket scorecards). */
  detail?: Record<string, any>;
}

/** Universal big-screen / public projection. Every client renders this. */
export interface DisplaySide {
  name: string;
  short?: string;
  color?: string;
  /** The headline number(s) — rendered huge on TV. */
  score: string;
  /** Secondary line(s) under the score: "Overs 14.3", "Fouls 4", "Break 47". */
  detail?: string[];
  serving?: boolean;
  /** Small indicators like set/game counts or pips. */
  badges?: string[];
}

export interface DisplayClock {
  running: boolean;
  /** Elapsed ms in the current period at `anchorAt` (or frozen if not running). */
  elapsedMs: number;
  anchorAt?: string;
  /** If set, render as countdown from this period length. */
  periodMs?: number;
  direction: 'up' | 'down';
}

export interface DisplayState {
  sport: string;
  sportName: string;
  discipline: string;
  status: MatchStatus;
  /** "SET 3", "Q4", "2nd HALF", "INNINGS 2", "FRAME 5". */
  phase: string;
  clock?: DisplayClock;
  sides: [DisplaySide, DisplaySide];
  /** Period-by-period table: column labels + one row per side. */
  periods?: { labels: string[]; rows: [string[], string[]] };
  /** Context line: "DEUCE", "MATCH POINT", "Need 23 off 14 balls". */
  headline?: string;
  /** Most recent happenings, newest first. */
  ticker?: string[];
  winner?: Side | null;
  resultText?: string;
  version: number;
  updatedAt?: string;
}

/** Inputs a scorer action needs before it can become an event. */
export interface ActionInput {
  key: string;
  label: string;
  kind: 'player' | 'number' | 'select' | 'text';
  side?: Side;
  options?: { value: string; label: string }[];
  optional?: boolean;
  default?: any;
}

/** Config-driven scorer button. The scorer UI is generated from these. */
export interface ScorerAction {
  id: string;
  label: string;
  type: string;
  payload?: Record<string, any>;
  side?: Side;
  group: 'primary' | 'secondary' | 'stat' | 'control' | 'setup';
  inputs?: ActionInput[];
  tone?: 'positive' | 'negative' | 'neutral';
}

export interface DisciplineDef {
  id: string;
  name: string;
  /** Default rule configuration for this discipline. Admins can override any key. */
  defaults: Record<string, any>;
  /** Side size: 1 for singles, 2 for doubles, n for teams. */
  sideSize?: number;
}

export interface StandingsRules {
  /** Points awarded for a win/draw/loss (league tables). */
  win: number;
  draw: number;
  loss: number;
  /** Ordered tie-breakers, resolved by the tournament engine. */
  tieBreakers: ('pointsDiff' | 'pointsFor' | 'headToHead' | 'netRunRate' | 'setsRatio' | 'wins')[];
  /** Labels for for/against columns ("Goals", "Runs", "Sets"...). */
  forLabel: string;
}

export interface EngineContext {
  match: MatchDefinition;
  config: Record<string, any>;
}

/**
 * The contract every sport implements. All functions must be PURE:
 * same state + same event => same result. This is what makes replay,
 * undo, offline scoring and server re-validation trustworthy.
 */
export interface SportRuleEngine<S = any> {
  id: string;
  name: string;
  /** Family helps UIs pick sensible layouts: 'rally' | 'racket' | 'timed' | 'cricket' | 'cue'. */
  family: string;
  disciplines: DisciplineDef[];
  standings: StandingsRules;
  /** Sport-specific event types this engine accepts. */
  eventTypes: string[];

  initializeMatch(ctx: EngineContext): S;
  validateEvent(state: S, event: MatchEvent, ctx: EngineContext): ValidationResult;
  applyEvent(state: S, event: MatchEvent, ctx: EngineContext): S;
  calculateScore(state: S, ctx: EngineContext): ScoreSummary;
  calculateStatistics(state: S, events: MatchEvent[], ctx: EngineContext): MatchStatistics;
  determineWinner(state: S, ctx: EngineContext): Side | null;
  isMatchComplete(state: S, ctx: EngineContext): boolean;
  getCurrentState(state: S, ctx: EngineContext): S;
  getDisplayState(state: S, ctx: EngineContext): Omit<DisplayState, 'version' | 'status' | 'sport' | 'sportName' | 'discipline'>;
  getActions(state: S, ctx: EngineContext): ScorerAction[];
  /** Human sentence for an event, used by timeline + verified AI commentary input. */
  describeEvent(event: MatchEvent, stateBefore: S, ctx: EngineContext): string | null;
}
