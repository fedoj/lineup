import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import type { Team } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { query, queryOne } from '../lib/db.js';
import { enforceLimit } from '../lib/entitlements.js';

interface TeamRow {
  id: string;
  owner_id: string;
  name: string;
  age_group: string;
  season: string;
  coach: string;
  assistant_coach: string | null;
  region: string | null;
  division: string | null;
  created_at: Date;
}

function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    ageGroup: row.age_group,
    season: row.season,
    coach: row.coach,
    assistantCoach: row.assistant_coach ?? undefined,
    region: row.region ?? undefined,
    division: row.division ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export async function teamsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) {
      return { status: 401, jsonBody: { error: 'Not authenticated' } };
    }

    if (req.method === 'GET') {
      const rows = await query<TeamRow>(
        'SELECT * FROM team WHERE owner_id = $1 ORDER BY created_at',
        [user.id],
      );
      return { status: 200, jsonBody: rows.map(toTeam) };
    }

    // POST — create, subject to the teams limit
    const denied = await enforceLimit(user.id, 'teams');
    if (denied) {
      return { status: denied.status, jsonBody: denied.body };
    }

    const body = (await req.json()) as Partial<Team>;
    if (!body.name?.trim()) {
      return { status: 400, jsonBody: { error: 'name is required' } };
    }

    const row = await queryOne<TeamRow>(
      `INSERT INTO team (owner_id, name, age_group, season, coach,
                         assistant_coach, region, division)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        user.id,
        body.name.trim(),
        body.ageGroup ?? '',
        body.season ?? '',
        body.coach ?? '',
        body.assistantCoach ?? null,
        body.region ?? null,
        body.division ?? null,
      ],
    );

    return { status: 201, jsonBody: row ? toTeam(row) : null };
  } catch (err) {
    ctx.error('teams failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('teams', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'teams',
  handler: teamsHandler,
});
