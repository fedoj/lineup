import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnScope,
  cleanRefereeCode,
  isRefereeSlot,
  isValidRefereeCode,
  newRefereeCode,
  REFEREE_SLOT_LABELS,
  REFEREE_SLOTS,
  type AccessContext,
  type RefereeSlot,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { appToday } from '../lib/today.js';

/**
 * Referees, part 1: joining and game sign-up.
 *
 * An organization (or a standalone region, through its hidden organization)
 * turns on referee sign-up and shares its referee code or link. Whoever enters
 * the code becomes one of its referees: no region to join, every league game
 * in the organization is open to them, and a favorite region filters the list.
 *
 * Each league game has a main referee and two assistant referee spots, first
 * come first served. The organization's or region's staff (whoever schedules
 * the game) can take a referee out of a spot or put another referee in.
 * Teams' own games (friendlies, standalone teams) have no referees.
 */

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

const LINK_PATH = '/referee';

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function todayIso(): string {
  return appToday();
}

function appOrigin(): string {
  const configured = process.env.APP_ORIGIN?.replace(/\/+$/, '');
  if (configured) return configured;
  return process.env.APP_ENV === 'prd' ? 'https://lineup.mahoul.io' : 'https://lineup-dev.mahoul.io';
}

function prettyDay(iso: string | null): string {
  if (!iso) return 'a date to be set';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/* ------------------------------------------------------------ fixtures */

export interface FixtureRow {
  id: string;
  org_id: string;
  home_team_id: string;
  away_team_id: string;
  date: string;
  kickoff: string | null;
  location: string | null;
  field: string | null;
  home_name: string;
  away_name: string;
  home_region_id: string | null;
  away_region_id: string | null;
  region_name: string | null;
  canceled: boolean;
  official: boolean;
}

const FIXTURE_SELECT = `
  SELECT f.id, f.org_id, f.home_team_id, f.away_team_id, to_char(f.date, 'YYYY-MM-DD') AS date, f.kickoff, f.location, f.field,
         th.name AS home_name, ta.name AS away_name,
         th.region_id AS home_region_id, ta.region_id AS away_region_id,
         CASE WHEN rh.is_personal THEN NULL ELSE rh.name END AS region_name,
         EXISTS (SELECT 1 FROM game g WHERE g.fixture_id = f.id AND g.deleted_at IS NULL
                   AND g.canceled_at IS NOT NULL) AS canceled,
         EXISTS (SELECT 1 FROM fixture_ref_report rr WHERE rr.fixture_id = f.id
                   AND rr.final_at IS NOT NULL) AS official
    FROM fixture f
    JOIN team th ON th.id = f.home_team_id
    JOIN team ta ON ta.id = f.away_team_id
    LEFT JOIN region rh ON rh.id = th.region_id`;

export async function loadFixture(id: string): Promise<FixtureRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await queryOne<FixtureRow>(`${FIXTURE_SELECT} WHERE f.id = $1 AND f.deleted_at IS NULL`, [id])) ?? null;
}

/** May the caller manage this game's referees? The same people who schedule it. */
export function canManageFixture(access: AccessContext, f: Pick<FixtureRow, 'org_id' | 'home_region_id' | 'away_region_id'>): boolean {
  return (
    canOnScope(access, { orgId: f.org_id, regionId: f.home_region_id }, 'game.create').allowed &&
    canOnScope(access, { orgId: f.org_id, regionId: f.away_region_id }, 'game.create').allowed
  );
}

export interface SlotHolder {
  userId: string;
  name: string;
}

export type FixtureReferees = Record<RefereeSlot, SlotHolder | null>;

/** Who holds each spot, for a set of league games. */
export async function loadFixtureReferees(fixtureIds: string[]): Promise<Map<string, FixtureReferees>> {
  const out = new Map<string, FixtureReferees>();
  if (fixtureIds.length === 0) return out;
  const rows = await query<{ fixture_id: string; slot: RefereeSlot; user_id: string; name: string }>(
    `SELECT fr.fixture_id, fr.slot, fr.user_id, COALESCE(NULLIF(u.display_name, ''), 'Referee') AS name
       FROM fixture_referee fr JOIN app_user u ON u.id = fr.user_id
      WHERE fr.fixture_id = ANY($1::uuid[])`,
    [fixtureIds],
  );
  for (const id of fixtureIds) out.set(id, { main: null, ar1: null, ar2: null });
  for (const r of rows) out.get(r.fixture_id)![r.slot] = { userId: r.user_id, name: r.name };
  return out;
}

/** The referees of an organization, for staff picking who fills a spot. */
export async function loadRefereePool(orgIds: string[]): Promise<Map<string, SlotHolder[]>> {
  const out = new Map<string, SlotHolder[]>();
  if (orgIds.length === 0) return out;
  const rows = await query<{ org_id: string; user_id: string; name: string }>(
    `SELECT r.org_id, r.user_id, COALESCE(NULLIF(u.display_name, ''), u.email, 'Referee') AS name
       FROM referee r JOIN app_user u ON u.id = r.user_id
      WHERE r.org_id = ANY($1::uuid[])
      ORDER BY lower(COALESCE(u.display_name, u.email, ''))`,
    [orgIds],
  );
  for (const r of rows) out.set(r.org_id, [...(out.get(r.org_id) ?? []), { userId: r.user_id, name: r.name }]);
  return out;
}

async function notify(userId: string, title: string, body: string): Promise<void> {
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'message', $2, $3, $4)`,
    [userId, title, body, LINK_PATH],
  );
}

/** Tell a game's referees about a change to it (cancelled, back on). */
export async function notifyFixtureReferees(fixtureId: string, actorId: string, title: string, body: string): Promise<void> {
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT fr.user_id, 'message', $3, $4, $5 FROM fixture_referee fr
      WHERE fr.fixture_id = $1 AND fr.user_id <> $2`,
    [fixtureId, actorId, title, body, LINK_PATH],
  );
}

function gameLabel(f: Pick<FixtureRow, 'home_name' | 'away_name' | 'date'>): string {
  return `${f.home_name} vs ${f.away_name} on ${prettyDay(f.date)}`;
}

/* ------------------------------------------------- the referee's own view */

interface RefOrgRow {
  org_id: string;
  name: string;
  is_personal: boolean;
  favorite_region_id: string | null;
}

async function myRefereeOrgs(userId: string): Promise<RefOrgRow[]> {
  // A standalone region's organization is hidden: show the region's name.
  return query<RefOrgRow>(
    `SELECT r.org_id, r.favorite_region_id, o.is_personal,
            CASE WHEN o.is_personal
                 THEN COALESCE((SELECT g.name FROM region g WHERE g.org_id = o.id AND NOT g.is_personal
                                  AND g.deleted_at IS NULL ORDER BY g.created_at LIMIT 1), o.name)
                 ELSE o.name END AS name
       FROM referee r JOIN organization o ON o.id = r.org_id
      WHERE r.user_id = $1 AND o.deleted_at IS NULL
      ORDER BY name`,
    [userId],
  );
}

function toGame(f: FixtureRow, refs: FixtureReferees | undefined, userId: string, orgName: string) {
  const slots = refs ?? { main: null, ar1: null, ar2: null };
  const mine = REFEREE_SLOTS.find((s) => slots[s]?.userId === userId) ?? null;
  return {
    fixtureId: f.id,
    orgId: f.org_id,
    orgName,
    regionId: f.home_region_id,
    // Either team's region counts for a referee's favorite region.
    regionIds: [...new Set([f.home_region_id, f.away_region_id].filter((x): x is string => Boolean(x)))],
    regionName: f.region_name,
    date: f.date,
    kickoff: f.kickoff,
    location: f.location,
    field: f.field,
    home: f.home_name,
    away: f.away_name,
    canceled: f.canceled,
    official: f.official,
    mySlot: mine,
    slots: {
      main: slots.main ? { name: slots.main.name, mine: slots.main.userId === userId } : null,
      ar1: slots.ar1 ? { name: slots.ar1.name, mine: slots.ar1.userId === userId } : null,
      ar2: slots.ar2 ? { name: slots.ar2.name, mine: slots.ar2.userId === userId } : null,
    },
  };
}

async function refereeView(userId: string) {
  const orgs = await myRefereeOrgs(userId);
  const orgIds = orgs.map((o) => o.org_id);
  const regions = orgIds.length
    ? await query<{ id: string; org_id: string; name: string }>(
        `SELECT id, org_id, name FROM region
          WHERE org_id = ANY($1::uuid[]) AND deleted_at IS NULL AND NOT is_personal ORDER BY name`,
        [orgIds],
      )
    : [];
  const today = todayIso();
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  // Upcoming games in the referee's organizations, and their own recent ones.
  const fixtures = orgIds.length
    ? await query<FixtureRow>(
        `${FIXTURE_SELECT}
          WHERE f.deleted_at IS NULL AND f.org_id = ANY($1::uuid[])
            AND (f.date >= $2 OR (f.date >= $3 AND EXISTS (
                  SELECT 1 FROM fixture_referee x WHERE x.fixture_id = f.id AND x.user_id = $4)))
          ORDER BY f.date, f.kickoff NULLS LAST
          LIMIT 400`,
        [orgIds, today, recent, userId],
      )
    : [];
  const refs = await loadFixtureReferees(fixtures.map((f) => f.id));
  const orgName = new Map(orgs.map((o) => [o.org_id, o.name]));
  const games = fixtures.map((f) => toGame(f, refs.get(f.id), userId, orgName.get(f.org_id) ?? ''));
  return {
    orgs: orgs.map((o) => ({
      orgId: o.org_id,
      name: o.name,
      favoriteRegionId: o.favorite_region_id,
      regions: regions.filter((r) => r.org_id === o.org_id).map((r) => ({ id: r.id, name: r.name })),
    })),
    mine: games.filter((g) => g.mySlot),
    open: games.filter(
      (g) => !g.mySlot && !g.canceled && g.date >= today && REFEREE_SLOTS.some((s) => !g.slots[s]),
    ),
  };
}

export async function refereeHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') return { status: 200, jsonBody: await refereeView(user.id) };

    const b = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const action = clip(b.action, 20);

    if (action === 'join') {
      const code = cleanRefereeCode(b.code);
      if (!isValidRefereeCode(code)) {
        return { status: 400, jsonBody: { error: 'That referee code is not valid. Check it and try again.', code: 'BAD_CODE' } };
      }
      const org = await queryOne<{ id: string }>(
        'SELECT id FROM organization WHERE referee_code = $1 AND deleted_at IS NULL',
        [code],
      );
      if (!org) {
        return { status: 404, jsonBody: { error: 'No organization or region uses that referee code.', code: 'UNKNOWN_CODE' } };
      }
      await query(
        `INSERT INTO referee (user_id, org_id) VALUES ($1, $2) ON CONFLICT ON CONSTRAINT referee_user_org_uq DO NOTHING`,
        [user.id, org.id],
      );
      return { status: 200, jsonBody: await refereeView(user.id) };
    }

    const orgId = clip(b.orgId, 40);

    if (action === 'favorite') {
      const regionId = b.regionId ? clip(b.regionId, 40) : null;
      const ok = await queryOne(
        `UPDATE referee SET favorite_region_id = $3
          WHERE user_id = $1 AND org_id = $2
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM region g WHERE g.id = $3 AND g.org_id = $2))
          RETURNING id`,
        [user.id, orgId, regionId],
      ).catch(() => null);
      if (!ok) return FORBIDDEN;
      return { status: 200, jsonBody: await refereeView(user.id) };
    }

    if (action === 'leave') {
      // Upcoming spots are freed; games already played keep who refereed them.
      await query(
        `DELETE FROM fixture_referee fr USING fixture f
          WHERE fr.fixture_id = f.id AND fr.user_id = $1 AND f.org_id = $2 AND f.date >= $3`,
        [user.id, orgId, todayIso()],
      ).catch(() => undefined);
      await query('DELETE FROM referee WHERE user_id = $1 AND org_id = $2', [user.id, orgId]).catch(() => undefined);
      return { status: 200, jsonBody: await refereeView(user.id) };
    }

    if (action === 'take' || action === 'drop') {
      const f = await loadFixture(clip(b.fixtureId, 40));
      if (!f) return { status: 404, jsonBody: { error: 'That game is no longer on the calendar.' } };
      const isRef = await queryOne('SELECT 1 FROM referee WHERE user_id = $1 AND org_id = $2', [user.id, f.org_id]);
      if (!isRef) return FORBIDDEN;
      if (f.date < todayIso()) {
        return { status: 409, jsonBody: { error: 'This game has already been played.', code: 'PAST' } };
      }

      if (action === 'drop') {
        await query('DELETE FROM fixture_referee WHERE fixture_id = $1 AND user_id = $2', [f.id, user.id]);
        return { status: 200, jsonBody: await refereeView(user.id) };
      }

      if (f.canceled) return { status: 409, jsonBody: { error: 'This game was cancelled.', code: 'CANCELED' } };
      if (!isRefereeSlot(b.slot)) return { status: 400, jsonBody: { error: 'Pick the main referee or an assistant spot.' } };
      const mine = await queryOne<{ slot: RefereeSlot }>(
        'SELECT slot FROM fixture_referee WHERE fixture_id = $1 AND user_id = $2',
        [f.id, user.id],
      );
      if (mine) {
        return {
          status: 409,
          jsonBody: { error: `You already have a spot on this game (${REFEREE_SLOT_LABELS[mine.slot]}).`, code: 'HAS_SPOT' },
        };
      }
      // First come, first served: the primary key lets only one person in.
      const taken = await queryOne(
        `INSERT INTO fixture_referee (fixture_id, slot, user_id, assigned_by) VALUES ($1, $2, $3, $3)
         ON CONFLICT DO NOTHING RETURNING slot`,
        [f.id, b.slot, user.id],
      );
      if (!taken) {
        return { status: 409, jsonBody: { error: 'Someone just took that spot. Pick another one.', code: 'TAKEN' } };
      }
      return { status: 200, jsonBody: await refereeView(user.id) };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('referee failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* -------------------------------------------------------- staff: settings */

interface ScopeOrg {
  orgId: string;
  personal: boolean;
  regionId: string | null;
  referee_code: string | null;
}

/** The organization behind an org or region scope, and whether the caller may see it. */
async function resolveScope(
  access: AccessContext,
  scope: string,
  id: string,
): Promise<{ org: ScopeOrg; canManageCode: boolean } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (scope === 'org') {
    const o = await queryOne<{ id: string; referee_code: string | null }>(
      'SELECT id, referee_code FROM organization WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    if (!o) return null;
    if (!canOnScope(access, { orgId: o.id }, 'game.create').allowed) return null;
    return {
      org: { orgId: o.id, personal: false, regionId: null, referee_code: o.referee_code },
      canManageCode: canOnScope(access, { orgId: o.id }, 'member.invite').allowed,
    };
  }
  if (scope === 'region') {
    const r = await queryOne<{ id: string; org_id: string; org_personal: boolean; referee_code: string | null }>(
      `SELECT g.id, g.org_id, o.is_personal AS org_personal, o.referee_code
         FROM region g JOIN organization o ON o.id = g.org_id
        WHERE g.id = $1 AND g.deleted_at IS NULL AND NOT g.is_personal`,
      [id],
    );
    if (!r) return null;
    if (!canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'game.create').allowed) return null;
    // Referees join the whole organization, so inside one the organization's
    // staff turn sign-up on; a standalone region does it itself.
    const canManageCode = r.org_personal
      ? canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'member.invite').allowed
      : canOnScope(access, { orgId: r.org_id }, 'member.invite').allowed;
    return {
      org: { orgId: r.org_id, personal: r.org_personal, regionId: r.id, referee_code: r.referee_code },
      canManageCode,
    };
  }
  return null;
}

async function staffView(org: ScopeOrg, canManageCode: boolean) {
  const referees = await query<{ user_id: string; name: string; email: string | null; favorite: string | null; upcoming: number }>(
    `SELECT r.user_id, COALESCE(NULLIF(u.display_name, ''), 'Referee') AS name, u.email,
            fav.name AS favorite,
            (SELECT COUNT(*) FROM fixture_referee fr JOIN fixture f ON f.id = fr.fixture_id
              WHERE fr.user_id = r.user_id AND f.org_id = r.org_id AND f.deleted_at IS NULL
                AND f.date >= $2)::int AS upcoming
       FROM referee r JOIN app_user u ON u.id = r.user_id
       LEFT JOIN region fav ON fav.id = r.favorite_region_id
      WHERE r.org_id = $1
      ORDER BY lower(COALESCE(u.display_name, u.email, ''))`,
    [org.orgId, todayIso()],
  );
  return {
    orgId: org.orgId,
    enabled: Boolean(org.referee_code),
    code: org.referee_code,
    link: org.referee_code ? `${appOrigin()}/ref/${org.referee_code}` : null,
    canManageCode,
    referees: referees.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      favoriteRegion: r.favorite,
      upcoming: r.upcoming,
    })),
  };
}

async function setCode(orgId: string, on: boolean, rotate: boolean): Promise<void> {
  if (!on) {
    await query('UPDATE organization SET referee_code = NULL WHERE id = $1', [orgId]);
    return;
  }
  const current = await queryOne<{ referee_code: string | null }>('SELECT referee_code FROM organization WHERE id = $1', [orgId]);
  if (current?.referee_code && !rotate) return;
  for (let i = 0; i < 8; i++) {
    try {
      await query('UPDATE organization SET referee_code = $2 WHERE id = $1', [orgId, newRefereeCode()]);
      return;
    } catch {
      // a clash with another organization's code: try another
    }
  }
  throw new Error('Could not create a referee code');
}

export async function refereesHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    if (req.method === 'GET') {
      const scoped = await resolveScope(access, req.query.get('scope') ?? '', req.query.get('id') ?? '');
      if (!scoped) return FORBIDDEN;
      return { status: 200, jsonBody: await staffView(scoped.org, scoped.canManageCode) };
    }

    const b = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const action = clip(b.action, 20);

    if (action === 'code' || action === 'remove') {
      const scoped = await resolveScope(access, clip(b.scope, 10), clip(b.id, 40));
      if (!scoped) return FORBIDDEN;
      if (!scoped.canManageCode) {
        return {
          status: 403,
          jsonBody: { error: "Referees are managed by the organization's admins and directors.", code: 'FORBIDDEN' },
        };
      }
      if (action === 'code') {
        await setCode(scoped.org.orgId, b.on !== false, b.rotate === true);
      } else {
        const userId = clip(b.userId, 40);
        await query(
          `DELETE FROM fixture_referee fr USING fixture f
            WHERE fr.fixture_id = f.id AND fr.user_id = $1 AND f.org_id = $2 AND f.date >= $3`,
          [userId, scoped.org.orgId, todayIso()],
        );
        const gone = await queryOne('DELETE FROM referee WHERE user_id = $1 AND org_id = $2 RETURNING id', [userId, scoped.org.orgId]);
        if (gone) {
          await notify(userId, 'Removed as a referee', 'An organizer removed you from their referees, along with your upcoming games.').catch(
            (e) => ctx.warn('referee notify failed', e),
          );
        }
      }
      const fresh = await resolveScope(access, clip(b.scope, 10), clip(b.id, 40));
      return { status: 200, jsonBody: await staffView(fresh!.org, fresh!.canManageCode) };
    }

    if (action === 'assign' || action === 'unassign') {
      const f = await loadFixture(clip(b.fixtureId, 40));
      if (!f) return { status: 404, jsonBody: { error: 'That game is no longer on the calendar.' } };
      if (!canManageFixture(access, f)) return FORBIDDEN;
      if (!isRefereeSlot(b.slot)) return { status: 400, jsonBody: { error: 'Pick the main referee or an assistant spot.' } };
      const slot = b.slot;

      const previous = await queryOne<{ user_id: string }>(
        'SELECT user_id FROM fixture_referee WHERE fixture_id = $1 AND slot = $2',
        [f.id, slot],
      );

      if (action === 'unassign') {
        await query('DELETE FROM fixture_referee WHERE fixture_id = $1 AND slot = $2', [f.id, slot]);
      } else {
        const userId = clip(b.userId, 40);
        const isRef = await queryOne('SELECT 1 FROM referee WHERE user_id = $1 AND org_id = $2', [userId, f.org_id]).catch(() => null);
        if (!isRef) {
          return { status: 400, jsonBody: { error: 'Pick one of this organization’s referees.', code: 'NOT_REFEREE' } };
        }
        if (previous?.user_id === userId) return { status: 200, jsonBody: { ok: true } };
        // Moving someone to another spot on the same game frees their old one.
        await query('DELETE FROM fixture_referee WHERE fixture_id = $1 AND (slot = $2 OR user_id = $3)', [f.id, slot, userId]);
        await query(
          'INSERT INTO fixture_referee (fixture_id, slot, user_id, assigned_by) VALUES ($1, $2, $3, $4)',
          [f.id, slot, userId, user.id],
        );
        if (userId !== user.id) {
          await notify(
            userId,
            `You're refereeing ${f.home_name} vs ${f.away_name}`,
            `You were put down as ${REFEREE_SLOT_LABELS[slot]} for ${gameLabel(f)}.`,
          ).catch((e) => ctx.warn('referee notify failed', e));
        }
      }
      if (previous && previous.user_id !== user.id && previous.user_id !== clip(b.userId, 40)) {
        await notify(
          previous.user_id,
          `Change to ${f.home_name} vs ${f.away_name}`,
          `An organizer took you off ${REFEREE_SLOT_LABELS[slot]} for ${gameLabel(f)}.`,
        ).catch((e) => ctx.warn('referee notify failed', e));
      }
      return { status: 200, jsonBody: { ok: true } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('referees failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('referee', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'referee',
  handler: refereeHandler,
});

app.http('referees', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'referees',
  handler: refereesHandler,
});
