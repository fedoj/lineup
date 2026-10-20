/** Domain types shared by the web app, the API, and any future mobile client. */

import type { Format, Periods } from './formations.js';
export type { Format, Periods };

export interface Team {
  id: string;
  ownerId: string;
  name: string;
  ageGroup: string;
  season: string;
  coach: string;
  assistantCoach?: string;
  region?: string;
  division?: string;
  /** Division catalog id, e.g. 'BU10'. Required for teams created from the app. */
  catalogDivisionId?: string;
  gender?: 'boys' | 'girls' | 'coed';
  ageU?: number;
  /** Match setup. Suggested by the division but explicitly chosen. */
  format?: Format;
  periods?: Periods;
  periodLengthSec?: number;
  /** Shape new games start with. */
  defaultFormation?: string;
  createdAt: string;
  /** The caller's strongest role on this team, when they hold one. */
  myRole?: string | null;
  /** The team plays in an organization or region (not a standalone team). */
  inLeague?: boolean;
  /** The caller may add or remove players (staff only on a league team). */
  canAddPlayers?: boolean;
  /** The caller may invite people to this team (staff only on a league team). */
  canInvite?: boolean;
  /** When the team was archived (read-only since); absent while active. */
  archivedAt?: string;
  /** Until when an archived team can be brought back. */
  restoreUntil?: string;
  /** The caller may archive this team or bring it back. */
  canArchive?: boolean;
}

export interface Player {
  id: string;
  teamId: string;
  number: string;
  name: string;
  active: boolean;
  /** Picks the boy or girl emoji shown for the player. */
  gender?: 'boy' | 'girl' | null;
  /** Preferred positions. Soft hints for the fair-play engine. */
  primaryPos?: string | null;
  secondaryPos?: string | null;
  /** Keeps this player out of goal. */
  neverKeeper?: boolean;
  /** In organizations and regions: "Ava G. 482", unique in the organization. */
  publicId?: string | null;
}

export interface Game {
  id: string;
  teamId: string;
  gameNo: number;
  date: string;
  opponent: string;
  us: number;
  them: number;
  isHome: boolean;
  format: Format;
  periods: Periods;
  periodLengthSec?: number;
  formation: string;
  tactic: string;
  /** periodIndex -> positionId -> playerId */
  assignments: Record<string, Record<string, string>>;
  /** Set when the lineup is withheld from this viewer until game day. */
  lineupHidden?: boolean;
  notes?: string;
  /** Set on league games scheduled by an org or region; date and teams are fixed. */
  fixtureId?: string;
  kickoff?: string;
  location?: string;
  field?: string;
  updatedAt: string;
}

/** Everything that can be logged during a match. */
export const GAME_EVENT_KINDS = [
  'goal',
  'assist',
  'own_goal',
  'save',
  'yellow',
  'red',
  'sub',
  'corner',
  'foul',
  'near_goal_clearance',
  'shot',
  'penalty',
] as const;

export type GameEventKind = (typeof GAME_EVENT_KINDS)[number];

export interface GameEvent {
  id: string;
  gameId?: string;
  playerId: string | null;
  assistId: string | null;
  kind: GameEventKind;
  periodIndex: number | null;
  clockSec: number | null;
  /** true when it belongs to the opposition, so team totals stay correct. */
  against: boolean;
  note: string | null;
}

export interface Practice {
  id: string;
  teamId: string;
  date: string;
  title: string;
  presentPlayerIds: string[];
  updatedAt: string;
}

export interface Contact {
  id: string;
  teamId: string;
  name: string;
  email: string;
}

/** A team's sponsor slot, shown instead of third-party ads. */
export interface Sponsor {
  id: string;
  teamId: string;
  name: string;
  logoUrl?: string;
  linkUrl?: string;
  active: boolean;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false } & ApiError;
