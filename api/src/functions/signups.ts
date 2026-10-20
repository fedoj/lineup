import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnScope,
  canOnTeam,
  cleanCompetitionCode,
  currentSeason,
  registrationStatus,
  suggestCompetitionCode,
  suggestedDivision,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext, loadTeamContext } from '../lib/authz.js';
import { cleanEmail, cleanLabel, cleanSalutation, inviteCoParent } from '../lib/coParent.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { calendarLink, teamLink } from '../lib/links.js';
import { appToday } from '../lib/today.js';

/**
 * Family sign-ups, per league or tournament (Fady, 10/17).
 *
 * Each league or tournament a region runs has its own sign-up code and link,
 * open between its registration dates. A parent creates an account as usual,
 * opens the link (or enters the code) and registers one or more children.
 * Region staff (member.invite at the region) approve or decline each child
 * and place them on one of that league's teams, which adds the player to the
 * roster and links the parent. Returning families pick children already on
 * file instead of retyping them. People who signed up stay in the region's
 * People list.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

interface RegionRow {
  id: string;
  name: string;
  org_id: string;
  org_name: string;
  org_personal: boolean;
}

interface CompRow {
  id: string;
  name: string;
  kind: 'season' | 'tournament';
  starts_on: string;
  ends_on: string;
  /** Null for a coach's own league or tournament (Fady, 10/19). */
  region_id: string | null;
  org_id: string | null;
  owner_user_id: string | null;
  join_code: string | null;
  reg_opens_on: string | null;
  reg_closes_on: string | null;
  /** The region's name, or "Coach <name>" for a coach's own. */
  region_name: string;
  org_name: string | null;
  org_personal: boolean;
}

const COMP_COLUMNS = `c.id, c.name, c.kind, to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
  c.region_id, c.org_id, c.owner_user_id, c.join_code, to_char(c.reg_opens_on, 'YYYY-MM-DD') AS reg_opens_on,
  to_char(c.reg_closes_on, 'YYYY-MM-DD') AS reg_closes_on,
  COALESCE(r.name, CASE WHEN ow.display_name IS NULL OR ow.display_name LIKE '%@%' THEN 'the coach' WHEN ow.display_name ILIKE 'coach %' THEN ow.display_name ELSE 'Coach ' || ow.display_name END) AS region_name,
  o.name AS org_name, COALESCE(o.is_personal, true) AS org_personal`;
const COMP_JOINS = `FROM competition c
  LEFT JOIN region r ON r.id = c.region_id
  LEFT JOIN organization o ON o.id = c.org_id
  LEFT JOIN app_user ow ON ow.id = c.owner_user_id`;

/** Give a region's league or tournament a sign-up code if it has none. */
async function ensureCompetitionCode(c: CompRow): Promise<string> {
  if (c.join_code) return c.join_code;
  for (let i = 0; i < 8; i++) {
    try {
      const row = await queryOne<{ join_code: string }>(
        'UPDATE competition SET join_code = $2 WHERE id = $1 AND join_code IS NULL RETURNING join_code',
        [c.id, suggestCompetitionCode(c.name)],
      );
      if (row) return row.join_code;
      const current = await queryOne<{ join_code: string | null }>('SELECT join_code FROM competition WHERE id = $1', [c.id]);
      if (current?.join_code) return current.join_code;
    } catch {
      // the rare clash with another code: try again
    }
  }
  throw new Error('Could not create a sign-up code');
}

/** The league or tournament a sign-up code points to. */
async function resolveCompetitionCode(raw: string): Promise<CompRow | null> {
  const code = cleanCompetitionCode(raw);
  if (!code) return null;
  return (
    (await queryOne<CompRow>(
      `SELECT ${COMP_COLUMNS} ${COMP_JOINS}
        WHERE c.join_code = $1 AND c.deleted_at IS NULL AND r.deleted_at IS NULL AND o.deleted_at IS NULL`,
      [code],
    )) ?? null
  );
}

function compOut(c: CompRow & { join_code: string }) {
  return {
    competitionId: c.id,
    competitionName: c.name,
    kind: c.kind,
    regionId: c.region_id,
    regionName: c.region_name,
    orgName: c.org_personal ? null : c.org_name,
    code: c.join_code,
    startsOn: c.starts_on,
    endsOn: c.ends_on,
    regOpensOn: c.reg_opens_on,
    regClosesOn: c.reg_closes_on ?? c.ends_on,
    registration: registrationStatus(c.reg_opens_on, c.reg_closes_on, c.ends_on, appToday()),
    season: currentSeason(),
  };
}

const prettyDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Roles region staff can hand to someone already in the region. */
const ASSIGNABLE = ['coach', 'assistant', 'team_parent', 'parent'];
const ROLE_NAME: Record<string, string> = {
  coach: 'Coach',
  assistant: 'Assistant coach',
  team_parent: 'Team parent',
  parent: 'Parent',
};

/**
 * Everyone "in" a region: people who signed up with its code, and people who
 * already hold a role on one of its teams, with those team roles and the
 * children they are linked to on each team.
 */
async function regionPeople(regionId: string) {
  return query<{
    id: string;
    display_name: string | null;
    email: string | null;
    roles: Array<{ teamId: string; teamName: string; role: string; children: string[] }>;
  }>(
    `WITH region_teams AS (
       SELECT id, name FROM team WHERE region_id = $1 AND deleted_at IS NULL
     ), people AS (
       SELECT parent_user_id AS user_id FROM region_signup WHERE region_id = $1 AND status <> 'withdrawn'
       UNION
       SELECT m.user_id FROM membership m JOIN region_teams t ON t.id = m.team_id
     )
     SELECT u.id, u.display_name, u.email,
            COALESCE(json_agg(json_build_object(
                       'teamId', t.id, 'teamName', t.name, 'role', m.role,
                       'children', COALESCE((SELECT json_agg(pl.name ORDER BY pl.name)
                                               FROM player_guardian g JOIN player pl ON pl.id = g.player_id
                                              WHERE g.user_id = u.id AND pl.team_id = t.id), '[]'::json))
                              ORDER BY t.name) FILTER (WHERE m.id IS NOT NULL), '[]'::json) AS roles
       FROM people p
       JOIN app_user u ON u.id = p.user_id
       LEFT JOIN membership m ON m.user_id = u.id AND m.team_id IN (SELECT id FROM region_teams)
       LEFT JOIN region_teams t ON t.id = m.team_id
      GROUP BY u.id, u.display_name, u.email
      ORDER BY lower(COALESCE(u.display_name, u.email, ''))`,
    [regionId],
  );
}

function regionOut(r: RegionRow) {
  return {
    regionId: r.id,
    regionName: r.name,
    orgName: r.org_personal ? null : r.org_name,
    season: currentSeason(),
  };
}

interface SignupRow {
  id: string;
  region_id: string | null;
  region_name: string;
  org_name: string | null;
  competition_id: string | null;
  competition_name: string | null;
  season: string;
  child_name: string;
  birth_year: number;
  birth_month: number;
  gender: 'boys' | 'girls';
  parent_phone: string | null;
  parent_email: string | null;
  parent_name: string | null;
  parent_label: string | null;
  second_parent_email: string | null;
  status: string;
  team_id: string | null;
  team_name: string | null;
  created_at: Date;
}

const SIGNUP_COLUMNS = `s.id, s.region_id,
  COALESCE(r.name, CASE WHEN cow.display_name IS NULL OR cow.display_name LIKE '%@%' THEN 'the coach' WHEN cow.display_name ILIKE 'coach %' THEN cow.display_name ELSE 'Coach ' || cow.display_name END) AS region_name,
  CASE WHEN o.is_personal IS NOT FALSE THEN NULL ELSE o.name END AS org_name, s.competition_id, cm.name AS competition_name,
  s.season, s.child_name,
  s.birth_year, s.birth_month, s.gender, s.parent_phone, u.email AS parent_email,
  u.display_name AS parent_name, s.parent_label, s.second_parent_email, s.status, s.team_id, t.name AS team_name, s.created_at`;
const SIGNUP_JOINS = `FROM region_signup s
  LEFT JOIN region r ON r.id = s.region_id
  LEFT JOIN organization o ON o.id = r.org_id
  JOIN app_user u ON u.id = s.parent_user_id
  LEFT JOIN team t ON t.id = s.team_id
  LEFT JOIN competition cm ON cm.id = s.competition_id
  LEFT JOIN app_user cow ON cow.id = cm.owner_user_id`;

function signupOut(s: SignupRow, withContact: boolean) {
  return {
    id: s.id,
    regionId: s.region_id,
    regionName: s.region_name,
    orgName: s.org_name,
    competitionId: s.competition_id,
    competitionName: s.competition_name,
    season: s.season,
    childName: s.child_name,
    birthYear: s.birth_year,
    birthMonth: s.birth_month,
    gender: s.gender,
    division: suggestedDivision(s.birth_year, s.gender, s.season),
    status: s.status,
    teamId: s.team_id,
    teamName: s.team_name,
    createdAt: s.created_at.toISOString(),
    ...(withContact
      ? {
          parentEmail: s.parent_email,
          parentName: s.parent_name,
          parentPhone: s.parent_phone,
          parentLabel: s.parent_label,
          secondParentEmail: s.second_parent_email,
        }
      : {}),
  };
}

/** Parent side: look up a code, sign children up, see and withdraw requests. */
export async function joinHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const [mine, children] = await Promise.all([
        query<SignupRow>(`SELECT ${SIGNUP_COLUMNS} ${SIGNUP_JOINS} WHERE s.parent_user_id = $1 ORDER BY s.created_at DESC LIMIT 50`, [user.id]),
        // Children already on file, so a returning family picks rather than retypes.
        query<{ id: string; name: string; team_name: string }>(
          `SELECT p.id, p.name, t.name AS team_name
             FROM player_guardian g JOIN player p ON p.id = g.player_id JOIN team t ON t.id = p.team_id
            WHERE g.user_id = $1 AND t.deleted_at IS NULL ORDER BY p.name`,
          [user.id],
        ),
      ]);
      return {
        status: 200,
        jsonBody: {
          signups: mine.map((s) => signupOut(s, false)),
          children: children.map((c) => ({ playerId: c.id, name: c.name, teamName: c.team_name })),
          season: currentSeason(),
        },
      };
    }

    if (req.method === 'DELETE') {
      const row = await queryOne<{ id: string }>(
        `UPDATE region_signup SET status = 'withdrawn'
          WHERE id = $1 AND parent_user_id = $2 AND status IN ('pending', 'approved') RETURNING id`,
        [req.query.get('id') ?? '', user.id],
      );
      return row ? { status: 204 } : { status: 404, jsonBody: { error: 'Nothing to withdraw.' } };
    }

    const b = (await req.json()) as {
      code?: string;
      lookup?: boolean;
      phone?: string;
      children?: Array<{ name?: string; birthYear?: number; birthMonth?: number; gender?: string; priorPlayerId?: string }>;
      /** Optional (Fady, 10/19): mother, father or guardian; a salutation; the other parent. */
      parentLabel?: string;
      salutation?: string;
      secondParentEmail?: string;
      secondParentLabel?: string;
    };
    const found = await resolveCompetitionCode(clip(b.code, 60));
    if (!found) {
      return {
        status: 404,
        jsonBody: { error: 'That code does not match a league or tournament. Check it with whoever sent it.', code: 'CODE_NOT_FOUND' },
      };
    }
    const comp = { ...found, join_code: found.join_code! };
    const info = compOut(comp);
    if (b.lookup) return { status: 200, jsonBody: info };
    if (info.registration === 'closed') {
      return { status: 409, jsonBody: { error: `Registration closed on ${prettyDay(info.regClosesOn)}.`, code: 'REGISTRATION_CLOSED' } };
    }
    if (info.registration === 'upcoming') {
      return { status: 409, jsonBody: { error: `Registration opens on ${prettyDay(info.regOpensOn!)}.`, code: 'REGISTRATION_NOT_OPEN' } };
    }
    const region = { id: comp.region_id, name: comp.region_name };

    const thisYear = new Date().getFullYear();
    const kids = (b.children ?? []).slice(0, 8).map((c) => ({
      name: clip(c.name, 80),
      birthYear: Math.round(Number(c.birthYear)),
      birthMonth: Math.round(Number(c.birthMonth)),
      gender: c.gender === 'girls' ? 'girls' : c.gender === 'boys' ? 'boys' : '',
      priorPlayerId: clip(c.priorPlayerId, 36) || null,
    }));
    if (kids.length === 0) return { status: 400, jsonBody: { error: 'Add at least one child.' } };
    for (const k of kids) {
      if (!k.name || !k.gender || !(k.birthYear >= thisYear - 19 && k.birthYear <= thisYear - 3) || !(k.birthMonth >= 1 && k.birthMonth <= 12)) {
        return { status: 400, jsonBody: { error: 'Each child needs a name, birth year and month, and boys or girls.' } };
      }
    }
    const phone = clip(b.phone, 30).replace(/[^\d+()\-\s]/g, '') || null;
    const season = currentSeason();
    const parentLabel = cleanLabel(b.parentLabel);
    const secondEmail = b.secondParentEmail ? cleanEmail(b.secondParentEmail) : null;
    if (b.secondParentEmail && clip(b.secondParentEmail, 200) && !secondEmail) {
      return { status: 400, jsonBody: { error: "The other parent's email doesn't look right." } };
    }
    if (secondEmail && user.email && secondEmail === user.email.toLowerCase()) {
      return { status: 400, jsonBody: { error: "Use the other parent's email, not your own." } };
    }
    const secondLabel = secondEmail ? cleanLabel(b.secondParentLabel) : null;
    const salutation = cleanSalutation(b.salutation);
    if (salutation) await query('UPDATE app_user SET salutation = $2 WHERE id = $1', [user.id, salutation]);

    const created = await transaction(async (client) => {
      const out: string[] = [];
      for (const k of kids) {
        // A child picked from a past season must really be this parent's.
        let prior: string | null = null;
        if (k.priorPlayerId) {
          const own = await client.query('SELECT 1 FROM player_guardian WHERE player_id = $1 AND user_id = $2', [k.priorPlayerId, user.id]);
          prior = own.rowCount ? k.priorPlayerId : null;
        }
        const r = await client.query<{ id: string }>(
          `INSERT INTO region_signup (region_id, parent_user_id, season, child_name, birth_year, birth_month, gender, parent_phone,
                                      prior_player_id, competition_id, parent_label, second_parent_email, second_parent_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT DO NOTHING RETURNING id`,
          [region.id, user.id, season, k.name, k.birthYear, k.birthMonth, k.gender, phone, prior, comp.id, parentLabel, secondEmail, secondLabel],
        );
        if (r.rows[0]) out.push(r.rows[0].id);
      }
      return out;
    });

    // Let the people who place children know there is someone to place: the
    // region's admins and directors, or the coach who runs it.
    if (created.length > 0) {
      const title = `New sign-up${created.length === 1 ? '' : 's'} for ${comp.name}`;
      const body = `${created.length} ${created.length === 1 ? 'child is' : 'children are'} waiting to be approved and placed on a ${comp.kind === 'tournament' ? 'tournament' : 'league'} team.`;
      if (region.id) {
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link)
           SELECT DISTINCT m.user_id, 'message', $2, $3, '/signups?region=' || $1
             FROM membership m
            WHERE m.role IN ('org_admin', 'director', 'region_admin')
              AND (m.region_id = $1 OR m.org_id = (SELECT org_id FROM region WHERE id = $1))`,
          [region.id, title, body],
        ).catch((e) => ctx.warn('signup notify failed', e));
      } else if (comp.owner_user_id) {
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'message', $2, $3, '/competitions')`,
          [comp.owner_user_id, title, `${body} Open ${comp.name} under Games & matches.`],
        ).catch((e) => ctx.warn('signup notify failed', e));
      } else if (comp.org_id) {
        // An organization's own league or tournament: its admins and directors.
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link)
           SELECT DISTINCT m.user_id, 'message', $2, $3, '/seasons?org=' || $1
             FROM membership m
            WHERE m.role IN ('org_admin', 'director') AND m.org_id = $1`,
          [comp.org_id, title, `${body} Open ${comp.name} under Games & matches.`],
        ).catch((e) => ctx.warn('signup notify failed', e));
      }
    }

    return {
      status: 201,
      jsonBody: { created: created.length, skipped: kids.length - created.length, region: info },
    };
  } catch (err) {
    ctx.error('join failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * Place a signed-up child on a team: add the player, link the parent who
 * signed them up (mother, father or guardian; the primary parent) and give
 * them the parent role, then invite the other parent if one was given.
 * `scope` keeps a region's staff to its sign-ups and a coach to their league's.
 */
async function placeSignup(
  id: string,
  teamId: string,
  userId: string,
  scope: { regionId?: string; competitionId?: string },
): Promise<{ parent: string; child: string; playerId: string; secondParent: string | null } | null> {
  const placed = await transaction(async (client) => {
    const s = await client.query<{
      id: string; parent_user_id: string; child_name: string; status: string; gender: string;
      parent_label: string | null; second_parent_email: string | null; second_parent_label: string | null;
    }>(
      `SELECT id, parent_user_id, child_name, status, gender, parent_label, second_parent_email, second_parent_label
         FROM region_signup
        WHERE id = $1 AND ($2::uuid IS NULL OR region_id = $2) AND ($3::uuid IS NULL OR competition_id = $3)
        FOR UPDATE`,
      [id, scope.regionId ?? null, scope.competitionId ?? null],
    );
    const row = s.rows[0];
    if (!row || !['pending', 'approved'].includes(row.status)) return null;
    const p = await client.query<{ id: string }>(
      `INSERT INTO player (team_id, number, name, gender) VALUES ($1, '', $2, $3) RETURNING id`,
      [teamId, row.child_name, row.gender === 'girls' ? 'girl' : row.gender === 'boys' ? 'boy' : null],
    );
    const playerId = p.rows[0].id;
    await client.query(
      `INSERT INTO player_guardian (player_id, user_id, relation, label, is_primary, consented_at, consented_by)
       VALUES ($1, $2, 'parent', $4, true, now(), $3) ON CONFLICT DO NOTHING`,
      [playerId, row.parent_user_id, userId, row.parent_label],
    );
    // A parent who already has a role on the team keeps it.
    await client.query(
      `INSERT INTO membership (user_id, role, team_id)
       SELECT $1, 'parent', $2
        WHERE NOT EXISTS (SELECT 1 FROM membership WHERE user_id = $1 AND team_id = $2)`,
      [row.parent_user_id, teamId],
    );
    await client.query(
      `UPDATE region_signup SET status = 'placed', team_id = $2, player_id = $3, decided_by = $4, decided_at = now()
        WHERE id = $1`,
      [row.id, teamId, playerId, userId],
    );
    return { parent: row.parent_user_id, child: row.child_name, playerId, second: row.second_parent_email, secondLabel: row.second_parent_label };
  });
  if (!placed) return null;
  // The other parent gets the same children (Fady, 10/19).
  let secondParent: string | null = null;
  if (placed.second) {
    const r = await inviteCoParent({
      email: placed.second,
      label: cleanLabel(placed.secondLabel),
      parentUserId: placed.parent,
      teamId,
      playerId: placed.playerId,
    }).catch(() => null);
    secondParent = r?.linked ? 'linked' : r?.created ? 'invited' : r?.reason ?? null;
  }
  return { parent: placed.parent, child: placed.child, playerId: placed.playerId, secondParent };
}

/** Region staff: the region's code and the children waiting to be placed. */
export async function regionSignupsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    const regionId = req.method === 'GET' ? req.query.get('regionId') ?? '' : '';
    const b = req.method === 'GET' ? {} : ((await req.json()) as {
      regionId?: string;
      action?: 'approve' | 'decline' | 'place' | 'assign' | 'window';
      ids?: string[];
      id?: string;
      teamId?: string;
    });
    const rid = regionId || clip((b as { regionId?: string }).regionId, 36);
    const region = await queryOne<RegionRow>(
      `SELECT r.id, r.name, r.org_id, o.name AS org_name, o.is_personal AS org_personal
         FROM region r JOIN organization o ON o.id = r.org_id
        WHERE r.id = $1 AND r.deleted_at IS NULL AND NOT r.is_personal`,
      [rid],
    );
    if (!region) return FORBIDDEN;
    if (!canOnScope(access, { orgId: region.org_id, regionId: region.id }, 'member.invite').allowed) return FORBIDDEN;

    if (req.method === 'GET') {
      const today = appToday();
      const [rows, teams, comps] = await Promise.all([
        query<SignupRow>(
          `SELECT ${SIGNUP_COLUMNS} ${SIGNUP_JOINS}
            WHERE s.region_id = $1 AND s.status <> 'withdrawn'
              AND (s.season = $2 OR s.status IN ('pending', 'approved'))
            ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'placed' THEN 2 ELSE 3 END, s.birth_year DESC, s.child_name`,
          [region.id, currentSeason()],
        ),
        query<{ id: string; name: string; catalog_division_id: string | null }>(
          `SELECT id, name, catalog_division_id FROM team WHERE region_id = $1 AND deleted_at IS NULL AND archived_at IS NULL ORDER BY name`,
          [region.id],
        ),
        // The region's leagues and tournaments that have not ended, each with its sign-up link.
        query<CompRow>(
          `SELECT ${COMP_COLUMNS} ${COMP_JOINS}
            WHERE c.region_id = $1 AND c.deleted_at IS NULL AND c.ends_on >= $2::date
            ORDER BY c.starts_on, c.name`,
          [region.id, today],
        ),
      ]);
      const compTeams = comps.length
        ? await query<{ competition_id: string; team_id: string }>(
            'SELECT competition_id, team_id FROM competition_team WHERE competition_id = ANY($1::uuid[])',
            [comps.map((c) => c.id)],
          )
        : [];
      const competitions = [];
      for (const c of comps) {
        const code = await ensureCompetitionCode(c);
        const info = compOut({ ...c, join_code: code });
        competitions.push({
          ...info,
          teamIds: compTeams.filter((t) => t.competition_id === c.id).map((t) => t.team_id),
          waiting: rows.filter((s) => s.competition_id === c.id && (s.status === 'pending' || s.status === 'approved')).length,
        });
      }
      return {
        status: 200,
        jsonBody: {
          region: regionOut(region),
          competitions,
          signups: rows.map((s) => signupOut(s, true)),
          teams: teams.map((t) => ({ id: t.id, name: t.name, division: t.catalog_division_id })),
          people: (await regionPeople(region.id)).map((p) => ({
            userId: p.id,
            name: p.display_name,
            email: p.email,
            roles: p.roles,
          })),
        },
      };
    }

    const action = (b as { action?: string }).action;

    // Give someone already in the region a role on one of its teams, with no
    // invite: they signed up with the region code or already belong to one of
    // its teams.
    if (action === 'assign') {
      const target = clip((b as { userId?: string }).userId, 36);
      const teamId = clip((b as { teamId?: string }).teamId, 36);
      const role = String((b as { role?: string }).role ?? '');
      if (!ASSIGNABLE.includes(role)) {
        return { status: 400, jsonBody: { error: 'Choose coach, assistant coach, team parent or parent.' } };
      }
      const team = await loadTeamContext(teamId);
      if (!team || team.regionId !== region.id) return { status: 400, jsonBody: { error: 'Pick a team in this region.' } };
      const inRegion = (await regionPeople(region.id)).some((p) => p.id === target);
      if (!inRegion) {
        return { status: 400, jsonBody: { error: 'That person has not joined this region yet. Invite them instead.' } };
      }
      // A parent is always linked to their child on the team; other roles may
      // pick one (a coach or team parent who is also a parent).
      const playerId = clip((b as { playerId?: string }).playerId, 36);
      const child = playerId
        ? await queryOne<{ id: string }>('SELECT id FROM player WHERE id = $1 AND team_id = $2', [playerId, team.teamId])
        : null;
      if (playerId && !child) return { status: 400, jsonBody: { error: 'Pick a player on that team.' } };
      if (role === 'parent' && !child) {
        return { status: 400, jsonBody: { error: "Pick the parent's child on that team.", code: 'PLAYER_REQUIRED' } };
      }
      await query(
        `INSERT INTO membership (user_id, role, team_id) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, team_id) WHERE team_id IS NOT NULL DO UPDATE SET role = EXCLUDED.role`,
        [target, role, team.teamId],
      );
      if (child) {
        await query(
          `INSERT INTO player_guardian (player_id, user_id, relation, consented_at, consented_by)
           VALUES ($1, $2, 'parent', now(), $3) ON CONFLICT DO NOTHING`,
          [child.id, target, user.id],
        );
      }
      const teamName = (await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [team.teamId]))?.name ?? 'a team';
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, $4)`,
        [target, `You are now ${ROLE_NAME[role]} of ${teamName}`, `${region.name} gave you the ${ROLE_NAME[role].toLowerCase()} role on ${teamName}. It shows in your menu.`, teamLink(team.teamId)],
      ).catch(() => undefined);
      return { status: 200, jsonBody: { assigned: true, role, teamId: team.teamId } };
    }

    // A league's or tournament's registration window.
    if (action === 'window') {
      const compId = clip((b as { competitionId?: string }).competitionId, 36);
      const comp = await queryOne<{ id: string; ends_on: string }>(
        `SELECT id, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM competition
          WHERE id = $1 AND region_id = $2 AND deleted_at IS NULL`,
        [compId, region.id],
      );
      if (!comp) return { status: 400, jsonBody: { error: 'Pick one of this region’s leagues or tournaments.' } };
      const day = (v: unknown) => {
        const s = clip(v, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      };
      const opens = day((b as { regOpensOn?: string }).regOpensOn);
      const closes = day((b as { regClosesOn?: string }).regClosesOn);
      if (opens && closes && closes < opens) {
        return { status: 400, jsonBody: { error: 'Registration has to close after it opens.' } };
      }
      await query('UPDATE competition SET reg_opens_on = $2::date, reg_closes_on = $3::date, updated_at = now() WHERE id = $1', [
        comp.id,
        opens,
        closes,
      ]);
      return { status: 200, jsonBody: { id: comp.id, regOpensOn: opens, regClosesOn: closes ?? comp.ends_on } };
    }

    if (action === 'approve' || action === 'decline') {
      const ids = ((b as { ids?: string[] }).ids ?? []).map((x) => clip(x, 36)).slice(0, 200);
      const next = action === 'approve' ? 'approved' : 'declined';
      const rows = await query<{ id: string; parent_user_id: string; child_name: string }>(
        `UPDATE region_signup SET status = $3, decided_by = $4, decided_at = now()
          WHERE region_id = $1 AND id = ANY($2::uuid[]) AND status IN ('pending', 'approved')
          RETURNING id, parent_user_id, child_name`,
        [region.id, ids, next, user.id],
      );
      for (const r of rows) {
        await query(
          `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, '/account')`,
          [
            r.parent_user_id,
            `${region.name} sign-up`,
            action === 'approve'
              ? `${r.child_name} is approved for ${region.name}. You will hear when they are placed on a team.`
              : `${r.child_name}'s sign-up for ${region.name} was not accepted. Contact the region with any questions.`,
          ],
        ).catch(() => undefined);
      }
      return { status: 200, jsonBody: { updated: rows.length } };
    }

    if (action === 'place') {
      const id = clip((b as { id?: string }).id, 36);
      const teamId = clip((b as { teamId?: string }).teamId, 36);
      const team = await loadTeamContext(teamId);
      if (!team || team.regionId !== region.id) {
        return { status: 400, jsonBody: { error: 'Pick a team in this region.' } };
      }
      if (!canOnTeam(access, team, 'roster.edit').allowed) return FORBIDDEN;
      // A league or tournament sign-up goes on one of its teams.
      const signup = await queryOne<{ competition_id: string | null }>(
        'SELECT competition_id FROM region_signup WHERE id = $1 AND region_id = $2',
        [id, region.id],
      );
      if (signup?.competition_id) {
        const inIt = await queryOne('SELECT 1 FROM competition_team WHERE competition_id = $1 AND team_id = $2', [
          signup.competition_id,
          team.teamId,
        ]);
        if (!inIt) return { status: 400, jsonBody: { error: 'Pick a team taking part in that league or tournament.' } };
      }

      const placed = await placeSignup(id, team.teamId, user.id, { regionId: region.id });
      if (!placed) return { status: 409, jsonBody: { error: 'This sign-up was already placed or closed.' } };

      const teamName = (await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [team.teamId]))?.name ?? 'a team';
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, $4)`,
        [placed.parent, `${placed.child} is on ${teamName}`, `${placed.child} has been placed on ${teamName} in ${region.name}. The team now shows in your menu.`, calendarLink(team.teamId)],
      ).catch(() => undefined);
      return { status: 200, jsonBody: { placed: true, playerId: placed.playerId, teamId: team.teamId, secondParent: placed.secondParent } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('region signups failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * The sign-up link and waiting children for one league or tournament, shown
 * on its own page (Fady, 10/19: a cup had no join code or link). A coach's own
 * one is managed by that coach; a region's or organization's by its staff
 * (member.invite there), who also see the region's sign-ups in its Sign-ups tab.
 */
export async function coachSignupsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);
    const b = req.method === 'GET'
      ? {}
      : ((await req.json()) as {
          competitionId?: string;
          action?: string;
          ids?: string[];
          id?: string;
          teamId?: string;
          regOpensOn?: string | null;
          regClosesOn?: string | null;
        });
    const compId = clip(req.method === 'GET' ? req.query.get('competitionId') : (b as { competitionId?: string }).competitionId, 36);
    const comp = await queryOne<CompRow>(`SELECT ${COMP_COLUMNS} ${COMP_JOINS} WHERE c.id = $1 AND c.deleted_at IS NULL`, [compId]);
    if (!comp) return FORBIDDEN;
    const manages = comp.owner_user_id
      ? comp.owner_user_id === user.id || Boolean(access.isPlatformAdmin)
      : Boolean(comp.org_id) &&
        canOnScope(access, { orgId: comp.org_id!, regionId: comp.region_id }, 'member.invite').allowed;
    if (!manages) return FORBIDDEN;
    const who = comp.name;

    if (req.method === 'GET') {
      const code = await ensureCompetitionCode(comp);
      const [rows, teams] = await Promise.all([
        query<SignupRow>(
          `SELECT ${SIGNUP_COLUMNS} ${SIGNUP_JOINS}
            WHERE s.competition_id = $1 AND s.status <> 'withdrawn'
            ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'placed' THEN 2 ELSE 3 END, s.birth_year DESC, s.child_name`,
          [comp.id],
        ),
        query<{ id: string; name: string; catalog_division_id: string | null }>(
          `SELECT t.id, t.name, t.catalog_division_id FROM competition_team ct JOIN team t ON t.id = ct.team_id
            WHERE ct.competition_id = $1 AND t.deleted_at IS NULL AND t.archived_at IS NULL ORDER BY t.name`,
          [comp.id],
        ),
      ]);
      return {
        status: 200,
        jsonBody: {
          competition: {
            ...compOut({ ...comp, join_code: code }),
            teamIds: teams.map((t) => t.id),
            waiting: rows.filter((s) => s.status === 'pending' || s.status === 'approved').length,
          },
          signups: rows.map((s) => signupOut(s, true)),
          teams: teams.map((t) => ({ id: t.id, name: t.name, division: t.catalog_division_id })),
        },
      };
    }

    const action = (b as { action?: string }).action;

    if (action === 'window') {
      const day = (v: unknown) => {
        const s = clip(v, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
      };
      const opens = day((b as { regOpensOn?: string }).regOpensOn);
      const closes = day((b as { regClosesOn?: string }).regClosesOn);
      if (opens && closes && closes < opens) return { status: 400, jsonBody: { error: 'Registration has to close after it opens.' } };
      await query('UPDATE competition SET reg_opens_on = $2::date, reg_closes_on = $3::date, updated_at = now() WHERE id = $1', [
        comp.id,
        opens,
        closes,
      ]);
      return { status: 200, jsonBody: { id: comp.id, regOpensOn: opens, regClosesOn: closes ?? comp.ends_on } };
    }

    if (action === 'approve' || action === 'decline') {
      const ids = ((b as { ids?: string[] }).ids ?? []).map((x) => clip(x, 36)).slice(0, 200);
      const next = action === 'approve' ? 'approved' : 'declined';
      const rows = await query<{ id: string; parent_user_id: string; child_name: string }>(
        `UPDATE region_signup SET status = $3, decided_by = $4, decided_at = now()
          WHERE competition_id = $1 AND id = ANY($2::uuid[]) AND status IN ('pending', 'approved')
          RETURNING id, parent_user_id, child_name`,
        [comp.id, ids, next, user.id],
      );
      for (const r of rows) {
        await query(`INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, '/account')`, [
          r.parent_user_id,
          `${who} sign-up`,
          action === 'approve'
            ? `${r.child_name} is approved for ${who}. You will hear when they are placed on a team.`
            : `${r.child_name}'s sign-up for ${who} was not accepted. Contact the coach with any questions.`,
        ]).catch(() => undefined);
      }
      return { status: 200, jsonBody: { updated: rows.length } };
    }

    if (action === 'place') {
      const id = clip((b as { id?: string }).id, 36);
      const team = await loadTeamContext(clip((b as { teamId?: string }).teamId, 36));
      const inIt = team
        ? await queryOne('SELECT 1 FROM competition_team WHERE competition_id = $1 AND team_id = $2', [comp.id, team.teamId])
        : null;
      if (!team || !inIt) return { status: 400, jsonBody: { error: 'Pick one of its teams.' } };
      if (!canOnTeam(access, team, 'roster.edit').allowed) return FORBIDDEN;
      const placed = await placeSignup(id, team.teamId, user.id, { competitionId: comp.id });
      if (!placed) return { status: 409, jsonBody: { error: 'This sign-up was already placed or closed.' } };
      const teamName = (await queryOne<{ name: string }>('SELECT name FROM team WHERE id = $1', [team.teamId]))?.name ?? 'a team';
      await query(`INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, $4)`, [
        placed.parent,
        `${placed.child} is on ${teamName}`,
        `${placed.child} has been placed on ${teamName} for ${who}. The team now shows in your menu.`,
        calendarLink(team.teamId),
      ]).catch(() => undefined);
      return { status: 200, jsonBody: { placed: true, playerId: placed.playerId, teamId: team.teamId, secondParent: placed.secondParent } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('coach signups failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('join', {
  methods: ['GET', 'POST', 'DELETE'], authLevel: 'anonymous', route: 'join', handler: joinHandler,
});
app.http('competitionSignups', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'competition-signups', handler: coachSignupsHandler,
});
app.http('regionSignups', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'region-signups', handler: regionSignupsHandler,
});
