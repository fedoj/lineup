/** Domain types shared by the web app, the API, and any future mobile client. */

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
  createdAt: string;
}

export interface Player {
  id: string;
  teamId: string;
  number: string;
  name: string;
  active: boolean;
}

export type Format = '5v5' | '7v7' | '9v9' | '11v11';
export type Periods = 'quarters' | 'halves';

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
  formation: string;
  tactic: string;
  /** periodIndex -> positionId -> playerId */
  assignments: Record<string, Record<string, string>>;
  notes?: string;
  updatedAt: string;
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
