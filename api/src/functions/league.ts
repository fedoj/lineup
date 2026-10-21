import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { randomUUID } from 'node:crypto';
import {
  CANCEL_REASONS,
  canOnScope,
  canOnTeam,
  cancelLabel,
  cancelReasonOf,
  FORMATS,
  isValidFormation,
  type AccessContext,
  type Format,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext, denyResponse, guardTeam, loadTeamContext, reachableTeamIds, TEAM_ARCHIVED } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { fixtureLocked } from '../lib/gameLock.js';
import type { PoolClient } from 'pg';
import { appToday } from '../lib/today.js';
import { enforceFeature, enforceTeamScopedLimit } from '../lib/entitlements.js';
import { calendarLink } from '../lib/links.js';
import { loadFixtureReferees, loadRefereePool, notifyFixtureReferees, type FixtureReferees } from './referees.js';
import { competitionForGame } from './competitions.js';

/**
 * League scheduling.
 *
 * An org admin (any region) or a region director/admin (their region) puts a
 * game between two teams on the calendar. It is written to both teams as a
 * normal game row linked by fixture_id, so match day, lineups, stats and
 * standings all work as before. Coaches see it appear on their team.
 *
 * The calendar is read with the same visibility as standings: anyone with a
 * role at the org/region, or a team inside it, sees that schedule.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

interface ScopeTeam {
  id: string;
  name: string;
  org_id: string;
  org_personal: boolean;
  region_id: string | null;
  region_name: string | null;
  region_personal: boolean | null;
  division_id: string | null;
}

const TEAM_COLUMNS = `t.id, t.name, t.org_id, o.is_personal AS org_personal,
  t.region_id, r.name AS region_name, r.is_personal AS region_personal, t.division_id`;
const TEAM_JOINS = `FROM team t
  JOIN organization o ON o.id = t.org_id
  LEFT JOIN region r ON r.id = t.region_id`;

/**
 * A team with no league above it. Teams in a standalone region (the Region
 * plan) sit in a hidden personal organization too, but their region is real,
 * so they belong to a league.
 */
function isStandaloneTeam(t: Pick<ScopeTeam, 'org_personal' | 'region_id' | 'region_personal'>): boolean {
  return t.org_personal && !(t.region_id && t.region_personal === false);
}

/** Teams covered by a scope the caller may read, or null when they may not. */
async function teamsInScope(
  access: AccessContext,
  userId: string,
  scope: string,
  id: string,
): Promise<{ title: string; orgId: string | null; teams: ScopeTeam[] } | null> {
  if (scope === 'team') {
    // Where the team sits and its row for the calendar, read together.
    const [team, rows] = await Promise.all([
      loadTeamContext(id),
      query<ScopeTeam>(`SELECT ${TEAM_COLUMNS} ${TEAM_JOINS} WHERE t.id = $1`, [id]),
    ]);
    if (!team || !canOnTeam(access, team, 'game.view').allowed) return null;
    if (!rows[0]) return null;
    return { title: rows[0].name, orgId: isStandaloneTeam(rows[0]) ? null : rows[0].org_id, teams: rows };
  }

  const reachable = new Set(await reachableTeamIds(userId));

  if (scope === 'region') {
    const r = await queryOne<{ id: string; name: string; org_id: string; is_personal: boolean }>(
      'SELECT id, name, org_id, is_personal FROM region WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!r || r.is_personal) return null;
    const teams = await query<ScopeTeam>(
      `SELECT ${TEAM_COLUMNS} ${TEAM_JOINS} WHERE t.region_id = $1 AND t.deleted_at IS NULL ORDER BY t.name`,
      [r.id],
    );
    const allowed =
      canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.view').allowed ||
      teams.some((t) => reachable.has(t.id));
    return allowed ? { title: r.name, orgId: r.org_id, teams } : null;
  }

  if (scope === 'org') {
    const o = await queryOne<{ id: string; name: string; is_personal: boolean }>(
      'SELECT id, name, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!o || o.is_personal) return null;
    const teams = await query<ScopeTeam>(
      `SELECT ${TEAM_COLUMNS} ${TEAM_JOINS} WHERE t.org_id = $1 AND t.deleted_at IS NULL ORDER BY t.name`,
      [o.id],
    );
    const allowed =
      canOnScope(access, { orgId: o.id }, 'team.view').allowed ||
      teams.some((t) => reachable.has(t.id));
    return allowed ? { title: o.name, orgId: o.id, teams } : null;
  }

  return null;
}

/**
 * League scheduling is an org- or region-level act. canOnScope never matches
 * a team-level membership, so a coach cannot schedule other teams' games.
 * Staff and the scheduler role (Fady, 10/20) schedule and edit games;
 * deleting one stays with staff (canManageGames).
 */
function canSchedule(access: AccessContext, t: { org_id: string; region_id: string | null }): boolean {
  return canOnScope(access, { orgId: t.org_id, regionId: t.region_id }, 'fixture.schedule').allowed;
}

function canManageGames(access: AccessContext, t: { org_id: string; region_id: string | null }): boolean {
  return canOnScope(access, { orgId: t.org_id, regionId: t.region_id }, 'game.create').allowed;
}

/* --------------------------------------------------------------- calendar */

interface CalendarRow {
  id: string;
  team_id: string;
  team_name: string;
  date: Date | null;
  opponent: string;
  us: number;
  them: number;
  is_home: boolean;
  kickoff: string | null;
  location: string | null;
  field: string | null;
  fixture_id: string | null;
  home_team_id: string | null;
  home_name: string | null;
  away_team_id: string | null;
  away_name: string | null;
  f_org_id: string | null;
  home_region_id: string | null;
  away_region_id: string | null;
  is_friendly: boolean | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  cancel_note: string | null;
  competition_id: string | null;
  competition_name: string | null;
  competition_kind: string | null;
  /** A friendly between two Lineup teams: both copies share it. */
  pair_id: string | null;
  opponent_team_id: string | null;
  /** The region field at this game's location, when it has a field map. */
  field_map_id: string | null;
}

async function loadCalendarRows(teamIds: string[]): Promise<CalendarRow[]> {
  if (teamIds.length === 0) return [];
  return query<CalendarRow>(
    `SELECT g.id, g.team_id, t.name AS team_name, g.date, g.opponent, g.us, g.them,
            g.is_home, COALESCE(f.kickoff, g.kickoff) AS kickoff,
            COALESCE(f.location, g.location) AS location,
            COALESCE(f.field, g.field) AS field,
            f.id AS fixture_id, f.home_team_id, th.name AS home_name,
            f.away_team_id, ta.name AS away_name, f.org_id AS f_org_id,
            th.region_id AS home_region_id, ta.region_id AS away_region_id,
            g.is_friendly, g.canceled_at, g.cancel_reason, g.cancel_note,
            cp.id AS competition_id, cp.name AS competition_name, cp.kind AS competition_kind,
            fm.id AS field_map_id, g.pair_id, g.opponent_team_id
       FROM game g
       JOIN team t ON t.id = g.team_id
       LEFT JOIN fixture f ON f.id = g.fixture_id AND f.deleted_at IS NULL
       LEFT JOIN team th ON th.id = f.home_team_id
       LEFT JOIN team ta ON ta.id = f.away_team_id
       LEFT JOIN competition cp ON cp.id = g.competition_id AND cp.deleted_at IS NULL
       -- The home side's region field at this location, if it has a map.
       LEFT JOIN LATERAL (
         SELECT rf.id FROM region_field rf
          WHERE rf.region_id = COALESCE(th.region_id, t.region_id) AND rf.map_data IS NOT NULL
            AND lower(trim(rf.location)) = lower(trim(COALESCE(f.location, g.location)))
          LIMIT 1
       ) fm ON true
      WHERE g.team_id = ANY($1::uuid[]) AND g.deleted_at IS NULL
      ORDER BY g.date NULLS LAST, COALESCE(f.kickoff, g.kickoff) NULLS LAST, g.game_no`,
    [teamIds],
  );
}

interface CalendarEntry {
  id: string;
  fixtureId: string | null;
  date: string | null;
  kickoff: string | null;
  location: string | null;
  field: string | null;
  /** A region field map for the location. */
  fieldMapId?: string | null;
  home: { id: string | null; name: string };
  away: { id: string | null; name: string };
  score: { home: number; away: number } | null;
  league: boolean;
  /** A team's own game marked as a friendly (never a league fixture). */
  friendly: boolean;
  canManage: boolean;
  /** The caller may edit this team-added game (date, opponent, score). */
  canEdit: boolean;
  /** Cancelled, with why; a cancelled game has no score. */
  canceled: boolean;
  cancelReason: string | null;
  cancelLabel: string | null;
  cancelNote: string | null;
  /** The caller may cancel this game, or undo a cancellation. */
  canCancel: boolean;
  links: Array<{ teamId: string; gameId: string; teamName: string }>;
  /** League games: the organization they belong to, and who referees them. */
  orgId?: string | null;
  referees?: Record<'main' | 'ar1' | 'ar2', { name: string; userId?: string } | null> | null;
  /** The referee submitted the final score: it is the official result. */
  official?: boolean;
  /** The caller may open the referee's match screen (a referee on it, or its organizers). */
  canOpenRefMatch?: boolean;
  /** The league or tournament it is played in. */
  competition?: { id: string; name: string; kind: string } | null;
}

/**
 * One entry per game, with both halves of a league fixture merged. Access and
 * reachable teams are omitted for the public view, which then carries no
 * management rights and no links back into the app.
 */
function buildEntries(
  rows: CalendarRow[],
  access: AccessContext | null,
  reachable: Set<string> | null,
  teamsById: Map<string, ScopeTeam> = new Map(),
): CalendarEntry[] {
  const today = appToday();
  const entries = new Map<string, CalendarEntry>();

  for (const r of rows) {
    const date = r.date ? r.date.toISOString().slice(0, 10) : null;
    // A friendly between two Lineup teams is one entry, like a league fixture.
    const key = r.fixture_id ?? r.pair_id ?? r.id;
    const existing = entries.get(key);
    const link = reachable?.has(r.team_id) ? { teamId: r.team_id, gameId: r.id, teamName: r.team_name } : null;

    if (existing) {
      if (link) existing.links.push(link);
      continue;
    }

    let home: { id: string | null; name: string };
    let away: { id: string | null; name: string };
    let homeScore: number;
    let awayScore: number;
    if (r.fixture_id && r.home_team_id && r.away_team_id) {
      home = { id: r.home_team_id, name: r.home_name ?? 'Home' };
      away = { id: r.away_team_id, name: r.away_name ?? 'Away' };
      const isHomeRow = r.team_id === r.home_team_id;
      homeScore = isHomeRow ? r.us : r.them;
      awayScore = isHomeRow ? r.them : r.us;
    } else {
      const self = { id: r.team_id, name: r.team_name };
      const other = { id: r.opponent_team_id, name: r.opponent || 'TBD' };
      home = r.is_home ? self : other;
      away = r.is_home ? other : self;
      homeScore = r.is_home ? r.us : r.them;
      awayScore = r.is_home ? r.them : r.us;
    }

    const played = !r.canceled_at && (r.us + r.them > 0 || (date !== null && date < today));
    const manageable =
      access !== null &&
      Boolean(r.fixture_id && r.f_org_id) &&
      canSchedule(access, { org_id: r.f_org_id!, region_id: r.home_region_id }) &&
      canSchedule(access, { org_id: r.f_org_id!, region_id: r.away_region_id });
    const owner = teamsById.get(r.team_id);
    const editable =
      access !== null &&
      !r.fixture_id &&
      Boolean(owner) &&
      canOnTeam(
        access,
        { teamId: r.team_id, orgId: owner!.org_id, regionId: owner!.region_id, divisionId: owner!.division_id },
        'game.edit',
      ).allowed;

    entries.set(key, {
      id: key,
      fixtureId: r.fixture_id,
      date,
      kickoff: r.kickoff,
      location: r.location,
      field: r.field,
      // The region's field map for this location (signed-in views only).
      fieldMapId: access ? r.field_map_id : null,
      home,
      away,
      score: played ? { home: homeScore, away: awayScore } : null,
      league: Boolean(r.fixture_id),
      friendly: !r.fixture_id && r.is_friendly !== false,
      canManage: manageable,
      canEdit: editable,
      canceled: Boolean(r.canceled_at),
      cancelReason: r.cancel_reason,
      cancelLabel: r.canceled_at ? cancelLabel(r.cancel_reason) : null,
      cancelNote: r.cancel_note,
      // League games are cancelled by the league's staff; a team's own games
      // by the coaches who can edit them.
      canCancel: r.fixture_id ? manageable : editable,
      links: link ? [link] : [],
      orgId: r.fixture_id ? r.f_org_id : null,
      competition: r.competition_id
        ? { id: r.competition_id, name: r.competition_name ?? '', kind: r.competition_kind ?? 'season' }
        : null,
    });
  }
  return [...entries.values()];
}

/** May the caller publish a read-only link to this scope's calendar? */
async function canShareCalendar(access: AccessContext, scope: string, id: string): Promise<boolean> {
  if (scope === 'team') {
    const team = await loadTeamContext(id);
    return Boolean(team && canOnTeam(access, team, 'calendar.share').allowed);
  }
  if (scope === 'region') {
    const r = await queryOne<{ org_id: string }>(
      'SELECT org_id FROM region WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    return Boolean(r && canOnScope(access, { orgId: r.org_id, regionId: id }, 'game.create').allowed);
  }
  if (scope === 'org') {
    const o = await queryOne<{ id: string }>(
      'SELECT id FROM organization WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    return Boolean(o && canOnScope(access, { orgId: id }, 'game.create').allowed);
  }
  return false;
}

export async function calendarHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const scope = req.query.get('scope') ?? '';
    const id = req.query.get('id') ?? '';
    if (!id || !['team', 'region', 'org'].includes(scope)) {
      return { status: 400, jsonBody: { error: 'scope (team, region or org) and id are required' } };
    }

    // The caller, what they can reach and (for a team) the team itself are independent.
    const [access, reachableIds] = await Promise.all([
      buildAccessContext(user),
      reachableTeamIds(user.id),
      scope === 'team' ? loadTeamContext(id).catch(() => null) : null,
    ]);
    const resolved = await teamsInScope(access, user.id, scope, id);
    if (!resolved) return FORBIDDEN;

    const reachable = new Set(reachableIds);
    // Independent reads for the page, together.
    const [calendarRows, orgTeams, scopeTeam, canShare] = await Promise.all([
      loadCalendarRows(resolved.teams.map((t) => t.id)),
      resolved.orgId === null
        ? Promise.resolve([] as ScopeTeam[])
        : query<ScopeTeam>(
            `SELECT ${TEAM_COLUMNS} ${TEAM_JOINS}
              WHERE t.org_id = $1 AND t.deleted_at IS NULL ORDER BY r.name NULLS LAST, t.name`,
            [resolved.orgId],
          ),
      scope === 'team' ? loadTeamContext(id) : Promise.resolve(null),
      canShareCalendar(access, scope, id),
    ]);
    const entries = buildEntries(calendarRows, access, reachable, new Map(resolved.teams.map((t) => [t.id, t])));

    // Who referees each league game; staff who manage a game also get the
    // organization's referees to fill its spots.
    const fixtureIds = entries.filter((e) => e.fixtureId).map((e) => e.fixtureId!);
    const poolOrgs = [...new Set(entries.filter((e) => e.canManage && e.orgId).map((e) => e.orgId!))];
    const [refs, officialRows, pools] = await Promise.all([
      loadFixtureReferees(fixtureIds).catch(() => new Map<string, FixtureReferees>()),
      fixtureIds.length
        ? query<{ fixture_id: string }>(
            'SELECT fixture_id FROM fixture_ref_report WHERE fixture_id = ANY($1::uuid[]) AND final_at IS NOT NULL',
            [fixtureIds],
          ).catch(() => [])
        : Promise.resolve([]),
      loadRefereePool(poolOrgs).catch(() => new Map()),
    ]);
    const official = new Set(officialRows.map((r) => r.fixture_id));
    for (const e of entries) {
      if (!e.fixtureId) continue;
      const r = refs.get(e.fixtureId);
      const show = (h: { userId: string; name: string } | null | undefined) =>
        h ? (e.canManage ? { name: h.name, userId: h.userId } : { name: h.name }) : null;
      e.referees = { main: show(r?.main), ar1: show(r?.ar1), ar2: show(r?.ar2) };
      e.official = official.has(e.fixtureId);
      e.canOpenRefMatch = e.canManage || [r?.main, r?.ar1, r?.ar2].some((h) => h?.userId === user.id);
    }
    const refereePools = Object.fromEntries(poolOrgs.map((o) => [o, pools.get(o) ?? []]));

    const schedulable = orgTeams
      .filter((t) => canSchedule(access, t))
      .map((t) => ({
        id: t.id,
        name: t.name,
        regionName: t.region_personal ? null : t.region_name,
      }));

    let canAddFriendly = false;
    let canAddGame = false;
    let canApproveLineups = false;
    if (scope === 'team') {
      const t = scopeTeam;
      canAddFriendly = Boolean(t && canOnTeam(access, t, 'game.create').allowed);
      // Regular (non-friendly) games: only a standalone team adds its own.
      canAddGame = canAddFriendly && Boolean(resolved.teams[0] && isStandaloneTeam(resolved.teams[0]));
      // Coaches decide whether the assistant changes a game's lineup without approval.
      canApproveLineups = Boolean(t && canOnTeam(access, t, 'team.edit').allowed);
    }

    return {
      status: 200,
      jsonBody: {
        scope,
        id,
        title: resolved.title,
        entries,
        schedulable,
        canSchedule: schedulable.length >= 2,
        canShare,
        canAddFriendly,
        canAddGame,
        canApproveLineups,
        refereePools,
      },
    };
  } catch (err) {
    ctx.error('calendar failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* --------------------------------------------------------------- fixtures */

interface FixtureBody {
  id?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  date?: string;
  kickoff?: string | null;
  location?: string | null;
  field?: string | null;
  /** The league or tournament it is played in (both teams must take part). */
  competitionId?: string | null;
}

function defaultFormation(format: string, preferred: string | null): string {
  if (preferred && isValidFormation(format as Format, preferred)) return preferred;
  return FORMATS[format as Format]?.defaultFormation ?? '2-3-1';
}

interface GameSetupRow {
  id: string;
  name: string;
  org_id: string;
  format: string | null;
  periods: string | null;
  period_length_sec: number | null;
  default_formation: string | null;
}

async function insertGameRow(
  c: PoolClient,
  team: GameSetupRow,
  g: {
    date: string;
    opponent: string;
    isHome: boolean;
    kickoff: string | null;
    location: string | null;
    fixtureId: string | null;
    competitionId: string | null;
  },
): Promise<string> {
  const format = team.format ?? '7v7';
  // Serialise numbering per team so two schedulers cannot collide.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [team.id]);
  const r = await c.query<{ id: string }>(
    `INSERT INTO game (team_id, game_no, date, opponent, is_home, format, periods,
                       period_length_sec, formation, fixture_id, kickoff, location, competition_id)
     VALUES ($1, (SELECT COALESCE(MAX(game_no), 0) + 1 FROM game WHERE team_id = $1),
             $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      team.id, g.date, g.opponent, g.isHome, format, team.periods ?? 'quarters', team.period_length_sec ?? 720,
      defaultFormation(format, team.default_formation), g.fixtureId, g.kickoff, g.location, g.competitionId,
    ],
  );
  return r.rows[0].id;
}

async function gameSetup(c: PoolClient, teamId: string): Promise<GameSetupRow> {
  const r = await c.query<GameSetupRow>(
    'SELECT id, name, org_id, format, periods, period_length_sec, default_formation FROM team WHERE id = $1',
    [teamId],
  );
  if (!r.rows[0]) throw new Error('team not found');
  return r.rows[0];
}

/**
 * A league game between two teams of one organization, inside a transaction:
 * the fixture plus each team's game row (a scheduled bracket match uses it).
 */
export async function insertLeagueGame(
  c: PoolClient,
  g: { homeTeamId: string; awayTeamId: string; date: string; kickoff: string | null; location: string | null; userId: string; competitionId: string },
): Promise<string> {
  const [home, away] = [await gameSetup(c, g.homeTeamId), await gameSetup(c, g.awayTeamId)];
  const f = await c.query<{ id: string }>(
    `INSERT INTO fixture (org_id, home_team_id, away_team_id, date, kickoff, location, created_by, competition_id)
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8) RETURNING id`,
    [home.org_id, home.id, away.id, g.date, g.kickoff, g.location, g.userId, g.competitionId],
  );
  const fixtureId = f.rows[0].id;
  for (const [self, other, isHome] of [
    [home, away, true],
    [away, home, false],
  ] as const) {
    await insertGameRow(c, self, { date: g.date, opponent: other.name, isHome, kickoff: g.kickoff, location: g.location, fixtureId, competitionId: g.competitionId });
  }
  return fixtureId;
}

/** One team's game against an opponent by name, inside a transaction (a bracket match). */
export async function insertTeamGame(
  c: PoolClient,
  g: { teamId: string; opponent: string; isHome: boolean; date: string; kickoff: string | null; location: string | null; competitionId: string },
): Promise<string> {
  return insertGameRow(c, await gameSetup(c, g.teamId), { ...g, fixtureId: null });
}

export async function fixturesHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    if (req.method === 'DELETE' || req.method === 'PATCH') {
      const body: FixtureBody = req.method === 'PATCH' ? ((await req.json()) as FixtureBody) : {};
      const fixtureId = req.method === 'DELETE' ? req.query.get('id') ?? '' : clip(body.id, 40);
      if (!fixtureId) return { status: 400, jsonBody: { error: 'id is required' } };

      const f = await queryOne<{
        id: string;
        org_id: string;
        home_region: string | null;
        away_region: string | null;
      }>(
        `SELECT f.id, f.org_id, th.region_id AS home_region, ta.region_id AS away_region
           FROM fixture f
           JOIN team th ON th.id = f.home_team_id
           JOIN team ta ON ta.id = f.away_team_id
          WHERE f.id = $1 AND f.deleted_at IS NULL`,
        [fixtureId],
      );
      if (!f) return FORBIDDEN;
      if (
        !canSchedule(access, { org_id: f.org_id, region_id: f.home_region }) ||
        !canSchedule(access, { org_id: f.org_id, region_id: f.away_region })
      ) {
        return FORBIDDEN;
      }
      // A scheduler edits games but never deletes them; that stays with staff.
      if (
        req.method === 'DELETE' &&
        !(
          canManageGames(access, { org_id: f.org_id, region_id: f.home_region }) &&
          canManageGames(access, { org_id: f.org_id, region_id: f.away_region })
        )
      ) {
        return FORBIDDEN;
      }
      if (req.method === 'PATCH') {
        const lock = await fixtureLocked(f.id);
        if (lock) return lock;
      }

      if (req.method === 'DELETE') {
        await transaction(async (c) => {
          await c.query('UPDATE fixture SET deleted_at = now() WHERE id = $1', [f.id]);
          await c.query('UPDATE game SET deleted_at = now() WHERE fixture_id = $1', [f.id]);
        });
        const fx = await queryOne<{ home: string; away: string; date: string | null }>(
          `SELECT th.name AS home, ta.name AS away, to_char(f.date, 'YYYY-MM-DD') AS date
             FROM fixture f JOIN team th ON th.id = f.home_team_id JOIN team ta ON ta.id = f.away_team_id
            WHERE f.id = $1`,
          [f.id],
        ).catch(() => null);
        if (fx) {
          await notifyFixtureReferees(
            f.id,
            user.id,
            `Game removed: ${fx.home} vs ${fx.away}`,
            `The game on ${prettyDay(fx.date)} was taken off the calendar, so your spot on it is gone.`,
          ).catch((e) => ctx.warn('referee notify failed', e));
        }
        return { status: 204 };
      }

      if (body.date !== undefined && !DATE_RE.test(String(body.date))) {
        return { status: 400, jsonBody: { error: 'date must be YYYY-MM-DD' } };
      }
      if (body.kickoff && !TIME_RE.test(body.kickoff)) {
        return { status: 400, jsonBody: { error: 'kickoff must be HH:MM' } };
      }
      // undefined leaves a field alone; '' or null clears an optional one.
      const opt = (v: string | null | undefined, max: number) =>
        v === undefined ? undefined : clip(v, max) || null;
      const kickoff = opt(body.kickoff, 5);
      const location = opt(body.location, 160);
      const field = opt(body.field, 40);

      await transaction(async (c) => {
        await c.query(
          `UPDATE fixture SET
             date = COALESCE($2::date, date),
             kickoff = CASE WHEN $3 THEN $4 ELSE kickoff END,
             location = CASE WHEN $5 THEN $6 ELSE location END,
             field = CASE WHEN $7 THEN $8 ELSE field END
           WHERE id = $1`,
          [
            f.id,
            body.date ?? null,
            kickoff !== undefined, kickoff ?? null,
            location !== undefined, location ?? null,
            field !== undefined, field ?? null,
          ],
        );
        await c.query(
          `UPDATE game g SET date = f.date, kickoff = f.kickoff, location = f.location,
                  field = f.field, updated_at = now()
             FROM fixture f
            WHERE f.id = $1 AND g.fixture_id = f.id`,
          [f.id],
        );
      });
      return { status: 200, jsonBody: { id: f.id } };
    }

    // POST — schedule a new league game.
    const body = (await req.json()) as FixtureBody;
    const homeId = clip(body.homeTeamId, 40);
    const awayId = clip(body.awayTeamId, 40);
    const date = clip(body.date, 10);
    const kickoff = clip(body.kickoff, 5) || null;
    if (!homeId || !awayId || !DATE_RE.test(date)) {
      return { status: 400, jsonBody: { error: 'Home team, away team and a date are required.' } };
    }
    // Every new game needs its kick-off and place (Fady, 10/16).
    if (!kickoff || !clip(body.location, 160)) {
      return { status: 400, jsonBody: { error: 'Kick-off time and location are required.', code: 'WHEN_WHERE_REQUIRED' } };
    }
    if (homeId === awayId) {
      return { status: 400, jsonBody: { error: 'A team cannot play itself.' } };
    }
    if (kickoff && !TIME_RE.test(kickoff)) {
      return { status: 400, jsonBody: { error: 'Kick-off must be a time like 09:30.' } };
    }

    // League games belong to a league or tournament (Fady, 10/16).
    if (!clip(body.competitionId, 36)) {
      return {
        status: 400,
        jsonBody: {
          error: 'League games are scheduled inside a league or tournament. Open Leagues & tournaments to add one.',
          code: 'COMPETITION_REQUIRED',
        },
      };
    }

    const teams = await query<
      ScopeTeam & {
        format: string | null;
        periods: string | null;
        period_length_sec: number | null;
        default_formation: string | null;
        archived: boolean;
      }
    >(
      `SELECT ${TEAM_COLUMNS}, t.format, t.periods, t.period_length_sec, t.default_formation,
              (t.archived_at IS NOT NULL) AS archived
         ${TEAM_JOINS}
        WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL`,
      [[homeId, awayId]],
    );
    const home = teams.find((t) => t.id === homeId);
    const away = teams.find((t) => t.id === awayId);
    if (!home || !away) return FORBIDDEN;
    if (home.archived || away.archived) return TEAM_ARCHIVED;
    if (isStandaloneTeam(home) || home.org_id !== away.org_id) {
      return {
        status: 400,
        jsonBody: { error: 'League games are between two teams in the same organization.' },
      };
    }
    for (const t of [home, away]) {
      if (!canSchedule(access, t)) {
        return denyResponse(
          canOnScope(access, { orgId: t.org_id, regionId: t.region_id }, 'fixture.schedule'),
        );
      }
      const denied = await enforceTeamScopedLimit(user.id, t.id, 'gamesPerTeam');
      if (denied) return { status: denied.status, jsonBody: denied.body };
    }

    const location = clip(body.location, 160) || null;
    const field = clip(body.field, 40) || null;
    const comp = await competitionForGame(access, user.id, body.competitionId, date, [home.id, away.id]);
    if ('error' in comp) return comp.error;

    const fixtureId = await transaction(async (c) => {
      const f = await c.query<{ id: string }>(
        `INSERT INTO fixture (org_id, home_team_id, away_team_id, date, kickoff, location, field, created_by, competition_id)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9) RETURNING id`,
        [home.org_id, home.id, away.id, date, kickoff, location, field, user.id, comp.id],
      );
      const id = f.rows[0].id;
      for (const [self, other, isHome] of [
        [home, away, true],
        [away, home, false],
      ] as const) {
        const format = self.format ?? '7v7';
        // Serialise numbering per team so two schedulers cannot collide.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [self.id]);
        await c.query(
          `INSERT INTO game (team_id, game_no, date, opponent, is_home, format, periods,
                             period_length_sec, formation, fixture_id, kickoff, location, field, competition_id)
           VALUES ($1,
                   (SELECT COALESCE(MAX(game_no), 0) + 1 FROM game WHERE team_id = $1),
                   $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            self.id, date, other.name, isHome, format,
            self.periods ?? 'quarters', self.period_length_sec ?? 720,
            defaultFormation(format, self.default_formation),
            id, kickoff, location, field, comp.id,
          ],
        );
      }
      return id;
    });

    return { status: 201, jsonBody: { id: fixtureId } };
  } catch (err) {
    ctx.error('fixtures failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* -------------------------------------------------------------- friendlies */

/**
 * Lineup teams a game can be played against (Fady, 10/19; 10/20).
 *
 * Two separate worlds: a team in an organization or region plays the other
 * teams of that organization or region, and a coach's own (standalone) team
 * plays other standalone teams only, never a league team, even one the same
 * coach also coaches. A standalone team sees the standalone teams its coach
 * is on, and finds any other standalone team by name (`search`, 3 letters or
 * more, 60 results). Not the team itself, and never deleted or archived teams.
 */
async function friendlyOpponents(userId: string, teamId: string, search?: string) {
  const own = await queryOne<{ org_id: string; org_personal: boolean; region_id: string | null; region_personal: boolean | null }>(
    `SELECT t.org_id, o.is_personal AS org_personal, t.region_id, r.is_personal AS region_personal
       FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
      WHERE t.id = $1`,
    [teamId],
  );
  if (!own) return { standalone: false, rows: [] };
  const reachable = await reachableTeamIds(userId);
  type Row = { id: string; name: string; region_name: string | null; org_name: string | null; mine: boolean };
  const standaloneOwn = own.org_personal && !(own.region_id && own.region_personal === false);
  if (standaloneOwn) {
    const q = (search ?? '').trim().slice(0, 40);
    const rows = await query<Row>(
      `SELECT t.id, t.name, NULL::text AS region_name, NULL::text AS org_name, (t.id = ANY($2::uuid[])) AS mine
         FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
        WHERE t.id <> $1 AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND o.is_personal AND NOT (t.region_id IS NOT NULL AND r.is_personal = false)
          AND (t.id = ANY($2::uuid[]) OR (length($3) >= 3 AND t.name ILIKE '%' || $3 || '%'))
        ORDER BY (t.id = ANY($2::uuid[])) DESC, t.name
        LIMIT 60`,
      [teamId, reachable, q.replace(/[%_\\]/g, '')],
    );
    return { standalone: true, rows };
  }
  // A real organization, or a standalone region inside a hidden personal one.
  const sameLeagueOrg = !own.org_personal ? own.org_id : null;
  const sameLeagueRegion = own.org_personal && own.region_id && own.region_personal === false ? own.region_id : null;
  const rows = await query<Row>(
    `SELECT t.id, t.name, CASE WHEN r.is_personal THEN NULL ELSE r.name END AS region_name,
            CASE WHEN o.is_personal THEN NULL ELSE o.name END AS org_name,
            (t.id = ANY($4::uuid[])) AS mine
       FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
      WHERE t.id <> $1 AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND (($2::uuid IS NOT NULL AND t.org_id = $2) OR ($3::uuid IS NOT NULL AND t.region_id = $3))
      ORDER BY (t.id = ANY($4::uuid[])) DESC, r.name NULLS FIRST, t.name
      LIMIT 500`,
    [teamId, sameLeagueOrg, sameLeagueRegion, reachable],
  );
  return { standalone: false, rows };
}
/** The opponent team, when this team may play it (the rules in friendlyOpponents). */
async function allowedOpponent(userId: string, teamId: string, opponentId: string): Promise<{ id: string; name: string } | null> {
  const listed = (await friendlyOpponents(userId, teamId)).rows.find((t) => t.id === opponentId);
  if (listed) return listed;
  // A standalone team may play any other standalone team, found by name.
  const pair = await query<{ id: string; name: string; standalone: boolean }>(
    `SELECT t.id, t.name, (o.is_personal AND NOT (t.region_id IS NOT NULL AND r.is_personal = false)) AS standalone
       FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id
      WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
    [[teamId, opponentId]],
  );
  const mine = pair.find((t) => t.id === teamId);
  const them = pair.find((t) => t.id === opponentId);
  return mine?.standalone && them?.standalone && teamId !== opponentId ? { id: them.id, name: them.name } : null;
}

/**
 * A coach schedules their own game (a friendly). It belongs to one team, is
 * marked as not-league by having no fixture, and so never counts toward
 * region or organization standings. Against another Lineup team
 * (opponentTeamId), the game goes on both calendars, paired, and that team's
 * people are told (Fady, 10/19).
 */
export async function friendliesHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    // The teams this team can play a friendly against.
    if (req.method === 'GET') {
      const guard = await guardTeam(user, clip(req.query.get('teamId'), 40) || undefined, 'game.create');
      if (!guard.ok) return guard.response;
      const { standalone, rows } = await friendlyOpponents(user.id, guard.team.teamId, clip(req.query.get('search'), 40));
      return {
        status: 200,
        jsonBody: {
          // A coach's own team finds other standalone teams by name.
          searchable: standalone,
          // A team in an organization or region requests friendlies with its other teams (Shadi, 10/20).
          requestOnly: !standalone,
          opponents: rows.map((r) => ({ id: r.id, name: r.name, regionName: r.region_name, orgName: r.org_name, mine: r.mine })),
        },
      };
    }

    const b = (await req.json()) as {
      teamId?: string;
      opponent?: string;
      /** Another Lineup team: the game goes on its calendar too. */
      opponentTeamId?: string | null;
      date?: string;
      kickoff?: string | null;
      isHome?: boolean;
      location?: string | null;
      field?: string | null;
      /** 'game' for a regular game; standalone teams only. Default friendly. */
      kind?: 'friendly' | 'game';
      /** Coaches only: the assistant coach may change this game's lineup without approval. */
      assistantFree?: boolean;
      /** The league or tournament it is played in (one the caller runs). */
      competitionId?: string | null;
    };
    const guard = await guardTeam(user, clip(b.teamId, 40) || undefined, 'game.create');
    if (!guard.ok) return guard.response;
    // Only a coach (or above) decides that; on a game an assistant creates it stays off.
    const assistantFree = Boolean(b.assistantFree) && canOnTeam(guard.ctx, guard.team, 'team.edit').allowed;

    // Inside an organization or region, league and tournament games are
    // scheduled by its staff, and a coach only requests friendlies against
    // its other teams (Shadi, 10/20). A standalone team has no league, so its
    // coach records both.
    const regular = b.kind === 'game';
    const home = await queryOne<ScopeTeam>(`SELECT ${TEAM_COLUMNS} ${TEAM_JOINS} WHERE t.id = $1`, [guard.team.teamId]);
    if (!home) return FORBIDDEN;
    const leagueTeam = !isStandaloneTeam(home);
    if (leagueTeam && (regular || clip(b.competitionId, 36))) {
      return {
        status: 403,
        jsonBody: {
          error: 'This team plays in an organization or region, so its league and tournament games are scheduled there. You can request a friendly.',
          code: 'LEAGUE_SCHEDULES_GAMES',
        },
      };
    }
    if (leagueTeam && !clip(b.opponentTeamId, 40)) {
      return {
        status: 400,
        jsonBody: { error: 'Pick the team you would like to play from your region or organization.', code: 'PICK_TEAM' },
      };
    }
    // A regular game belongs to a league or tournament (Fady, 10/16); a
    // friendly can stand on its own.
    if (regular && !clip(b.competitionId, 36)) {
      return {
        status: 400,
        jsonBody: {
          error: 'Games are scheduled inside a league or tournament. You can add a friendly here.',
          code: 'COMPETITION_REQUIRED',
        },
      };
    }

    // Against another Lineup team: it has to be one this team may play.
    let opponentTeam: { id: string; name: string } | null = null;
    const opponentTeamId = clip(b.opponentTeamId, 40);
    if (opponentTeamId) {
      if (regular) return { status: 400, jsonBody: { error: 'Pick another Lineup team for a friendly only.' } };
      opponentTeam = await allowedOpponent(user.id, guard.team.teamId, opponentTeamId);
      if (!opponentTeam) {
        return { status: 400, jsonBody: { error: 'That team can’t be picked. Type its name instead.', code: 'OPPONENT_NOT_ALLOWED' } };
      }
    }
    const opponent = opponentTeam ? opponentTeam.name.slice(0, 80) : clip(b.opponent, 80);
    const date = clip(b.date, 10);
    const kickoff = clip(b.kickoff, 5) || null;
    if (!opponent || !DATE_RE.test(date)) {
      return { status: 400, jsonBody: { error: 'Opponent and a date are required.' } };
    }
    // Every new game needs its kick-off and place (Fady, 10/16).
    if (!kickoff || !clip(b.location, 160)) {
      return { status: 400, jsonBody: { error: 'Kick-off time and location are required.', code: 'WHEN_WHERE_REQUIRED' } };
    }
    if (kickoff && !TIME_RE.test(kickoff)) {
      return { status: 400, jsonBody: { error: 'Kick-off must be a time like 09:30.' } };
    }

    const denied = await enforceTeamScopedLimit(user.id, guard.team.teamId, 'gamesPerTeam');
    if (denied) return { status: denied.status, jsonBody: denied.body };

    // A team in an organization or region asks for a friendly; its staff
    // approve it before it goes on the calendars (Shadi, 10/20).
    if (leagueTeam) {
      return await requestFriendly(guard.ctx, user.id, home!, opponentTeam!, {
        date,
        kickoff,
        isHome: b.isHome !== false,
        location: clip(b.location, 160),
        field: clip(b.field, 40) || null,
        assistantFree,
      }, ctx);
    }

    // In a league or tournament the caller runs (for example a coach's own
    // season, or a tournament game against a team that is not on Lineup).
    const comp = await competitionForGame(guard.ctx, user.id, b.competitionId, date, [guard.team.teamId]);
    if ('error' in comp) return comp.error;
    // In an organization's or region's league or tournament both teams come
    // from its list; only a coach's own one takes opponents typed in by name.
    if (comp.id && !comp.coachOwned) {
      return {
        status: 400,
        jsonBody: { error: 'In this league or tournament both teams come from its list of teams.', code: 'PICK_FROM_LIST' },
      };
    }

    const { id, otherId } = await transaction((c) =>
      insertFriendlyGames(c, {
        teamId: guard.team.teamId,
        opponentTeam,
        opponent,
        date,
        kickoff,
        isHome: b.isHome !== false,
        location: clip(b.location, 160) || null,
        field: clip(b.field, 40) || null,
        regular,
        assistantFree,
        competitionId: comp.id,
      }),
    );

    // The other team's coaches, assistants, team parents and parents hear about it.
    if (opponentTeam && otherId) {
      await notifyNewFriendly({
        teamId: guard.team.teamId,
        opponentTeam,
        otherId,
        date,
        kickoff,
        isHome: b.isHome !== false,
        location: clip(b.location, 160) || null,
        except: [user.id],
      }).catch((e) => ctx.warn('friendly notify failed', e));
    }

    return { status: 201, jsonBody: { id, pairedGameId: otherId } };
  } catch (err) {
    ctx.error('friendlies failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* -------------------------------------------------------- friendly games */

interface FriendlyGameInput {
  teamId: string;
  opponentTeam: { id: string; name: string } | null;
  opponent: string;
  date: string;
  kickoff: string | null;
  isHome: boolean;
  location: string | null;
  field: string | null;
  regular: boolean;
  assistantFree: boolean;
  competitionId: string | null;
}

type TeamSetupRow = {
  name: string;
  format: string | null;
  periods: string | null;
  period_length_sec: number | null;
  default_formation: string | null;
};

/**
 * Writes a team's own game. Against another Lineup team the same friendly
 * goes on that team's calendar too, from their side, paired (Fady, 10/19).
 */
async function insertFriendlyGames(c: PoolClient, p: FriendlyGameInput): Promise<{ id: string; otherId: string | null }> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [p.teamId]);
  const team = (
    await c.query<TeamSetupRow>(
      'SELECT name, format, periods, period_length_sec, default_formation FROM team WHERE id = $1',
      [p.teamId],
    )
  ).rows[0];
  const format = team?.format ?? '7v7';
  const pairId = p.opponentTeam ? randomUUID() : null;
  const r = await c.query<{ id: string }>(
    `INSERT INTO game (team_id, game_no, date, opponent, is_home, format, periods,
                       period_length_sec, formation, kickoff, location, field, is_friendly, assistant_free, competition_id,
                       pair_id, opponent_team_id)
     VALUES ($1, (SELECT COALESCE(MAX(game_no), 0) + 1 FROM game WHERE team_id = $1),
             $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      p.teamId, p.date, p.opponent.slice(0, 80), p.isHome, format,
      team?.periods ?? 'quarters', team?.period_length_sec ?? 720,
      defaultFormation(format, team?.default_formation ?? null),
      p.kickoff, p.location, p.field, !p.regular, p.assistantFree, p.competitionId,
      pairId, p.opponentTeam?.id ?? null,
    ],
  );
  if (!p.opponentTeam) return { id: r.rows[0].id, otherId: null };
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [p.opponentTeam.id]);
  const t2 = (
    await c.query<TeamSetupRow>(
      'SELECT name, format, periods, period_length_sec, default_formation FROM team WHERE id = $1',
      [p.opponentTeam.id],
    )
  ).rows[0];
  const f2 = t2?.format ?? format;
  const o = await c.query<{ id: string }>(
    `INSERT INTO game (team_id, game_no, date, opponent, is_home, format, periods,
                       period_length_sec, formation, kickoff, location, field, is_friendly, pair_id, opponent_team_id)
     VALUES ($1, (SELECT COALESCE(MAX(game_no), 0) + 1 FROM game WHERE team_id = $1),
             $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13)
     RETURNING id`,
    [
      p.opponentTeam.id, p.date, (team?.name ?? 'Team').slice(0, 80), !p.isHome, f2,
      t2?.periods ?? 'quarters', t2?.period_length_sec ?? 720,
      defaultFormation(f2, t2?.default_formation ?? null),
      p.kickoff, p.location, p.field, pairId, p.teamId,
    ],
  );
  return { id: r.rows[0].id, otherId: o.rows[0].id };
}

/** The other team's coaches, assistants, team parents and parents hear about a new friendly. */
async function notifyNewFriendly(p: {
  teamId: string;
  opponentTeam: { id: string; name: string };
  otherId: string;
  date: string;
  kickoff: string | null;
  isHome: boolean;
  location: string | null;
  except: string[];
}) {
  const ownName = (await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [p.teamId]))?.name ?? 'Team';
  const match = p.isHome ? `${ownName} v ${p.opponentTeam.name}` : `${p.opponentTeam.name} v ${ownName}`;
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT DISTINCT m.user_id, 'message', $3, $4, $5
       FROM membership m WHERE m.team_id = $1 AND NOT (m.user_id = ANY($2::uuid[]))`,
    [
      p.opponentTeam.id,
      p.except,
      `New friendly: ${match}`,
      `${prettyDay(p.date)}${p.kickoff ? ` at ${p.kickoff}` : ''}${p.location ? `, ${p.location}` : ''}. It's on your team's calendar; let the coach know if you're going.`,
      calendarLink(p.opponentTeam.id, `game:${p.otherId}`),
    ],
  );
}

/* ----------------------------------------------------- friendly requests */

/** An approved friendly: both teams' people are told, each with a link to their own game. */
async function notifyBothTeams(
  a: { id: string; name: string },
  b: { id: string; name: string },
  game: { id: string; otherId: string | null },
  f: { date: string; kickoff: string | null; isHome: boolean; location: string | null },
  except: string[],
) {
  if (!game.otherId) return;
  await notifyNewFriendly({ teamId: a.id, opponentTeam: b, otherId: game.otherId, ...f, except });
  await notifyNewFriendly({ teamId: b.id, opponentTeam: a, otherId: game.id, ...f, isHome: !f.isHome, except });
}

type RequestTeam = ScopeTeam & { org_name: string };
const REQUEST_TEAM_SQL = `SELECT ${TEAM_COLUMNS}, o.name AS org_name ${TEAM_JOINS} WHERE t.id = $1`;

interface FriendlyOk {
  team_ok_by: string | null;
  opponent_ok_by: string | null;
  org_ok_by: string | null;
}

/**
 * Who approves a friendly between two teams of one organization (Shadi,
 * 10/20): in one region, its staff (region admins, directors and schedulers,
 * or the organization's); across two regions, both regions' staff, or the
 * organization's staff alone.
 */
function approvalRights(access: AccessContext, a: ScopeTeam, b: ScopeTeam) {
  const side = (t: ScopeTeam) => canOnScope(access, { orgId: t.org_id, regionId: t.region_id }, 'fixture.schedule').allowed;
  return {
    org: !a.org_personal && canOnScope(access, { orgId: a.org_id }, 'fixture.schedule').allowed,
    team: side(a),
    opponent: side(b),
  };
}

function friendlyApproved(ok: FriendlyOk, a: ScopeTeam, b: ScopeTeam): boolean {
  if (ok.org_ok_by) return true;
  if (a.region_id === b.region_id) return Boolean(ok.team_ok_by || ok.opponent_ok_by);
  return Boolean(ok.team_ok_by && ok.opponent_ok_by);
}

/** Who still has to say yes, in words. */
function waitingFor(ok: FriendlyOk, a: RequestTeam, b: RequestTeam): string {
  const place = (t: RequestTeam) => (t.region_id && t.region_name ? t.region_name : t.org_name);
  if (a.region_id === b.region_id) return place(a);
  const missing = [!ok.team_ok_by ? place(a) : null, !ok.opponent_ok_by ? place(b) : null].filter(Boolean) as string[];
  return a.org_personal ? missing.join(' and ') : `${missing.join(' and ')}, or ${a.org_name}`;
}

function canApproveNow(rights: ReturnType<typeof approvalRights>, ok: FriendlyOk): boolean {
  return rights.org || (rights.team && !ok.team_ok_by) || (rights.opponent && !ok.opponent_ok_by);
}

/** Tells the staff who still have to approve; each gets a link to their own Games tab. */
async function notifyFriendlyApprovers(
  ok: FriendlyOk,
  a: RequestTeam,
  b: RequestTeam,
  isHome: boolean,
  date: string,
  kickoff: string | null,
  except: string,
) {
  const regions: string[] = [];
  if (a.region_id === b.region_id) {
    if (a.region_id) regions.push(a.region_id);
  } else {
    if (!ok.team_ok_by && a.region_id) regions.push(a.region_id);
    if (!ok.opponent_ok_by && b.region_id) regions.push(b.region_id);
  }
  const match = isHome ? `${a.name} v ${b.name}` : `${b.name} v ${a.name}`;
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT DISTINCT ON (m.user_id) m.user_id, 'message', $3, $4,
            CASE WHEN m.region_id IS NOT NULL THEN '/seasons?region=' || m.region_id::text
                 ELSE '/seasons?org=' || m.org_id::text END
       FROM membership m
      WHERE m.user_id <> $1 AND m.role IN ('org_admin', 'director', 'region_admin', 'scheduler')
        AND (m.region_id = ANY($2::uuid[]) OR ($5::boolean AND m.org_id = $6::uuid))
      ORDER BY m.user_id, (m.region_id IS NULL)`,
    [
      except,
      regions,
      `Friendly request: ${match}`,
      `${a.name} would like to play a friendly on ${prettyDay(date)}${kickoff ? ` at ${kickoff}` : ''}. Approve or decline it under Games › Friendly requests.`,
      !a.org_personal,
      a.org_id,
    ],
  );
}

/** A league team's friendly: a request, or straight onto both calendars when the requester may approve it. */
async function requestFriendly(
  access: AccessContext,
  userId: string,
  home: ScopeTeam,
  opponentTeam: { id: string; name: string },
  f: { date: string; kickoff: string | null; isHome: boolean; location: string; field: string | null; assistantFree: boolean },
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const [a, b] = await Promise.all([
    queryOne<RequestTeam>(REQUEST_TEAM_SQL, [home.id]),
    queryOne<RequestTeam>(REQUEST_TEAM_SQL, [opponentTeam.id]),
  ]);
  if (!a || !b || a.org_id !== b.org_id || isStandaloneTeam(b)) {
    return { status: 400, jsonBody: { error: 'Pick a team from your region or organization.', code: 'OPPONENT_NOT_ALLOWED' } };
  }
  const rights = approvalRights(access, a, b);
  const ok: FriendlyOk = {
    org_ok_by: rights.org ? userId : null,
    team_ok_by: !rights.org && rights.team ? userId : null,
    opponent_ok_by: !rights.org && rights.opponent ? userId : null,
  };
  const approved = friendlyApproved(ok, a, b);
  const out = await transaction(async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO friendly_request (team_id, opponent_team_id, requested_by, date, kickoff, is_home, location, field,
                                     assistant_free, status, team_ok_by, opponent_ok_by, org_ok_by, decided_by, decided_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        a.id, b.id, userId, f.date, f.kickoff, f.isHome, f.location, f.field, f.assistantFree,
        approved ? 'approved' : 'pending', ok.team_ok_by, ok.opponent_ok_by, ok.org_ok_by,
        approved ? userId : null, approved ? new Date() : null,
      ],
    );
    const requestId = r.rows[0].id;
    if (!approved) return { requestId, game: null };
    const game = await insertFriendlyGames(c, {
      teamId: a.id, opponentTeam, opponent: b.name, date: f.date, kickoff: f.kickoff, isHome: f.isHome,
      location: f.location, field: f.field, regular: false, assistantFree: f.assistantFree, competitionId: null,
    });
    await c.query('UPDATE friendly_request SET game_id = $2 WHERE id = $1', [requestId, game.id]);
    return { requestId, game };
  });
  if (out.game) {
    // Staff added it: both teams hear about it (a coach's own team already knows).
    await notifyBothTeams(a, b, out.game, f, [userId]).catch((e) => ctx.warn('friendly notify failed', e));
    return { status: 201, jsonBody: { id: out.game.id, pairedGameId: out.game.otherId, requestId: out.requestId, status: 'approved' } };
  }
  await notifyFriendlyApprovers(ok, a, b, f.isHome, f.date, f.kickoff, userId).catch((e) =>
    ctx.warn('friendly request notify failed', e),
  );
  return {
    status: 202,
    jsonBody: { requestId: out.requestId, status: 'pending', waitingFor: waitingFor(ok, a, b) },
  };
}

interface FriendlyRequestRow extends FriendlyOk {
  id: string;
  team_id: string;
  opponent_team_id: string;
  requested_by: string | null;
  requested_by_name: string | null;
  day: string;
  kickoff: string;
  is_home: boolean;
  location: string;
  field: string | null;
  assistant_free: boolean;
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  decline_reason: string | null;
  game_id: string | null;
  created_at: string;
}

const REQUEST_SELECT = `SELECT fr.id, fr.team_id, fr.opponent_team_id, fr.requested_by, u.display_name AS requested_by_name,
         to_char(fr.date, 'YYYY-MM-DD') AS day, fr.kickoff, fr.is_home, fr.location, fr.field, fr.assistant_free,
         fr.status, fr.team_ok_by, fr.opponent_ok_by, fr.org_ok_by, fr.decline_reason, fr.game_id, fr.created_at
    FROM friendly_request fr
    JOIN team ta ON ta.id = fr.team_id
    JOIN team tb ON tb.id = fr.opponent_team_id
    LEFT JOIN app_user u ON u.id = fr.requested_by`;

/**
 * Friendly requests: a team's (its calendar), or a region's or
 * organization's for its staff to approve (its Games tab). POST approves,
 * declines or cancels one.
 */
export async function friendlyRequestsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const teamId = clip(req.query.get('teamId'), 40);
      const scope = req.query.get('scope');
      const id = clip(req.query.get('id'), 40);
      let access: AccessContext;
      let where: string;
      let param: string;
      if (teamId) {
        const guard = await guardTeam(user, teamId, 'game.view');
        if (!guard.ok) return guard.response;
        access = guard.ctx;
        where = '(fr.team_id = $1 OR fr.opponent_team_id = $1)';
        param = teamId;
      } else if (scope === 'region' && id) {
        access = await buildAccessContext(user);
        const r = await queryOne<{ id: string; org_id: string }>('SELECT id, org_id FROM region WHERE id = $1 AND deleted_at IS NULL', [id]);
        if (!r || !canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'fixture.schedule').allowed) return FORBIDDEN;
        where = '(ta.region_id = $1 OR tb.region_id = $1)';
        param = r.id;
      } else if (scope === 'org' && id) {
        access = await buildAccessContext(user);
        const o = await queryOne<{ id: string }>('SELECT id FROM organization WHERE id = $1 AND deleted_at IS NULL', [id]);
        if (!o || !canOnScope(access, { orgId: o.id }, 'fixture.schedule').allowed) return FORBIDDEN;
        where = 'ta.org_id = $1';
        param = o.id;
      } else {
        return { status: 400, jsonBody: { error: 'teamId, or scope and id, are required' } };
      }
      const rows = await query<FriendlyRequestRow>(
        `${REQUEST_SELECT}
          WHERE ${where} AND ta.deleted_at IS NULL AND tb.deleted_at IS NULL
            AND (fr.status = 'pending' OR fr.created_at > now() - interval '30 days')
          ORDER BY (fr.status = 'pending') DESC, fr.date, fr.created_at DESC
          LIMIT 100`,
        [param],
      );
      const teamIds = [...new Set(rows.flatMap((r) => [r.team_id, r.opponent_team_id]))];
      const teams = teamIds.length
        ? await query<RequestTeam>(`SELECT ${TEAM_COLUMNS}, o.name AS org_name ${TEAM_JOINS} WHERE t.id = ANY($1::uuid[])`, [teamIds])
        : [];
      const byId = new Map(teams.map((t) => [t.id, t]));
      const requests = rows.flatMap((r) => {
        const a = byId.get(r.team_id);
        const b = byId.get(r.opponent_team_id);
        if (!a || !b) return [];
        const rights = approvalRights(access, a, b);
        const pending = r.status === 'pending';
        const label = (t: RequestTeam) => (t.region_id && t.region_name && t.region_personal === false ? t.region_name : null);
        return [
          {
            id: r.id,
            teamId: a.id,
            teamName: a.name,
            teamRegion: label(a),
            opponentTeamId: b.id,
            opponentName: b.name,
            opponentRegion: label(b),
            date: r.day,
            kickoff: r.kickoff,
            isHome: r.is_home,
            location: r.location,
            field: r.field,
            status: r.status,
            requestedBy: r.requested_by_name,
            waitingFor: pending ? waitingFor(r, a, b) : null,
            declineReason: r.decline_reason,
            gameId: r.game_id,
            canApprove: pending && canApproveNow(rights, r),
            canCancel:
              pending &&
              (r.requested_by === user.id ||
                canOnTeam(access, { teamId: a.id, orgId: a.org_id, regionId: a.region_id, divisionId: a.division_id }, 'game.create').allowed),
          },
        ];
      });
      return { status: 200, jsonBody: { requests } };
    }

    const body = (await req.json()) as { action?: string; id?: string; reason?: string };
    const id = clip(body.id, 40);
    const found = await queryOne<FriendlyRequestRow>(`${REQUEST_SELECT} WHERE fr.id = $1`, [id]);
    if (!found) return FORBIDDEN;
    const [a, b] = await Promise.all([
      queryOne<RequestTeam>(REQUEST_TEAM_SQL, [found.team_id]),
      queryOne<RequestTeam>(REQUEST_TEAM_SQL, [found.opponent_team_id]),
    ]);
    if (!a || !b) return FORBIDDEN;
    const access = await buildAccessContext(user);
    const match = found.is_home ? `${a.name} v ${b.name}` : `${b.name} v ${a.name}`;
    const decided = { status: 409, jsonBody: { error: 'This request has already been decided.', code: 'DECIDED' } };

    if (body.action === 'cancel') {
      const may =
        found.requested_by === user.id ||
        canOnTeam(access, { teamId: a.id, orgId: a.org_id, regionId: a.region_id, divisionId: a.division_id }, 'game.create').allowed;
      if (!may) return FORBIDDEN;
      const done = await query(
        `UPDATE friendly_request SET status = 'cancelled', decided_by = $2, decided_at = now()
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [id, user.id],
      );
      return done.length ? { status: 200, jsonBody: { status: 'cancelled' } } : decided;
    }

    const rights = approvalRights(access, a, b);
    if (!rights.org && !rights.team && !rights.opponent) return FORBIDDEN;

    if (body.action === 'decline') {
      const reason = clip(body.reason, 300) || null;
      const done = await query(
        `UPDATE friendly_request SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = $3
          WHERE id = $1 AND status = 'pending' RETURNING id`,
        [id, user.id, reason],
      );
      if (!done.length) return decided;
      if (found.requested_by && found.requested_by !== user.id) {
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'message', $2, $3, $4)`,
          [
            found.requested_by,
            `Friendly not approved: ${match}`,
            `${prettyDay(found.day)}${reason ? `. ${reason}` : '. Ask your region if you would like to know why.'}`,
            calendarLink(a.id),
          ],
        ).catch((e) => ctx.warn('friendly decline notify failed', e));
      }
      return { status: 200, jsonBody: { status: 'declined' } };
    }

    if (body.action !== 'approve') return { status: 400, jsonBody: { error: 'Unknown action' } };
    const out = await transaction(async (c) => {
      const cur = (
        await c.query<FriendlyRequestRow>(
          `SELECT id, status, team_ok_by, opponent_ok_by, org_ok_by FROM friendly_request WHERE id = $1 FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!cur || cur.status !== 'pending') return null;
      const ok: FriendlyOk = {
        org_ok_by: cur.org_ok_by ?? (rights.org ? user.id : null),
        team_ok_by: cur.team_ok_by ?? (!rights.org && rights.team ? user.id : null),
        opponent_ok_by: cur.opponent_ok_by ?? (!rights.org && rights.opponent ? user.id : null),
      };
      const approved = friendlyApproved(ok, a, b);
      const game = approved
        ? await insertFriendlyGames(c, {
            teamId: a.id, opponentTeam: { id: b.id, name: b.name }, opponent: b.name, date: found.day,
            kickoff: found.kickoff, isHome: found.is_home, location: found.location, field: found.field,
            regular: false, assistantFree: found.assistant_free, competitionId: null,
          })
        : null;
      await c.query(
        `UPDATE friendly_request
            SET team_ok_by = $2, opponent_ok_by = $3, org_ok_by = $4, status = $5,
                decided_by = $6, decided_at = CASE WHEN $5 = 'approved' THEN now() END, game_id = $7
          WHERE id = $1`,
        [id, ok.team_ok_by, ok.opponent_ok_by, ok.org_ok_by, approved ? 'approved' : 'pending', approved ? user.id : null, game?.id ?? null],
      );
      return { ok, game };
    });
    if (!out) return decided;
    if (out.game) {
      await notifyBothTeams(
        a,
        b,
        out.game,
        { date: found.day, kickoff: found.kickoff, isHome: found.is_home, location: found.location },
        [user.id, ...(found.requested_by ? [found.requested_by] : [])],
      ).catch((e) => ctx.warn('friendly notify failed', e));
      if (found.requested_by && found.requested_by !== user.id) {
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'message', $2, $3, $4)`,
          [
            found.requested_by,
            `Friendly approved: ${match}`,
            `${prettyDay(found.day)} at ${found.kickoff}, ${found.location}. It's on both teams' calendars.`,
            calendarLink(a.id, `game:${out.game.id}`),
          ],
        ).catch((e) => ctx.warn('friendly approve notify failed', e));
      }
      return { status: 200, jsonBody: { status: 'approved', gameId: out.game.id } };
    }
    // One region said yes; the other region (or the organization) is told it is their turn.
    await notifyFriendlyApprovers(out.ok, a, b, found.is_home, found.day, found.kickoff, user.id).catch((e) =>
      ctx.warn('friendly request notify failed', e),
    );
    return { status: 200, jsonBody: { status: 'pending', waitingFor: waitingFor(out.ok, a, b) } };
  } catch (err) {
    ctx.error('friendly requests failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}
/* ------------------------------------------------------------------ logos */

const MAX_LOGO_BYTES = 200 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

/** May the caller change the logo of this org, region or team? */
async function canEditLogo(
  access: AccessContext,
  kind: string,
  id: string,
): Promise<boolean> {
  if (kind === 'team') {
    const team = await loadTeamContext(id);
    return Boolean(team && canOnTeam(access, team, 'team.edit').allowed);
  }
  if (kind === 'region') {
    const r = await queryOne<{ org_id: string; is_personal: boolean }>(
      'SELECT org_id, is_personal FROM region WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    return Boolean(
      r && !r.is_personal && canOnScope(access, { orgId: r.org_id, regionId: id }, 'region.manage').allowed,
    );
  }
  if (kind === 'org') {
    const o = await queryOne<{ is_personal: boolean }>(
      'SELECT is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    return Boolean(o && !o.is_personal && canOnScope(access, { orgId: id }, 'org.manage').allowed);
  }
  return false;
}

export async function logoHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const body =
      req.method === 'PUT' ? ((await req.json()) as { kind?: string; id?: string; dataUrl?: string }) : {};
    const kind = (req.method === 'PUT' ? body.kind : req.query.get('kind')) ?? '';
    const id = (req.method === 'PUT' ? body.id : req.query.get('id')) ?? '';
    if (!['org', 'region', 'team'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id)) {
      return { status: 400, jsonBody: { error: 'kind (org, region or team) and id are required' } };
    }

    if (req.method === 'GET') {
      // Logos are branding shown next to names the caller can already see;
      // they carry nothing private, so any signed-in user may load one.
      const row = await queryOne<{ mime: string; data: Buffer }>(
        'SELECT mime, data FROM logo WHERE kind = $1 AND ref_id = $2',
        [kind, id],
      );
      if (!row) return { status: 404 };
      return {
        status: 200,
        body: new Uint8Array(row.data),
        headers: {
          'Content-Type': row.mime,
          // The URL carries a version, so a changed logo is a new URL.
          'Cache-Control': 'private, max-age=604800, immutable',
        },
      };
    }

    const access = await buildAccessContext(user);
    if (!(await canEditLogo(access, kind, id))) return FORBIDDEN;

    if (req.method === 'DELETE') {
      await query('DELETE FROM logo WHERE kind = $1 AND ref_id = $2', [kind, id]);
      return { status: 204 };
    }

    const m = DATA_URL_RE.exec(String(body.dataUrl ?? ''));
    if (!m) {
      return { status: 400, jsonBody: { error: 'Upload a PNG, JPEG or WebP image.' } };
    }
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) {
      return { status: 400, jsonBody: { error: 'Logo must be under 200 KB.' } };
    }

    const row = await queryOne<{ v: string }>(
      `INSERT INTO logo (kind, ref_id, mime, data, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (kind, ref_id) DO UPDATE SET
         mime = EXCLUDED.mime, data = EXCLUDED.data,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING FLOOR(EXTRACT(EPOCH FROM updated_at))::bigint::text AS v`,
      [kind, id, m[1], bytes, user.id],
    );
    return { status: 200, jsonBody: { version: row?.v ?? null } };
  } catch (err) {
    ctx.error('logo failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Logo versions for a set of ids, for building cache-busting URLs. */
export async function logoVersions(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await query<{ kind: string; ref_id: string; v: string }>(
    `SELECT kind, ref_id, FLOOR(EXTRACT(EPOCH FROM updated_at))::bigint::text AS v
       FROM logo WHERE ref_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of rows) out.set(`${r.kind}:${r.ref_id}`, r.v);
  return out;
}


app.http('friendlies', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'friendlies', handler: friendliesHandler,
});
app.http('gameCancel', {
  methods: ['POST'], authLevel: 'anonymous', route: 'games/cancel', handler: cancelGameHandler,
});
app.http('calendar', {
  methods: ['GET'], authLevel: 'anonymous', route: 'calendar', handler: calendarHandler,
});
app.http('friendlyRequests', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'friendly-requests', handler: friendlyRequestsHandler,
});
app.http('fixtures', {
  methods: ['POST', 'PATCH', 'DELETE'], authLevel: 'anonymous', route: 'fixtures',
  handler: fixturesHandler,
});
app.http('logo', {
  methods: ['GET', 'PUT', 'DELETE'], authLevel: 'anonymous', route: 'logo', handler: logoHandler,
});

/* ------------------------------------------------------------- cancelling */

function prettyDay(iso: string | null): string {
  if (!iso) return 'date to be set';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Cancel a game, or undo it. A league game (fixtureId) is cancelled on both
 * teams' copies and only by that league's admins and directors; a team's own
 * game or friendly (gameId) by the coaches who can edit it. Everyone on the
 * team hears about it, with a link to the game on the Calendar. A cancelled
 * game takes no RSVPs, sends no reminders and never counts in standings.
 */
export async function cancelGameHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const b = (await req.json()) as { gameId?: string; fixtureId?: string; action?: string; reason?: string; note?: string };
    const restore = b.action === 'restore';
    const access = await buildAccessContext(user);

    let games: Array<{ id: string; team_id: string; date: string | null; opponent: string; is_home: boolean }> = [];
    if (b.fixtureId) {
      const f = await queryOne<{ id: string; org_id: string; home_region: string | null; away_region: string | null }>(
        `SELECT f.id, f.org_id, th.region_id AS home_region, ta.region_id AS away_region
           FROM fixture f
           JOIN team th ON th.id = f.home_team_id
           JOIN team ta ON ta.id = f.away_team_id
          WHERE f.id = $1 AND f.deleted_at IS NULL`,
        [clip(b.fixtureId, 40)],
      );
      if (!f) return FORBIDDEN;
      if (
        !canSchedule(access, { org_id: f.org_id, region_id: f.home_region }) ||
        !canSchedule(access, { org_id: f.org_id, region_id: f.away_region })
      ) {
        return { status: 403, jsonBody: { error: 'League games are cancelled by the organization or region.', code: 'FORBIDDEN' } };
      }
      games = await query(
        `SELECT id, team_id, to_char(date, 'YYYY-MM-DD') AS date, opponent, is_home
           FROM game WHERE fixture_id = $1 AND deleted_at IS NULL`,
        [f.id],
      );
    } else {
      const g = await queryOne<{ id: string; team_id: string; date: string | null; opponent: string; is_home: boolean; fixture_id: string | null; pair_id: string | null }>(
        `SELECT id, team_id, to_char(date, 'YYYY-MM-DD') AS date, opponent, is_home, fixture_id, pair_id
           FROM game WHERE id = $1 AND deleted_at IS NULL`,
        [clip(b.gameId, 40)],
      );
      if (!g) return FORBIDDEN;
      if (g.fixture_id) {
        return { status: 403, jsonBody: { error: 'League games are cancelled by the organization or region.', code: 'LEAGUE_GAME' } };
      }
      const guard = await guardTeam(user, g.team_id, 'game.edit');
      if (!guard.ok) return guard.response;
      games = [g];
      // A friendly between two Lineup teams is called off (or back on) for both.
      if (g.pair_id) {
        games.push(
          ...(await query<{ id: string; team_id: string; date: string | null; opponent: string; is_home: boolean }>(
            `SELECT id, team_id, to_char(date, 'YYYY-MM-DD') AS date, opponent, is_home
               FROM game WHERE pair_id = $1 AND id <> $2 AND deleted_at IS NULL`,
            [g.pair_id, g.id],
          )),
        );
      }
    }
    if (games.length === 0) return FORBIDDEN;

    const reason = restore ? null : cancelReasonOf(b.reason) ?? 'other';
    const note = restore ? null : clip(b.note, 300) || null;
    await query(
      `UPDATE game SET canceled_at = CASE WHEN $2 THEN NULL ELSE now() END,
              cancel_reason = $3, cancel_note = $4, canceled_by = CASE WHEN $2 THEN NULL ELSE $5::uuid END,
              updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [games.map((g) => g.id), restore, reason, note, user.id],
    );

    for (const g of games) {
      const match = `${g.is_home ? 'vs' : 'at'} ${g.opponent || 'TBD'}`;
      const label = CANCEL_REASONS.find(([k]) => k === reason)?.[1] ?? 'Other';
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT m.user_id, 'message', $3, $4, $5
           FROM membership m WHERE m.team_id = $1 AND m.user_id <> $2`,
        [
          g.team_id,
          user.id,
          restore ? `Game is back on: ${prettyDay(g.date)} ${match}` : `Game cancelled: ${prettyDay(g.date)} ${match}`,
          restore
            ? `The game on ${prettyDay(g.date)} ${match} is happening after all.`
            : `Reason: ${label}.${note ? ` ${note}` : ''}`,
          calendarLink(g.team_id, `game:${g.id}`),
        ],
      ).catch((e) => ctx.warn('cancel notify failed', e));
    }
    if (b.fixtureId) {
      const fx = await queryOne<{ id: string; home: string; away: string; date: string | null }>(
        `SELECT f.id, th.name AS home, ta.name AS away, to_char(f.date, 'YYYY-MM-DD') AS date
           FROM fixture f JOIN team th ON th.id = f.home_team_id JOIN team ta ON ta.id = f.away_team_id
          WHERE f.id = $1`,
        [clip(b.fixtureId, 40)],
      );
      if (fx) {
        const label = CANCEL_REASONS.find(([k]) => k === reason)?.[1] ?? 'Other';
        await notifyFixtureReferees(
          fx.id,
          user.id,
          restore ? `Game is back on: ${fx.home} vs ${fx.away}` : `Game cancelled: ${fx.home} vs ${fx.away}`,
          restore
            ? `The game on ${prettyDay(fx.date)} is happening after all. You still have your spot.`
            : `The game on ${prettyDay(fx.date)} is off. Reason: ${label}.${note ? ` ${note}` : ''}`,
        ).catch((e) => ctx.warn('referee notify failed', e));
      }
    }
    return { status: 200, jsonBody: { ok: true, canceled: !restore, games: games.length } };
  } catch (err) {
    ctx.error('cancel game failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}
