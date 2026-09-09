import type {
  AppPlan,
  Game,
  LineupResource,
  Player,
  Team,
  TierId,
  Usage,
} from '@lineup/shared';

const BASE = '/api';

export interface MeResponse {
  user: { id: string; email: string | null; provider: string };
  tier: TierId;
  paywallEnabled: boolean;
  usage: Usage<LineupResource>;
  limits: Record<LineupResource, number>;
  plan: AppPlan<LineupResource>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let payload: { error?: string; code?: string; details?: unknown } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      payload.error ?? `Request failed (${res.status})`,
      res.status,
      payload.code,
      payload.details,
    );
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  health: () => request<{ status: string; database: string }>('/health'),
  me: () => request<MeResponse>('/me'),

  listTeams: () => request<Team[]>('/teams'),
  createTeam: (team: Partial<Team>) =>
    request<Team>('/teams', { method: 'POST', body: JSON.stringify(team) }),

  listGames: (teamId: string) =>
    request<Game[]>(`/games?teamId=${encodeURIComponent(teamId)}`),
  saveGame: (game: Partial<Game>) =>
    request<Game>('/games', { method: 'POST', body: JSON.stringify(game) }),

  listPlayers: (teamId: string) =>
    request<Player[]>(`/players?teamId=${encodeURIComponent(teamId)}`),
  savePlayers: (teamId: string, players: Partial<Player>[]) =>
    request<Player[]>('/players', {
      method: 'PUT',
      body: JSON.stringify({ teamId, players }),
    }),
};
