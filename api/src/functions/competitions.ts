import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnScope,
  canOnTeam,
  cleanCompetition,
  competitionDeleteOn,
  competitionStatus,
  type AccessContext,
  type CompetitionKind,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext, loadTeamContext, reachableTeamIds } from '../lib/authz.js';
import { bracketAction, loadBracket } from '../lib/brackets.js';
import { query, queryOne } from '../lib/db.js';
import { appToday } from '../lib/today.js';

/**
 * Leagues and tournaments (rules in packages/shared/src/competition.ts).
 *
 * A region or organization runs them for its teams (whoever schedules league
 * games there); a coach runs them for their own standalone teams. Games are
 * scheduled into one through /api/fixtures or /api/friendlies with its
 * competitionId, so they land on each team's calendar as before.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

export interface CompetitionRow {
  id: string;
  kind: CompetitionKind;
  name: string;
  starts_on: string;
  ends_on: string;
  org_id: string | null;
  region_id: string | null;
  owner_user_id: string | null;
  org_name: string | null;
  region_name: string | null;
}

const COMPETITION_COLUMNS = `c.id, c.kind, c.name, to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on, c.org_id, c.region_id, c.owner_user_id,
  o.name AS org_name, r.name AS region_name`;
const COMPETITION_JOINS = `FROM competition c
  LEFT JOIN organization o ON o.id = c.org_id
  LEFT JOIN region r ON r.id = c.region_id`;

export async function loadCompetition(id: string): Promise<CompetitionRow | null> {
  return (
    (await queryOne<CompetitionRow>(
      `SELECT ${COMPETITION_COLUMNS} ${COMPETITION_JOINS} WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id],
    )) ?? null
  );
}

/** May the caller set up this league or tournament and schedule its games? */
export function canManageCompetition(access: AccessContext, userId: string, c: CompetitionRow): boolean {
  if (c.owner_user_id) return c.owner_user_id === userId || access.isPlatformAdmin === true;
  return canOnScope(access, { orgId: c.org_id!, regionId: c.region_id }, 'game.create').allowed;
}

export function isArchived(c: Pick<CompetitionRow, 'starts_on' | 'ends_on'>): boolean {
  return competitionStatus(c.starts_on, c.ends_on, appToday()) === 'archived';
}

async function competitionTeamIds(id: string): Promise<string[]> {
  return (await query<{ team_id: string }>('SELECT team_id FROM competition_team WHERE competition_id = $1', [id])).map(
    (r) => r.team_id,
  );
}

/** Managers, people on a participating team, and the owning region's or organization's readers. */
async function canViewCompetition(access: AccessContext, userId: string, c: CompetitionRow): Promise<boolean> {
  if (canManageCompetition(access, userId, c)) return true;
  if (c.org_id && canOnScope(access, { orgId: c.org_id, regionId: c.region_id }, 'team.view').allowed) return true;
  const [teams, reachable] = await Promise.all([competitionTeamIds(c.id), reachableTeamIds(userId)]);
  const mine = new Set(reachable);
  return teams.some((t) => mine.has(t));
}

interface TeamRow {
  id: string;
  name: string;
  org_id: string;
  org_personal: boolean;
  region_id: string | null;
  region_name: string | null;
  region_personal: boolean | null;
}

const TEAM_SELECT = `SELECT t.id, t.name, t.org_id, o.is_personal AS org_personal, t.region_id,
       r.name AS region_name, r.is_personal AS region_personal
  FROM team t JOIN organization o ON o.id = t.org_id LEFT JOIN region r ON r.id = t.region_id`;

function standalone(t: Pick<TeamRow, 'org_personal' | 'region_id' | 'region_personal'>): boolean {
  return t.org_personal && !(t.region_id && t.region_personal === false);
}

/**
 * Teams the managers may add: the region's or organization's teams, or any
 * team the coach runs, for their own league or tournament (archived ones
 * never). In an organization its staff may mix teams from every region, even
 * in a region's own league (Fady, 10/17); region staff add their region's teams.
 */
async function eligibleTeams(access: AccessContext, userId: string, c: CompetitionRow): Promise<TeamRow[]> {
  if (c.region_id && !(c.org_id && canOnScope(access, { orgId: c.org_id }, 'game.create').allowed)) {
    return query<TeamRow>(
      `${TEAM_SELECT} WHERE t.region_id = $1 AND t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY t.name`,
      [c.region_id],
    );
  }
  if (c.org_id) {
    return query<TeamRow>(
      `${TEAM_SELECT} WHERE t.org_id = $1 AND t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY r.name NULLS FIRST, t.name`,
      [c.org_id],
    );
  }
  const reachable = await reachableTeamIds(userId);
  const [teams, owned] = await Promise.all([
    query<TeamRow>(
      `${TEAM_SELECT} WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY t.name`,
      [reachable],
    ),
    query<{ id: string }>('SELECT id FROM team WHERE owner_id = $1 AND deleted_at IS NULL', [userId]),
  ]);
  // A coach's own league or tournament takes any team they coach, in a region
  // or not (Fady, 10/19: their region or organization may not use Lineup).
  // Only team-level roles count, so an organization admin's own one does not
  // sweep in every team of the organization.
  const ownedIds = new Set(owned.map((t) => t.id));
  const teamRoles: AccessContext = { ...access, isPlatformAdmin: false, memberships: access.memberships.filter((m) => m.teamId) };
  return teams.filter(
    (t) =>
      ownedIds.has(t.id) ||
      canOnTeam(teamRoles, { teamId: t.id, orgId: t.org_id, regionId: t.region_id, divisionId: null }, 'team.edit').allowed,
  );
}

function ownerLabel(c: CompetitionRow): string {
  if (c.owner_user_id) return 'Your teams';
  return c.region_name ?? c.org_name ?? '';
}

function summary(c: CompetitionRow, extra: { teams: number; games: number; canManage: boolean }) {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    startsOn: c.starts_on,
    endsOn: c.ends_on,
    status: competitionStatus(c.starts_on, c.ends_on, appToday()),
    deleteOn: competitionDeleteOn(c.ends_on),
    owner: ownerLabel(c),
    ...extra,
  };
}

/** Standings over this competition's games only (3 points a win, 1 a draw). */
async function competitionStandings(c: CompetitionRow, teamIds: string[]) {
  if (teamIds.length === 0) return { table: [], scorers: [] };
  const [rows, goals] = await Promise.all([
    query<{ id: string; name: string; played: number; won: number; drawn: number; lost: number; gf: number; ga: number }>(
      `WITH played AS (
         SELECT g.team_id, g.us, g.them FROM game g
          WHERE g.competition_id = $2 AND g.team_id = ANY($1::uuid[]) AND g.deleted_at IS NULL AND g.canceled_at IS NULL
            AND (g.us + g.them > 0 OR (g.date IS NOT NULL AND g.date < $3::date))
       )
       SELECT t.id, t.name,
              COUNT(p.team_id)::int AS played,
              COUNT(p.team_id) FILTER (WHERE p.us > p.them)::int AS won,
              COUNT(p.team_id) FILTER (WHERE p.us = p.them)::int AS drawn,
              COUNT(p.team_id) FILTER (WHERE p.us < p.them)::int AS lost,
              COALESCE(SUM(p.us), 0)::int AS gf, COALESCE(SUM(p.them), 0)::int AS ga
         FROM team t LEFT JOIN played p ON p.team_id = t.id
        WHERE t.id = ANY($1::uuid[])
        GROUP BY t.id, t.name`,
      [teamIds, c.id, appToday()],
    ),
    query<{ name: string; team_name: string; goals: number; assists: number }>(
      `SELECT p.name, t.name AS team_name,
              COUNT(*) FILTER (WHERE e.kind = 'goal' AND e.player_id = p.id)::int AS goals,
              COUNT(*) FILTER (WHERE e.assist_id = p.id)::int AS assists
         FROM game_event e
         JOIN game g ON g.id = e.game_id AND g.deleted_at IS NULL AND g.competition_id = $2
         JOIN player p ON (p.id = e.player_id OR p.id = e.assist_id) AND p.active
         JOIN team t ON t.id = g.team_id
        WHERE g.team_id = ANY($1::uuid[]) AND NOT e.against
        GROUP BY p.id, p.name, t.name`,
      [teamIds, c.id],
    ),
  ]);
  const short = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] ?? 'Player';
  };
  const table = rows
    .map((t) => ({ ...t, teamId: t.id, gd: t.gf - t.ga, pts: t.won * 3 + t.drawn }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
  const scorers = goals
    .filter((g) => g.goals > 0 || g.assists > 0)
    .map((g) => ({ name: short(g.name), teamName: g.team_name, goals: g.goals, assists: g.assists }))
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name))
    .slice(0, 10);
  return { table, scorers };
}

/** The competition's games, one entry per match (both halves of a league fixture merged). */
async function competitionGames(c: CompetitionRow, reachable: Set<string>) {
  const rows = await query<{
    id: string;
    team_id: string;
    team_name: string;
    date: string | null;
    kickoff: string | null;
    location: string | null;
    opponent: string;
    is_home: boolean;
    us: number;
    them: number;
    fixture_id: string | null;
    home_team_id: string | null;
    canceled: boolean;
  }>(
    `SELECT g.id, g.team_id, t.name AS team_name, to_char(g.date, 'YYYY-MM-DD') AS date,
            COALESCE(f.kickoff, g.kickoff) AS kickoff, COALESCE(f.location, g.location) AS location,
            g.opponent, g.is_home, g.us, g.them, g.fixture_id, f.home_team_id, (g.canceled_at IS NOT NULL) AS canceled
       FROM game g JOIN team t ON t.id = g.team_id
       LEFT JOIN fixture f ON f.id = g.fixture_id
      WHERE g.competition_id = $1 AND g.deleted_at IS NULL
      ORDER BY g.date NULLS LAST, COALESCE(f.kickoff, g.kickoff) NULLS LAST`,
    [c.id],
  );
  const today = appToday();
  const out = new Map<string, {
    id: string;
    date: string | null;
    kickoff: string | null;
    location: string | null;
    home: string;
    away: string;
    score: { home: number; away: number } | null;
    canceled: boolean;
    links: Array<{ teamId: string; gameId: string; teamName: string }>;
  }>();
  for (const r of rows) {
    const key = r.fixture_id ?? r.id;
    const link = reachable.has(r.team_id) ? { teamId: r.team_id, gameId: r.id, teamName: r.team_name } : null;
    const seen = out.get(key);
    if (seen) {
      if (link) seen.links.push(link);
      continue;
    }
    const homeRow = r.fixture_id ? r.team_id === r.home_team_id : r.is_home;
    const played = !r.canceled && (r.us + r.them > 0 || (r.date !== null && r.date < today));
    out.set(key, {
      id: key,
      date: r.date,
      kickoff: r.kickoff,
      location: r.location,
      home: homeRow ? r.team_name : r.opponent || 'TBD',
      away: homeRow ? r.opponent || 'TBD' : r.team_name,
      score: played ? { home: homeRow ? r.us : r.them, away: homeRow ? r.them : r.us } : null,
      canceled: r.canceled,
      links: link ? [link] : [],
    });
  }
  return [...out.values()];
}

const ordinal = (n: number) => {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
};

type LoadedBracket = NonNullable<Awaited<ReturnType<typeof loadBracket>>>;

/** How far a team got in a tournament's bracket, in words ("Champion", "Out in the Semi-finals"). */
function bracketStage(b: LoadedBracket, teamId: string): string | null {
  const sideOf = (m: LoadedBracket['matches'][number]) =>
    m.home?.teamId === teamId ? 'home' : m.away?.teamId === teamId ? 'away' : null;
  const ko = b.matches.filter((m) => sideOf(m));
  const third = ko.find((m) => m.thirdPlace);
  if (third?.winner) return third.winner === sideOf(third) ? '3rd place' : '4th place';
  const last = ko.filter((m) => !m.thirdPlace).sort((x, y) => y.round - x.round)[0];
  if (last) {
    const won = last.winner === sideOf(last);
    if (last.round === b.rounds && last.winner) return won ? 'Champion' : 'Runner-up';
    if (last.winner && !won) return third ? 'Plays for 3rd place' : `Out in the ${last.roundName}`;
    if (!last.winner) return `In the ${last.roundName}`;
  }
  for (const g of b.groups) {
    const i = g.table.findIndex((r) => r.teamId === teamId);
    if (i >= 0) return `${ordinal(i + 1)} in Group ${g.label}`;
  }
  return null;
}

/**
 * Where one team stands in a league or tournament, for its Stats tab
 * (Fady, 10/17): its place in the table and, in a tournament, how far it got.
 */
async function teamStanding(c: CompetitionRow, teamId: string) {
  const teamIds = await competitionTeamIds(c.id);
  if (!teamIds.includes(teamId)) return null;
  const [{ table }, bracket] = await Promise.all([
    competitionStandings(c, teamIds),
    c.kind === 'tournament' ? loadBracket(c.id, new Set()) : Promise.resolve(null),
  ]);
  const i = table.findIndex((r) => r.teamId === teamId);
  const row = i >= 0 ? table[i] : null;
  return {
    // No place until the team has played.
    position: row && row.played > 0 ? i + 1 : null,
    positionLabel: row && row.played > 0 ? ordinal(i + 1) : null,
    of: table.length,
    played: row?.played ?? 0,
    won: row?.won ?? 0,
    drawn: row?.drawn ?? 0,
    lost: row?.lost ?? 0,
    pts: row?.pts ?? 0,
    gf: row?.gf ?? 0,
    ga: row?.ga ?? 0,
    stage: bracket ? bracketStage(bracket, teamId) : null,
  };
}

/** List entries with their team and game counts. */
async function summaries(access: AccessContext, userId: string, rows: CompetitionRow[]) {
  const ids = rows.map((r) => r.id);
  const counts = ids.length
    ? await query<{ id: string; teams: number; games: number }>(
        `SELECT c.id,
                (SELECT COUNT(*) FROM competition_team ct WHERE ct.competition_id = c.id)::int AS teams,
                (SELECT COUNT(DISTINCT COALESCE(g.fixture_id, g.id)) FROM game g
                  WHERE g.competition_id = c.id AND g.deleted_at IS NULL)::int AS games
           FROM competition c WHERE c.id = ANY($1::uuid[])`,
        [ids],
      )
    : [];
  const countOf = new Map(counts.map((c) => [c.id, c]));
  return rows.map((c) =>
    summary(c, {
      teams: countOf.get(c.id)?.teams ?? 0,
      games: countOf.get(c.id)?.games ?? 0,
      canManage: canManageCompetition(access, userId, c),
    }),
  );
}

interface FriendlyRow {
  id: string;
  team_id: string;
  team_name: string;
  date: string | null;
  kickoff: string | null;
  opponent: string;
  is_home: boolean;
  us: number;
  them: number;
  canceled: boolean;
  location: string | null;
  pair_id: string | null;
}

/**
 * Friendlies (a team's own games outside any league or tournament) for the
 * Games page's Friendlies section (Fady, 10/19): the last 60 days and
 * everything ahead, oldest first.
 */
async function friendliesFor(teamIds: string[]) {
  if (teamIds.length === 0) return [];
  const today = appToday();
  const rows = await query<FriendlyRow>(
    `SELECT g.id, g.team_id, t.name AS team_name, to_char(g.date, 'YYYY-MM-DD') AS date, g.kickoff,
            g.opponent, g.is_home, g.us, g.them, g.canceled_at IS NOT NULL AS canceled, g.location, g.pair_id
       FROM game g JOIN team t ON t.id = g.team_id
      WHERE g.team_id = ANY($1::uuid[]) AND g.deleted_at IS NULL AND t.deleted_at IS NULL
        AND g.fixture_id IS NULL AND g.competition_id IS NULL AND g.is_friendly IS NOT FALSE
        AND (g.date IS NULL OR g.date >= $2::date - 60)
      ORDER BY g.date NULLS LAST, g.kickoff NULLS LAST, g.game_no
      LIMIT 100`,
    [teamIds, today],
  );
  // A friendly between two of the listed teams shows once.
  const seen = new Set<string>();
  const unique = rows.filter((r) => !r.pair_id || (!seen.has(r.pair_id) && Boolean(seen.add(r.pair_id))));
  return unique.map((r) => {
    const past = r.date !== null && r.date < today;
    const played = !r.canceled && (r.us + r.them > 0 || past);
    return {
      gameId: r.id,
      teamId: r.team_id,
      teamName: r.team_name,
      date: r.date,
      kickoff: r.kickoff,
      opponent: r.opponent || 'TBD',
      home: r.is_home,
      location: r.location,
      canceled: r.canceled,
      past,
      score: played ? { us: r.us, them: r.them } : null,
    };
  });
}

/**
 * Every league and tournament the caller runs or takes part in, wherever it
 * belongs, and where they may create a new one: the organizations and regions
 * they schedule games for, and their own standalone teams.
 */
async function mineList(access: AccessContext, userId: string): Promise<HttpResponseInit> {
  const orgCandidates = new Set<string>();
  const regionCandidates = new Set<string>();
  for (const m of access.memberships) {
    if (m.teamId || m.divisionId) continue;
    if (m.regionId) regionCandidates.add(m.regionId);
    else if (m.orgId) orgCandidates.add(m.orgId);
  }
  const [orgs, regions, reachable, ownTeams, teamTeams] = await Promise.all([
    orgCandidates.size
      ? query<{ id: string; name: string; is_personal: boolean }>(
          'SELECT id, name, is_personal FROM organization WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name',
          [[...orgCandidates]],
        )
      : Promise.resolve([]),
    regionCandidates.size
      ? query<{ id: string; name: string; org_id: string; org_name: string; org_personal: boolean }>(
          `SELECT r.id, r.name, r.org_id, o.name AS org_name, o.is_personal AS org_personal
             FROM region r JOIN organization o ON o.id = r.org_id
            WHERE r.id = ANY($1::uuid[]) AND r.deleted_at IS NULL ORDER BY o.name, r.name`,
          [[...regionCandidates]],
        )
      : Promise.resolve([]),
    reachableTeamIds(userId),
    eligibleTeams(access, userId, { owner_user_id: userId } as CompetitionRow),
    // The caller's own teams (owned or a team role), for their friendlies;
    // not every team under an organization they run.
    query<{ id: string }>(
      `SELECT id FROM team WHERE owner_id = $1 AND deleted_at IS NULL
       UNION SELECT m.team_id FROM membership m JOIN team t ON t.id = m.team_id
        WHERE m.user_id = $1 AND t.deleted_at IS NULL`,
      [userId],
    ),
  ]);

  const viewOrgs = orgs.filter((o) => canOnScope(access, { orgId: o.id }, 'team.view').allowed);
  const viewRegions = regions.filter((r) => canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.view').allowed);
  const orgRegions = viewOrgs.length
    ? await query<{ id: string; name: string; org_id: string }>(
        'SELECT id, name, org_id FROM region WHERE org_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY name',
        [viewOrgs.map((o) => o.id)],
      )
    : [];
  const createOptions: Array<{ scope: 'org' | 'region' | 'mine'; id: string; label: string }> = [];
  for (const o of viewOrgs) {
    if (!o.is_personal && canOnScope(access, { orgId: o.id }, 'game.create').allowed) {
      // The whole organization first: its leagues and tournaments take teams from every region.
      createOptions.push({ scope: 'org', id: o.id, label: `${o.name} (all regions)` });
      // An organization's staff run its regions' leagues too.
      for (const r of orgRegions.filter((x) => x.org_id === o.id && !regionCandidates.has(x.id))) {
        createOptions.push({ scope: 'region', id: r.id, label: `${r.name} · ${o.name}` });
      }
    }
  }
  for (const r of viewRegions) {
    if (canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'game.create').allowed) {
      createOptions.push({ scope: 'region', id: r.id, label: r.org_personal ? r.name : `${r.name} · ${r.org_name}` });
    }
  }
  if (ownTeams.length > 0) createOptions.push({ scope: 'mine', id: userId, label: 'My own teams (independent)' });

  const rows = await query<CompetitionRow>(
    `SELECT ${COMPETITION_COLUMNS} ${COMPETITION_JOINS}
      WHERE c.deleted_at IS NULL
        AND (c.owner_user_id = $1
             OR c.org_id = ANY($2::uuid[])
             OR c.region_id = ANY($3::uuid[])
             OR c.id IN (SELECT competition_id FROM competition_team WHERE team_id = ANY($4::uuid[])))
      ORDER BY c.starts_on DESC, c.name`,
    [userId, viewOrgs.map((o) => o.id), viewRegions.map((r) => r.id), reachable],
  );
  const [competitions, friendlies] = await Promise.all([
    summaries(access, userId, rows),
    friendliesFor(teamTeams.map((t) => t.id)),
  ]);
  return {
    status: 200,
    jsonBody: {
      canCreate: createOptions.length > 0,
      createAs: null,
      createOptions,
      competitions,
      friendlies,
    },
  };
}

export async function competitionsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    if (req.method === 'GET') {
      const one = req.query.get('competitionId');
      if (one) {
        const c = await loadCompetition(one.slice(0, 36));
        if (!c || !(await canViewCompetition(access, user.id, c))) return FORBIDDEN;
        const canManage = canManageCompetition(access, user.id, c);
        const archived = isArchived(c);
        const [teamIds, reachable] = await Promise.all([competitionTeamIds(c.id), reachableTeamIds(user.id)]);
        const mine = new Set(reachable);
        const [teams, standings, games, eligible, bracket] = await Promise.all([
          query<TeamRow>(`${TEAM_SELECT} WHERE t.id = ANY($1::uuid[]) ORDER BY t.name`, [teamIds]),
          competitionStandings(c, teamIds),
          competitionGames(c, mine),
          canManage && !archived ? eligibleTeams(access, user.id, c) : Promise.resolve([]),
          c.kind === 'tournament' ? loadBracket(c.id, mine) : Promise.resolve(null),
        ]);
        const inIt = new Set(teamIds);
        return {
          status: 200,
          jsonBody: {
            ...summary(c, { teams: teamIds.length, games: games.length, canManage }),
            ownerKind: c.owner_user_id ? 'coach' : c.region_id ? 'region' : 'org',
            canEdit: canManage && !archived,
            teams: teams.map((t) => ({
              id: t.id,
              name: t.name,
              regionName: t.region_personal ? null : t.region_name,
              reachable: mine.has(t.id),
            })),
            eligibleTeams: eligible
              .filter((t) => !inIt.has(t.id))
              .map((t) => ({ id: t.id, name: t.name, regionName: t.region_personal ? null : t.region_name })),
            standings,
            games,
            bracket,
          },
        };
      }

      // The list for a team, a region or an organization, or everything the
      // caller takes part in ("mine": the app's own Games page).
      const scope = req.query.get('scope') ?? '';
      const id = (req.query.get('id') ?? '').slice(0, 36);
      if (scope === 'mine') return await mineList(access, user.id);
      if (!id || !['team', 'region', 'org'].includes(scope)) {
        return { status: 400, jsonBody: { error: 'scope and id are required' } };
      }
      let rows: CompetitionRow[] = [];
      let canCreate = false;
      let createAs: { scope: 'region' | 'org' | 'team'; id: string } | null = null;
      // Region and organization Games tabs list their teams' friendlies too:
      // every team for their staff, otherwise the caller's own teams there.
      let friendlyTeamIds: string[] | null = null;
      if (scope === 'team') {
        const team = await loadTeamContext(id);
        if (!team || !canOnTeam(access, team, 'team.view').allowed) return FORBIDDEN;
        rows = await query<CompetitionRow>(
          `SELECT ${COMPETITION_COLUMNS} ${COMPETITION_JOINS}
            WHERE c.deleted_at IS NULL AND c.id IN (SELECT competition_id FROM competition_team WHERE team_id = $1)
            ORDER BY c.starts_on DESC`,
          [id],
        );
        const t = await queryOne<TeamRow>(`${TEAM_SELECT} WHERE t.id = $1`, [id]);
        if (t && standalone(t)) {
          // A coach's own teams: the coach runs their seasons.
          canCreate = canOnTeam(access, team, 'team.edit').allowed;
          createAs = { scope: 'team', id };
        } else if (t?.region_id) {
          canCreate = canOnScope(access, { orgId: t.org_id, regionId: t.region_id }, 'game.create').allowed;
          createAs = { scope: 'region', id: t.region_id };
        } else if (t) {
          canCreate = canOnScope(access, { orgId: t.org_id }, 'game.create').allowed;
          createAs = { scope: 'org', id: t.org_id };
        }
      } else if (scope === 'region') {
        const r = await queryOne<{ id: string; org_id: string }>('SELECT id, org_id FROM region WHERE id = $1 AND deleted_at IS NULL', [id]);
        if (!r) return FORBIDDEN;
        const reachable = await reachableTeamIds(user.id);
        const inRegion = await query<{ id: string }>('SELECT id FROM team WHERE region_id = $1 AND deleted_at IS NULL', [r.id]);
        const mine = new Set(reachable);
        const regionStaff = canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.view').allowed;
        if (!regionStaff && !inRegion.some((t) => mine.has(t.id))) {
          return FORBIDDEN;
        }
        friendlyTeamIds = inRegion.map((t) => t.id).filter((t) => regionStaff || mine.has(t));
        rows = await query<CompetitionRow>(
          `SELECT ${COMPETITION_COLUMNS} ${COMPETITION_JOINS}
            WHERE c.deleted_at IS NULL
              AND (c.region_id = $1
                   OR (c.region_id IS NULL AND c.org_id = $2
                       AND EXISTS (SELECT 1 FROM competition_team ct JOIN team t ON t.id = ct.team_id
                                    WHERE ct.competition_id = c.id AND t.region_id = $1)))
            ORDER BY c.starts_on DESC`,
          [r.id, r.org_id],
        );
        canCreate = canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'game.create').allowed;
        createAs = { scope: 'region', id: r.id };
      } else {
        const o = await queryOne<{ id: string }>('SELECT id FROM organization WHERE id = $1 AND deleted_at IS NULL', [id]);
        if (!o) return FORBIDDEN;
        const reachable = await reachableTeamIds(user.id);
        const inOrg = await query<{ id: string }>('SELECT id FROM team WHERE org_id = $1 AND deleted_at IS NULL', [o.id]);
        const mine = new Set(reachable);
        const orgStaff = canOnScope(access, { orgId: o.id }, 'team.view').allowed;
        if (!orgStaff && !inOrg.some((t) => mine.has(t.id))) return FORBIDDEN;
        friendlyTeamIds = inOrg.map((t) => t.id).filter((t) => orgStaff || mine.has(t));
        rows = await query<CompetitionRow>(
          `SELECT ${COMPETITION_COLUMNS} ${COMPETITION_JOINS}
            WHERE c.deleted_at IS NULL AND c.org_id = $1 ORDER BY c.starts_on DESC`,
          [o.id],
        );
        canCreate = canOnScope(access, { orgId: o.id }, 'game.create').allowed;
        createAs = { scope: 'org', id: o.id };
      }

      const [list, friendlies] = await Promise.all([
        summaries(access, user.id, rows),
        friendlyTeamIds ? friendliesFor(friendlyTeamIds) : Promise.resolve(undefined),
      ]);
      // A team's list says where the team stands in each one.
      const standings = scope === 'team' ? await Promise.all(rows.map((c) => teamStanding(c, id))) : null;
      return {
        status: 200,
        jsonBody: {
          canCreate,
          createAs: canCreate ? createAs : null,
          createOptions: canCreate && createAs ? [{ ...createAs, label: '' }] : [],
          competitions: standings ? list.map((s, i) => ({ ...s, standing: standings[i] })) : list,
          friendlies,
        },
      };
    }

    // POST: create, update, delete, addTeams, removeTeam, and the bracket's actions.
    const b = (await req.json()) as {
      action?: string;
      id?: string;
      scope?: 'region' | 'org' | 'team' | 'mine';
      scopeId?: string;
      kind?: string;
      name?: string;
      startsOn?: string;
      endsOn?: string;
      teamIds?: string[];
      teamId?: string;
      entries?: unknown;
      thirdPlace?: boolean;
      groups?: { perGroup?: unknown; advance?: unknown } | null;
      homeScore?: unknown;
      awayScore?: unknown;
      matchId?: string;
      home?: unknown;
      away?: unknown;
      winner?: string | null;
      date?: string;
      kickoff?: string | null;
      location?: string | null;
    };

    if (b.action === 'create') {
      const clean = cleanCompetition(b);
      if ('error' in clean) return { status: 400, jsonBody: { error: clean.error } };
      const scopeId = String(b.scopeId ?? '').slice(0, 36);
      let orgId: string | null = null;
      let regionId: string | null = null;
      let ownerId: string | null = null;
      let firstTeam: string | null = null;
      if (b.scope === 'region') {
        const r = await queryOne<{ id: string; org_id: string }>('SELECT id, org_id FROM region WHERE id = $1 AND deleted_at IS NULL', [scopeId]);
        if (!r || !canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'game.create').allowed) return FORBIDDEN;
        orgId = r.org_id;
        regionId = r.id;
      } else if (b.scope === 'org') {
        const o = await queryOne<{ id: string; is_personal: boolean }>('SELECT id, is_personal FROM organization WHERE id = $1 AND deleted_at IS NULL', [scopeId]);
        if (!o || o.is_personal || !canOnScope(access, { orgId: o.id }, 'game.create').allowed) return FORBIDDEN;
        orgId = o.id;
      } else if (b.scope === 'mine') {
        // A coach's own league or tournament, for their standalone teams.
        if ((await eligibleTeams(access, user.id, { owner_user_id: user.id } as CompetitionRow)).length === 0) return FORBIDDEN;
        ownerId = user.id;
      } else if (b.scope === 'team') {
        // A coach's season for their own standalone teams, starting with this one.
        const t = await queryOne<TeamRow>(`${TEAM_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`, [scopeId]);
        const team = t ? await loadTeamContext(t.id) : null;
        if (!t || !team || !standalone(t) || !canOnTeam(access, team, 'team.edit').allowed) return FORBIDDEN;
        ownerId = user.id;
        firstTeam = t.id;
      } else {
        return { status: 400, jsonBody: { error: 'Pick where the league or tournament belongs.' } };
      }
      const row = await queryOne<{ id: string }>(
        `INSERT INTO competition (kind, name, starts_on, ends_on, org_id, region_id, owner_user_id, created_by)
         VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8) RETURNING id`,
        [clean.kind, clean.name, clean.startsOn, clean.endsOn, orgId, regionId, ownerId, user.id],
      );
      if (firstTeam) {
        await query('INSERT INTO competition_team (competition_id, team_id, added_by) VALUES ($1, $2, $3)', [row!.id, firstTeam, user.id]);
      }
      return { status: 201, jsonBody: { id: row!.id } };
    }

    const c = await loadCompetition(String(b.id ?? '').slice(0, 36));
    if (!c || !canManageCompetition(access, user.id, c)) return FORBIDDEN;
    if (isArchived(c) && b.action !== 'delete') {
      return { status: 409, jsonBody: { error: 'This league or tournament has ended, so it is read-only.', code: 'ARCHIVED' } };
    }

    if (b.action === 'update') {
      const clean = cleanCompetition({ kind: b.kind ?? c.kind, name: b.name ?? c.name, startsOn: b.startsOn ?? c.starts_on, endsOn: b.endsOn ?? c.ends_on });
      if ('error' in clean) return { status: 400, jsonBody: { error: clean.error } };
      // Its games must still fall within the dates.
      const outside = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM game WHERE competition_id = $1 AND deleted_at IS NULL
            AND date IS NOT NULL AND (date < $2::date OR date > $3::date)`,
        [c.id, clean.startsOn, clean.endsOn],
      );
      if ((outside?.n ?? 0) > 0) {
        return { status: 409, jsonBody: { error: `${outside!.n} of its games fall outside those dates. Move them first.` } };
      }
      await query(
        `UPDATE competition SET kind = $2, name = $3, starts_on = $4::date, ends_on = $5::date, updated_at = now() WHERE id = $1`,
        [c.id, clean.kind, clean.name, clean.startsOn, clean.endsOn],
      );
      return { status: 200, jsonBody: { id: c.id } };
    }

    if (b.action === 'delete') {
      const games = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM game WHERE competition_id = $1 AND deleted_at IS NULL', [c.id]);
      if ((games?.n ?? 0) > 0 && !isArchived(c)) {
        return { status: 409, jsonBody: { error: 'It has games. Remove them first, or let it end.' } };
      }
      await query('UPDATE competition SET deleted_at = now() WHERE id = $1', [c.id]);
      return { status: 204 };
    }

    if (b.action === 'addTeams') {
      const wanted = [...new Set((Array.isArray(b.teamIds) ? b.teamIds : []).map((t) => String(t).slice(0, 36)))];
      if (!wanted.length) return { status: 400, jsonBody: { error: 'Pick at least one team.' } };
      const allowed = new Set((await eligibleTeams(access, user.id, c)).map((t) => t.id));
      if (wanted.some((t) => !allowed.has(t))) return { status: 400, jsonBody: { error: 'One of those teams cannot join this one.' } };
      await query(
        `INSERT INTO competition_team (competition_id, team_id, added_by)
         SELECT $1, t, $3 FROM unnest($2::uuid[]) AS t ON CONFLICT DO NOTHING`,
        [c.id, wanted, user.id],
      );
      return { status: 200, jsonBody: { added: wanted.length } };
    }

    if (b.action === 'removeTeam') {
      const teamId = String(b.teamId ?? '').slice(0, 36);
      const games = await queryOne<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM game WHERE competition_id = $1 AND team_id = $2 AND deleted_at IS NULL',
        [c.id, teamId],
      );
      if ((games?.n ?? 0) > 0) return { status: 409, jsonBody: { error: 'That team has games in it. Remove them first.' } };
      await query('DELETE FROM competition_team WHERE competition_id = $1 AND team_id = $2', [c.id, teamId]);
      return { status: 204 };
    }

    if (b.action?.startsWith('bracket')) return await bracketAction(c, b, user.id);

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('competitions failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * The league or tournament a new game goes into, checked: the caller manages
 * it, it has not ended, the date is within it and every team takes part.
 */
export async function competitionForGame(
  access: AccessContext,
  userId: string,
  competitionId: string | null | undefined,
  date: string,
  teamIds: string[],
): Promise<{ id: string | null; coachOwned?: boolean } | { error: HttpResponseInit }> {
  const id = String(competitionId ?? '').slice(0, 36);
  if (!id) return { id: null };
  const c = await loadCompetition(id);
  if (!c || !canManageCompetition(access, userId, c)) return { error: FORBIDDEN };
  if (isArchived(c)) return { error: { status: 409, jsonBody: { error: 'That league or tournament has ended.', code: 'ARCHIVED' } } };
  if (date < c.starts_on || date > c.ends_on) {
    return { error: { status: 400, jsonBody: { error: `Pick a date from ${c.starts_on} to ${c.ends_on} for ${c.name}.` } } };
  }
  const inIt = new Set(await competitionTeamIds(c.id));
  if (teamIds.some((t) => !inIt.has(t))) {
    return { error: { status: 400, jsonBody: { error: `Add the team to ${c.name} first.` } } };
  }
  return { id: c.id, coachOwned: Boolean(c.owner_user_id) };
}

app.http('competitions', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'competitions',
  handler: competitionsHandler,
});
