import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  canOnScope,
  canOnTeam,
  cleanRsvpReason,
  FLYER_MAX_BYTES,
  nameWithReason,
  sizeLabel,
  type AccessContext,
} from '@lineup/shared';
import { requireUser, type AuthedUser } from '../lib/auth.js';
import { buildAccessContext, guardTeam, reachableTeamIds, TEAM_ARCHIVED } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';
import { appToday } from '../lib/today.js';
import { enforceFeature, featureEnabled } from '../lib/entitlements.js';
import { calendarLink } from '../lib/links.js';
import {
  audienceMatches,
  audienceSql,
  audienceTeams,
  loadAudiences,
  parseAudience,
  saveAudience,
  type AudienceEntry,
} from '../lib/eventAudience.js';

/**
 * Team life outside match day: events such as a team party or picture day,
 * with an optional flyer, and the snack schedule for games.
 *
 * Coaches, assistants and team parents create and edit them (event.create,
 * event.edit, snack.edit); everyone on the team sees them. A flyer is a paid
 * extra (eventFlyers), so the event itself stays free.
 *
 * Organizations and regions have events too (a region-wide picture day, an
 * organization tournament). Their admins and directors create them, and they
 * show on the calendar of every team in that region or organization.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KINDS = ['party', 'picture_day', 'fundraiser', 'meeting', 'tournament', 'volunteer', 'tryout', 'other'] as const;
const FLYER_RE = /^data:(image\/(?:png|jpeg|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/;

const FORBIDDEN: HttpResponseInit = {
  status: 403,
  jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' },
};

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** Today as YYYY-MM-DD in the app's time zone (see lib/today.ts). */
function todayIso(): string {
  return appToday();
}

function optTime(v: unknown): string | null | 'bad' {
  const s = clip(v, 5);
  if (!s) return null;
  return TIME_RE.test(s) ? s : 'bad';
}

interface EventRow {
  id: string;
  team_id: string | null;
  region_id: string | null;
  org_id: string | null;
  scope_org_id: string | null;
  scope_name: string | null;
  kind: string;
  title: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string | null;
  flyer_mime: string | null;
  flyer_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: Date;
  max_going: number | null;
  going_total: number;
  restricted: boolean;
}

const EVENT_COLUMNS = `e.id, e.team_id, e.region_id, e.org_id,
  COALESCE(e.org_id, sr.org_id) AS scope_org_id, COALESCE(sr.name, so.name) AS scope_name,
  e.kind, e.title, to_char(e.date, 'YYYY-MM-DD') AS date,
  to_char(e.start_time, 'HH24:MI') AS start_time, to_char(e.end_time, 'HH24:MI') AS end_time,
  e.location, e.notes, e.flyer_mime, e.flyer_name, e.created_by,
  u.display_name AS created_by_name, e.updated_at, e.max_going,
  (SELECT COUNT(*)::int FROM event_checkin c WHERE c.event_id = e.id AND c.status = 'going') AS going_total,
  EXISTS (SELECT 1 FROM team_event_audience a WHERE a.event_id = e.id) AS restricted`;

const EVENT_JOINS = `FROM team_event e
  LEFT JOIN app_user u ON u.id = e.created_by
  LEFT JOIN region sr ON sr.id = e.region_id
  LEFT JOIN organization so ON so.id = e.org_id`;

function toEvent(r: EventRow, canEdit = false, audience?: AudienceEntry[]) {
  return {
    id: r.id,
    teamId: r.team_id,
    scope: r.team_id ? 'team' : r.region_id ? 'region' : 'org',
    scopeName: r.team_id ? null : r.scope_name,
    /** The team, region or organization the event belongs to. */
    scopeId: r.team_id ?? r.region_id ?? r.org_id,
    canEdit,
    kind: r.kind,
    title: r.title,
    date: r.date,
    startTime: r.start_time,
    endTime: r.end_time,
    location: r.location,
    notes: r.notes,
    flyer: r.flyer_mime
      ? {
          name: r.flyer_name ?? 'Flyer',
          mime: r.flyer_mime,
          url: `/api/team-events/flyer?id=${r.id}&v=${Math.floor(r.updated_at.getTime() / 1000)}`,
        }
      : null,
    createdBy: r.created_by_name && !r.created_by_name.includes('@') ? r.created_by_name : null,
    // How many may go (across every team), and how many said they're going.
    maxGoing: r.max_going,
    goingTotal: r.going_total,
    full: r.max_going !== null && r.going_total >= r.max_going,
    // Shown only to chosen regions, age groups, teams or people.
    restricted: r.restricted,
    // Who it is for, for the people who edit it.
    ...(canEdit ? { audience: audience ?? [] } : {}),
  };
}

async function loadEvent(id: string): Promise<EventRow | undefined> {
  return queryOne<EventRow>(
    `SELECT ${EVENT_COLUMNS} ${EVENT_JOINS}
      WHERE e.id = $1 AND e.deleted_at IS NULL`,
    [id],
  );
}

/** May the caller act on this event? Team events follow the team's roles; region and organization events follow that scope's staff. */
async function eventAllowed(
  user: AuthedUser,
  ctx: AccessContext,
  ev: EventRow,
  action: 'event.view' | 'event.edit',
): Promise<boolean> {
  const allowed = await eventAllowedByRole(user, ctx, ev, action);
  if (!allowed || action !== 'event.view' || !ev.restricted) return allowed;
  // Shown only to some: its editors, and the people and teams it is for.
  if (await eventAllowedByRole(user, ctx, ev, 'event.edit')) return true;
  const [audience, teams] = await Promise.all([loadAudiences([ev.id]), reachableTeamIds(user.id).then(audienceTeams)]);
  return audienceMatches(audience.get(ev.id), user.id, teams);
}

async function eventAllowedByRole(
  user: AuthedUser,
  ctx: AccessContext,
  ev: EventRow,
  action: 'event.view' | 'event.edit',
): Promise<boolean> {
  if (ev.team_id) {
    const guard = await guardTeam(user, ev.team_id, action);
    return guard.ok;
  }
  const scope = { orgId: ev.scope_org_id ?? '', regionId: ev.region_id };
  if (canOnScope(ctx, scope, action).allowed) return true;
  if (action !== 'event.view') return false;
  // Anyone on a team in the region or organization sees its events.
  const reachable = await reachableTeamIds(user.id);
  const hit = await queryOne(
    `SELECT 1 FROM team WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        AND (($2::uuid IS NOT NULL AND region_id = $2) OR ($2::uuid IS NULL AND org_id = $3))`,
    [reachable, ev.region_id, ev.scope_org_id],
  );
  return Boolean(hit);
}

/** A region or organization the caller is asking about, if it is a real one. */
async function loadScope(kind: string, id: string): Promise<{ kind: 'region' | 'org'; id: string; orgId: string; name: string } | null> {
  if (kind === 'region') {
    const r = await queryOne<{ id: string; org_id: string; name: string }>(
      'SELECT id, org_id, name FROM region WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    return r ? { kind: 'region', id: r.id, orgId: r.org_id, name: r.name } : null;
  }
  if (kind === 'org') {
    const o = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM organization WHERE id = $1 AND deleted_at IS NULL AND NOT is_personal',
      [id],
    );
    return o ? { kind: 'org', id: o.id, orgId: o.id, name: o.name } : null;
  }
  return null;
}

/** Parse an optional flyer upload. undefined = untouched, null = remove. */
function parseFlyer(raw: unknown): { mime: string; bytes: Buffer; name: string } | null | undefined | string {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const f = raw as { dataUrl?: string; name?: string };
  const m = FLYER_RE.exec(String(f.dataUrl ?? ''));
  if (!m) return 'Attach a PNG, JPEG, WebP or PDF flyer.';
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0 || bytes.length > FLYER_MAX_BYTES) return `A flyer must be under ${sizeLabel(FLYER_MAX_BYTES)}.`;
  return { mime: m[1], bytes, name: clip(f.name, 120) || 'Flyer' };
}

interface EventBody {
  id?: string;
  teamId?: string;
  kind?: string;
  title?: string;
  date?: string;
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  notes?: string | null;
  flyer?: { dataUrl: string; name?: string } | null;
  /** Who sees it: omitted leaves it unchanged, an empty list means everyone. */
  audience?: Array<{ kind: string; ref: string }> | null;
  /** How many may say they're going; null for no limit. */
  maxGoing?: number | null;
}

function validateFields(b: EventBody): { error: string } | {
  kind: string; title: string; date: string; start: string | null; end: string | null;
  location: string | null; notes: string | null; maxGoing: number | null;
} {
  const title = clip(b.title, 120);
  if (!title) return { error: 'Give the event a name, for example "Team party".' };
  const date = clip(b.date, 10);
  if (!DATE_RE.test(date)) return { error: 'Pick a date for the event.' };
  const kind = (KINDS as readonly string[]).includes(String(b.kind)) ? String(b.kind) : 'other';
  const start = optTime(b.startTime);
  const end = optTime(b.endTime);
  if (start === 'bad' || end === 'bad') return { error: 'Times must look like 10:30.' };
  if (start && end && end < start) return { error: 'The event ends before it starts.' };
  let maxGoing: number | null = null;
  if (b.maxGoing !== undefined && b.maxGoing !== null && String(b.maxGoing).trim() !== '') {
    maxGoing = Math.round(Number(b.maxGoing));
    if (!(maxGoing >= 1 && maxGoing <= 10000)) return { error: 'The most people going must be between 1 and 10,000.' };
  }
  return {
    kind, title, date, start, end,
    location: clip(b.location, 160) || null,
    notes: clip(b.notes, 2000) || null,
    maxGoing,
  };
}

/** Tell the rest of the team a new event is on the calendar, linking to it. */
async function announce(teamId: string, actorId: string, title: string, date: string, eventId: string): Promise<void> {
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT DISTINCT m.user_id, 'message', $3, $4, $5
       FROM membership m
       JOIN team t ON t.id = m.team_id
       LEFT JOIN division d ON d.id = t.division_id
      WHERE m.team_id = $1 AND m.user_id <> $2
        AND ${audienceSql('$6::uuid', 't', 'd', 'm.user_id')}`,
    [teamId, actorId, `New team event: ${title}`, `${title} is on the team calendar for ${date}.`, calendarLink(teamId, `event:${eventId}`), eventId],
  );
}

/**
 * Tell everyone on the region's or organization's teams about a new event.
 * Each person's link opens it on one of their own teams' Calendar. An event
 * for chosen regions, age groups, teams or people reaches only them.
 */
async function announceScope(
  scope: { kind: 'region' | 'org'; id: string; name: string },
  actorId: string,
  title: string,
  date: string,
  eventId: string,
): Promise<void> {
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT DISTINCT ON (m.user_id) m.user_id, 'message', $3, $4,
            '/calendar?team=' || t.id || '&focus=event:' || $6
       FROM membership m JOIN team t ON t.id = m.team_id
       LEFT JOIN division d ON d.id = t.division_id
      WHERE t.deleted_at IS NULL AND m.user_id <> $2
        AND (CASE WHEN $5 = 'region' THEN t.region_id = $1 ELSE t.org_id = $1 END)
        AND ${audienceSql('$7::uuid', 't', 'd', 'm.user_id')}`,
    [scope.id, actorId, `New ${scope.kind === 'region' ? 'region' : 'organization'} event: ${title}`,
      `${scope.name}: ${title} is on your team calendar for ${date}.`, scope.kind, eventId, eventId],
  );
}

export async function teamEventsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    // Events of a region or organization: its own, plus the organization's
    // events for a region, plus its regions' events for an organization.
    if (req.method === 'GET' && req.query.get('scope')) {
      const scope = await loadScope(req.query.get('scope') ?? '', req.query.get('id') ?? '');
      if (!scope) return FORBIDDEN;
      const access = await buildAccessContext(user);
      const at = { orgId: scope.orgId, regionId: scope.kind === 'region' ? scope.id : null };
      let allowed = canOnScope(access, at, 'team.view').allowed;
      if (!allowed) {
        const reachable = await reachableTeamIds(user.id);
        allowed = Boolean(
          await queryOne(
            `SELECT 1 FROM team WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
                AND (CASE WHEN $3 = 'region' THEN region_id = $2 ELSE org_id = $2 END)`,
            [reachable, scope.id, scope.kind],
          ),
        );
      }
      if (!allowed) return FORBIDDEN;
      const events = await query<EventRow>(
        `SELECT ${EVENT_COLUMNS} ${EVENT_JOINS}
          WHERE e.deleted_at IS NULL AND e.team_id IS NULL
            AND (CASE WHEN $2 = 'region'
                      THEN e.region_id = $1 OR e.org_id = $3
                      ELSE e.org_id = $1 OR e.region_id IN (SELECT id FROM region WHERE org_id = $1) END)
          ORDER BY e.date, e.start_time NULLS FIRST, e.created_at`,
        [scope.id, scope.kind, scope.orgId],
      );
      const editable = (e: EventRow) =>
        canOnScope(access, { orgId: e.scope_org_id ?? '', regionId: e.region_id }, 'event.edit').allowed;
      const audiences = await loadAudiences(events.filter((e) => e.restricted).map((e) => e.id));
      // Events for chosen regions, age groups, teams or people: only those, and their editors.
      const myTeams = events.some((e) => e.restricted && !editable(e))
        ? await audienceTeams(await reachableTeamIds(user.id))
        : [];
      return {
        status: 200,
        jsonBody: {
          events: events
            .filter((e) => !e.restricted || editable(e) || audienceMatches(audiences.get(e.id), user.id, myTeams))
            .map((e) => toEvent(e, editable(e), audiences.get(e.id))),
          snacks: [],
          canEditEvents: canOnScope(access, at, 'event.create').allowed,
          canEditSnacks: false,
          canSeeSnacks: false,
          flyers: await featureEnabled(user.id, 'eventFlyers'),
        },
      };
    }

    if (req.method === 'GET') {
      const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'event.view');
      if (!guard.ok) return guard.response;
      const teamId = guard.team.teamId;
      const canSnacksView = canOnTeam(guard.ctx, guard.team, 'snack.view').allowed;
      const canEditTeam = canOnTeam(guard.ctx, guard.team, 'event.edit').allowed;

      const [allEvents, snacks, flyers, players] = await Promise.all([
        // The team's own events plus those of its region and organization.
        query<EventRow>(
          `SELECT ${EVENT_COLUMNS} ${EVENT_JOINS}
            WHERE e.deleted_at IS NULL
              AND (e.team_id = $1 OR ($2::uuid IS NOT NULL AND e.region_id = $2) OR e.org_id = $3)
            ORDER BY e.date, e.start_time NULLS FIRST, e.created_at`,
          [teamId, guard.team.regionId ?? null, guard.team.orgId],
        ),
        canSnacksView
          ? query<{
              game_id: string; game_no: number; date: string | null; opponent: string; is_home: boolean;
              kickoff: string | null; player_id: string | null; player_name: string | null;
              family: string | null; notes: string | null;
            }>(
              `SELECT g.id AS game_id, g.game_no, to_char(g.date, 'YYYY-MM-DD') AS date, g.opponent, g.is_home,
                      COALESCE(f.kickoff, g.kickoff) AS kickoff,
                      s.player_id, p.name AS player_name, s.family, s.notes
                 FROM game g
                 LEFT JOIN fixture f ON f.id = g.fixture_id AND f.deleted_at IS NULL
                 LEFT JOIN snack_slot s ON s.game_id = g.id
                 LEFT JOIN player p ON p.id = s.player_id
                WHERE g.team_id = $1 AND g.deleted_at IS NULL
                ORDER BY g.date NULLS LAST, g.game_no`,
              [teamId],
            )
          : Promise.resolve([]),
        featureEnabled(user.id, 'eventFlyers'),
        query<{ id: string; name: string }>('SELECT id, name FROM player WHERE team_id = $1 AND active ORDER BY name', [
          teamId,
        ]),
      ]);

      const editable = (e: EventRow) =>
        e.team_id
          ? canEditTeam
          : canOnScope(guard.ctx, { orgId: e.scope_org_id ?? '', regionId: e.region_id }, 'event.edit').allowed;
      // Events for chosen regions, age groups, teams or people show on this
      // team's calendar only when the team, or the person looking, is one of them.
      const audiences = await loadAudiences(allEvents.filter((e) => e.restricted).map((e) => e.id));
      const thisTeam = audiences.size ? await audienceTeams([teamId]) : [];
      const events = allEvents.filter(
        (e) => !e.restricted || editable(e) || audienceMatches(audiences.get(e.id), user.id, thisTeam),
      );

      // Check-ins for upcoming events: a parent's own children, team totals
      // for everyone, and names for the people who run the team and its events.
      const seeNames =
        canEditTeam || canOnTeam(guard.ctx, guard.team, 'lineup.edit').allowed;
      const upcomingIds = events.filter((e) => e.date >= todayIso()).map((e) => e.id);
      const answers = upcomingIds.length && players.length
        ? await query<{ event_id: string; player_id: string; status: string; reason: string | null; note: string | null }>(
            `SELECT event_id, player_id, status, reason, note FROM event_checkin
              WHERE event_id = ANY($1::uuid[]) AND player_id = ANY($2::uuid[])`,
            [upcomingIds, players.map((p) => p.id)],
          )
        : [];
      const mine = new Set(guard.ctx.guardianOf ?? []);
      const children = players.filter((p) => mine.has(p.id));
      const checkinFor = (eventId: string) => {
        if (!upcomingIds.includes(eventId)) return null;
        const answerOf = (playerId: string) =>
          answers.find((a) => a.event_id === eventId && a.player_id === playerId) ?? null;
        const statusOf = (playerId: string) => answerOf(playerId)?.status ?? null;
        const whyOf = (playerId: string) => {
          const a = answerOf(playerId);
          return { reason: a?.reason ?? null, note: a?.reason === 'other' ? a.note : null };
        };
        const going = players.filter((p) => statusOf(p.id) === 'going');
        const notGoing = players.filter((p) => statusOf(p.id) === 'not_going');
        const noAnswer = players.filter((p) => statusOf(p.id) === null);
        return {
          children: children.map((c) => ({ playerId: c.id, name: c.name, status: statusOf(c.id), ...whyOf(c.id) })),
          counts: { going: going.length, notGoing: notGoing.length, noAnswer: noAnswer.length },
          summary: seeNames
            ? {
                going: going.map((p) => p.name),
                notGoing: notGoing.map((p) => nameWithReason(p.name, whyOf(p.id).reason, whyOf(p.id).note)),
                noAnswer: noAnswer.map((p) => p.name),
              }
            : null,
        };
      };
      return {
        status: 200,
        jsonBody: {
          events: events.map((e) => ({
            ...toEvent(e, editable(e), audiences.get(e.id)),
            checkin: checkinFor(e.id),
          })),
          snacks: snacks.map((s) => ({
            gameId: s.game_id,
            gameNo: s.game_no,
            date: s.date,
            kickoff: s.kickoff,
            opponent: s.opponent,
            isHome: s.is_home,
            playerId: s.player_id,
            playerName: s.player_name,
            family: s.family,
            notes: s.notes,
          })),
          canEditEvents: canOnTeam(guard.ctx, guard.team, 'event.create').allowed,
          canEditSnacks: canOnTeam(guard.ctx, guard.team, 'snack.edit').allowed,
          canSeeSnacks: canSnacksView,
          flyers,
        },
      };
    }

    if (req.method === 'DELETE') {
      const ev = await loadEvent(req.query.get('id') ?? '');
      if (!ev) return FORBIDDEN;
      if (!(await eventAllowed(user, await buildAccessContext(user), ev, 'event.edit'))) return FORBIDDEN;
      await query('UPDATE team_event SET deleted_at = now(), flyer_data = NULL WHERE id = $1', [ev.id]);
      return { status: 204 };
    }

    const b = (await req.json()) as EventBody & { scope?: string; scopeId?: string };

    // A region-wide or organization-wide event, by that scope's staff.
    if (req.method === 'POST' && b.scope) {
      const scope = await loadScope(String(b.scope), clip(b.scopeId, 36));
      if (!scope) return FORBIDDEN;
      const access = await buildAccessContext(user);
      const decision = canOnScope(
        access,
        { orgId: scope.orgId, regionId: scope.kind === 'region' ? scope.id : null },
        'event.create',
      );
      if (!decision.allowed) return FORBIDDEN;
      const fields = validateFields(b);
      if ('error' in fields) return { status: 400, jsonBody: { error: fields.error } };
      const audience = parseAudience(b.audience, scope.kind);
      if (audience && 'error' in audience) return { status: 400, jsonBody: { error: audience.error } };
      const flyer = parseFlyer(b.flyer ?? undefined);
      if (typeof flyer === 'string') return { status: 400, jsonBody: { error: flyer } };
      if (flyer) {
        const denied = await enforceFeature(user.id, 'eventFlyers');
        if (denied) return { status: denied.status, jsonBody: denied.body };
      }
      const row = await queryOne<{ id: string }>(
        `INSERT INTO team_event (region_id, org_id, kind, title, date, start_time, end_time, location, notes,
                                 flyer_mime, flyer_name, flyer_data, created_by, max_going)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          scope.kind === 'region' ? scope.id : null, scope.kind === 'org' ? scope.id : null,
          fields.kind, fields.title, fields.date, fields.start, fields.end, fields.location, fields.notes,
          flyer?.mime ?? null, flyer?.name ?? null, flyer?.bytes ?? null, user.id, fields.maxGoing,
        ],
      );
      // Saved before the announcement, so only the people it is for hear about it.
      if (audience?.length) await saveAudience(row!.id, audience);
      await announceScope(scope, user.id, fields.title, fields.date, row!.id).catch((e) =>
        ctx.warn('scope event announce failed', e),
      );
      return { status: 201, jsonBody: toEvent((await loadEvent(row!.id))!, true, audience ?? []) };
    }

    if (req.method === 'POST') {
      const guard = await guardTeam(user, b.teamId, 'event.create');
      if (!guard.ok) return guard.response;
      const fields = validateFields(b);
      if ('error' in fields) return { status: 400, jsonBody: { error: fields.error } };
      const audience = parseAudience(b.audience, 'team');
      if (audience && 'error' in audience) return { status: 400, jsonBody: { error: audience.error } };
      const flyer = parseFlyer(b.flyer ?? undefined);
      if (typeof flyer === 'string') return { status: 400, jsonBody: { error: flyer } };
      if (flyer) {
        const denied = await enforceFeature(user.id, 'eventFlyers');
        if (denied) return { status: denied.status, jsonBody: denied.body };
      }
      const row = await queryOne<{ id: string }>(
        `INSERT INTO team_event (team_id, kind, title, date, start_time, end_time, location, notes,
                                 flyer_mime, flyer_name, flyer_data, created_by, max_going)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          guard.team.teamId, fields.kind, fields.title, fields.date, fields.start, fields.end,
          fields.location, fields.notes,
          flyer?.mime ?? null, flyer?.name ?? null, flyer?.bytes ?? null, user.id, fields.maxGoing,
        ],
      );
      if (audience?.length) await saveAudience(row!.id, audience);
      await announce(guard.team.teamId, user.id, fields.title, fields.date, row!.id).catch((e) =>
        ctx.warn('event announce failed', e),
      );
      const created = await loadEvent(row!.id);
      return { status: 201, jsonBody: toEvent(created!, true, audience ?? []) };
    }

    if (req.method === 'PATCH') {
      const ev = await loadEvent(clip(b.id, 36));
      if (!ev) return FORBIDDEN;
      if (!(await eventAllowed(user, await buildAccessContext(user), ev, 'event.edit'))) return FORBIDDEN;
      const fields = validateFields({ ...b, kind: b.kind ?? ev.kind });
      if ('error' in fields) return { status: 400, jsonBody: { error: fields.error } };
      const audience = parseAudience(b.audience, ev.team_id ? 'team' : ev.region_id ? 'region' : 'org');
      if (audience && 'error' in audience) return { status: 400, jsonBody: { error: audience.error } };
      const flyer = parseFlyer(b.flyer);
      if (typeof flyer === 'string') return { status: 400, jsonBody: { error: flyer } };
      if (flyer) {
        const denied = await enforceFeature(user.id, 'eventFlyers');
        if (denied) return { status: denied.status, jsonBody: denied.body };
      }
      await query(
        `UPDATE team_event SET kind = $2, title = $3, date = $4, start_time = $5, end_time = $6,
                location = $7, notes = $8, updated_at = now(),
                max_going = CASE WHEN $9 THEN $10::int ELSE max_going END
          WHERE id = $1`,
        [ev.id, fields.kind, fields.title, fields.date, fields.start, fields.end, fields.location, fields.notes,
          b.maxGoing !== undefined, fields.maxGoing],
      );
      if (audience) await saveAudience(ev.id, audience);
      // A new date means new reminders.
      if (fields.date !== ev.date) {
        await query('DELETE FROM event_reminder WHERE event_id = $1', [ev.id]);
      }
      if (flyer !== undefined) {
        await query(
          'UPDATE team_event SET flyer_mime = $2, flyer_name = $3, flyer_data = $4, updated_at = now() WHERE id = $1',
          [ev.id, flyer?.mime ?? null, flyer?.name ?? null, flyer?.bytes ?? null],
        );
      }
      return {
        status: 200,
        jsonBody: toEvent((await loadEvent(ev.id))!, true, audience ?? (await loadAudiences([ev.id])).get(ev.id)),
      };
    }

    return { status: 405 };
  } catch (err) {
    ctx.error('team events failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** The flyer file itself, for anyone who can see the event. */
export async function eventFlyerHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const id = req.query.get('id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, jsonBody: { error: 'id is required' } };
    const row = await queryOne<{ flyer_mime: string | null; flyer_name: string | null; flyer_data: Buffer | null }>(
      'SELECT flyer_mime, flyer_name, flyer_data FROM team_event WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    const ev = row ? await loadEvent(id) : undefined;
    if (!row || !ev) return FORBIDDEN;
    if (!(await eventAllowed(user, await buildAccessContext(user), ev, 'event.view'))) return FORBIDDEN;
    if (!row.flyer_data || !row.flyer_mime) return { status: 404 };
    const safeName = (row.flyer_name ?? 'flyer').replace(/[^\w .()-]/g, '_');
    return {
      status: 200,
      body: new Uint8Array(row.flyer_data),
      headers: {
        'Content-Type': row.flyer_mime,
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    };
  } catch (err) {
    ctx.error('event flyer failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Assign (or clear) the family bringing snacks to one game. */
export async function snacksHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const b = (await req.json()) as { gameId?: string; playerId?: string | null; family?: string | null; notes?: string | null };
    const game = await queryOne<{ id: string; team_id: string }>(
      'SELECT id, team_id FROM game WHERE id = $1 AND deleted_at IS NULL',
      [clip(b.gameId, 36)],
    );
    if (!game) return FORBIDDEN;
    const guard = await guardTeam(user, game.team_id, 'snack.edit');
    if (!guard.ok) return guard.response;

    let playerId: string | null = clip(b.playerId, 36) || null;
    if (playerId) {
      const p = await queryOne<{ id: string }>('SELECT id FROM player WHERE id = $1 AND team_id = $2', [playerId, game.team_id]);
      if (!p) playerId = null;
    }
    const family = clip(b.family, 80) || null;
    const notes = clip(b.notes, 200) || null;

    if (!playerId && !family && !notes) {
      await query('DELETE FROM snack_slot WHERE game_id = $1', [game.id]);
      return { status: 204 };
    }
    await query(
      `INSERT INTO snack_slot (team_id, game_id, player_id, family, notes, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (game_id) DO UPDATE SET
         player_id = EXCLUDED.player_id, family = EXCLUDED.family, notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [game.team_id, game.id, playerId, family, notes, user.id],
    );
    // The family on snacks hears about it, with a link to the snack schedule.
    if (playerId) {
      const g = await queryOne<{ date: string | null; opponent: string }>(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, opponent FROM game WHERE id = $1`,
        [game.id],
      );
      await query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT pg.user_id, 'message', $3, $4, $5
           FROM player_guardian pg
           JOIN membership m ON m.user_id = pg.user_id AND m.team_id = $2
          WHERE pg.player_id = $1 AND pg.user_id <> $6`,
        [
          playerId,
          game.team_id,
          'You are on snacks',
          `Your family is bringing snacks to the game${g?.opponent ? ` against ${g.opponent}` : ''}${g?.date ? ` on ${g.date}` : ''}.`,
          calendarLink(game.team_id, 'snacks'),
          user.id,
        ],
      ).catch((e) => ctx.warn('snack notify failed', e));
    }
    return { status: 204 };
  } catch (err) {
    ctx.error('snacks failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * A parent says whether their child is going to an event on their team's
 * calendar (the team's own, or its region's or organization's). Staff who
 * run the team or its events may answer for any player.
 */
export async function eventCheckinHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const b = (await req.json()) as { eventId?: string; teamId?: string; playerId?: string; status?: string; reason?: string; note?: string };
    const status = b.status === 'going' || b.status === 'not_going' ? b.status : null;
    if (!status) return { status: 400, jsonBody: { error: 'Choose going or not going.' } };
    // Not going: sick, injured or other (with an optional comment).
    const why = status === 'not_going' ? cleanRsvpReason(b.reason, b.note) : { reason: null, note: null };

    const guard = await guardTeam(user, clip(b.teamId, 36) || undefined, 'event.view');
    if (!guard.ok) return guard.response;
    if (guard.team.archived) return TEAM_ARCHIVED;
    const ev = await queryOne<{ id: string; closed: boolean; max_going: number | null; restricted: boolean; team_id: string | null; region_id: string | null; scope_org_id: string | null }>(
      `SELECT e.id, (e.date < $5::date) AS closed, e.max_going, e.team_id, e.region_id,
              COALESCE(e.org_id, (SELECT org_id FROM region WHERE id = e.region_id)) AS scope_org_id,
              EXISTS (SELECT 1 FROM team_event_audience a WHERE a.event_id = e.id) AS restricted
         FROM team_event e
        WHERE e.id = $1 AND e.deleted_at IS NULL
          AND (e.team_id = $2 OR ($3::uuid IS NOT NULL AND e.region_id = $3) OR e.org_id = $4)`,
      [clip(b.eventId, 36), guard.team.teamId, guard.team.regionId ?? null, guard.team.orgId, todayIso()],
    );
    if (!ev) return FORBIDDEN;
    if (ev.closed) return { status: 409, jsonBody: { error: 'This event has already happened.', code: 'CHECKIN_CLOSED' } };

    const playerId = clip(b.playerId, 36);
    const player = await queryOne<{ id: string }>(
      'SELECT id FROM player WHERE id = $1 AND team_id = $2 AND active',
      [playerId, guard.team.teamId],
    );
    const isGuardian = (guard.ctx.guardianOf ?? []).includes(playerId);
    const staff =
      canOnTeam(guard.ctx, guard.team, 'event.edit').allowed || canOnTeam(guard.ctx, guard.team, 'lineup.edit').allowed;
    if (!player || (!isGuardian && !staff)) return FORBIDDEN;

    // An event for chosen teams or people: only they answer (and its editors).
    if (ev.restricted) {
      const editor = ev.team_id
        ? canOnTeam(guard.ctx, guard.team, 'event.edit').allowed
        : canOnScope(guard.ctx, { orgId: ev.scope_org_id ?? '', regionId: ev.region_id }, 'event.edit').allowed;
      const [audience, thisTeam] = await Promise.all([loadAudiences([ev.id]), audienceTeams([guard.team.teamId])]);
      if (!editor && !audienceMatches(audience.get(ev.id), user.id, thisTeam)) return FORBIDDEN;
    }

    // A limit on how many go, across every team: a full event takes no more.
    if (status === 'going' && ev.max_going !== null) {
      const n = await queryOne<{ going: number; mine: boolean }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'going')::int AS going,
                bool_or(player_id = $2 AND status = 'going') AS mine
           FROM event_checkin WHERE event_id = $1`,
        [ev.id, playerId],
      );
      if (!n?.mine && (n?.going ?? 0) >= ev.max_going) {
        return {
          status: 409,
          jsonBody: { error: `This event is full: ${ev.max_going} of ${ev.max_going} places are taken.`, code: 'EVENT_FULL' },
        };
      }
    }

    await query(
      `INSERT INTO event_checkin (event_id, player_id, status, reason, note, responded_by, responded_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (event_id, player_id)
       DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, note = EXCLUDED.note,
                     responded_by = EXCLUDED.responded_by, responded_at = now()`,
      [ev.id, playerId, status, why.reason, why.note, user.id],
    );
    return { status: 200, jsonBody: { eventId: ev.id, playerId, status, reason: why.reason } };
  } catch (err) {
    ctx.error('event checkin failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * What an event can be limited to, for the people who create events here:
 * the organization's regions, the age groups and teams in scope, and the
 * people on those teams (Fady, 10/17).
 */
export async function eventAudienceOptionsHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const kind = clip(req.query.get('scope'), 10);
    const id = clip(req.query.get('id'), 36);
    let teamIds: string[] = [];
    let regions: Array<{ id: string; name: string }> = [];
    if (kind === 'team') {
      const guard = await guardTeam(user, id, 'event.create');
      if (!guard.ok) return guard.response;
      teamIds = [guard.team.teamId];
    } else {
      const scope = await loadScope(kind, id);
      if (!scope) return FORBIDDEN;
      const access = await buildAccessContext(user);
      const at = { orgId: scope.orgId, regionId: scope.kind === 'region' ? scope.id : null };
      if (!canOnScope(access, at, 'event.create').allowed) return FORBIDDEN;
      if (scope.kind === 'org') {
        regions = await query<{ id: string; name: string }>(
          'SELECT id, name FROM region WHERE org_id = $1 AND deleted_at IS NULL AND NOT is_personal ORDER BY name',
          [scope.id],
        );
      }
      teamIds = (
        await query<{ id: string }>(
          `SELECT id FROM team
            WHERE deleted_at IS NULL AND archived_at IS NULL
              AND (CASE WHEN $2 = 'region' THEN region_id = $1 ELSE org_id = $1 END)`,
          [scope.id, scope.kind],
        )
      ).map((r) => r.id);
    }

    const teams = teamIds.length
      ? await query<{ id: string; name: string; region_name: string | null; division: string | null; division_label: string | null; sort: number }>(
          `SELECT t.id, t.name, r.name AS region_name, COALESCE(t.catalog_division_id, d.code) AS division,
                  COALESCE(c.label, d.name, d.code) AS division_label, COALESCE(c.sort_order, 999) AS sort
             FROM team t
             LEFT JOIN region r ON r.id = t.region_id AND NOT r.is_personal
             LEFT JOIN division d ON d.id = t.division_id
             LEFT JOIN division_catalog c ON c.id = t.catalog_division_id
            WHERE t.id = ANY($1::uuid[])
            ORDER BY r.name NULLS FIRST, t.name`,
          [teamIds],
        )
      : [];
    const divisions = new Map<string, { code: string; label: string; sort: number }>();
    for (const t of teams) {
      if (t.division && !divisions.has(t.division.toUpperCase())) {
        divisions.set(t.division.toUpperCase(), { code: t.division, label: t.division_label ?? t.division, sort: t.sort });
      }
    }
    const people = teamIds.length
      ? await query<{ id: string; name: string | null; email: string | null; teams: string[] }>(
          `SELECT u.id, u.display_name AS name, u.email, array_agg(DISTINCT t.name) AS teams
             FROM membership m
             JOIN app_user u ON u.id = m.user_id
             JOIN team t ON t.id = m.team_id
            WHERE m.team_id = ANY($1::uuid[]) AND u.deleted_at IS NULL AND u.deactivated_at IS NULL
            GROUP BY u.id, u.display_name, u.email
            ORDER BY lower(COALESCE(u.display_name, u.email, '')) LIMIT 2000`,
          [teamIds],
        )
      : [];

    return {
      status: 200,
      jsonBody: {
        regions,
        divisions: [...divisions.values()]
          .sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code))
          .map(({ code, label }) => ({ code, label })),
        teams: kind === 'team' ? [] : teams.map((t) => ({ id: t.id, name: t.name, regionName: t.region_name, division: t.division })),
        people: people.map((p) => ({
          id: p.id,
          name: p.name && !p.name.includes('@') ? p.name : null,
          email: p.email,
          teams: [...p.teams].sort().slice(0, 3),
        })),
      },
    };
  } catch (err) {
    ctx.error('event audience options failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('teamEvents', {
  methods: ['GET', 'POST', 'PATCH', 'DELETE'], authLevel: 'anonymous', route: 'team-events',
  handler: teamEventsHandler,
});
app.http('teamEventCheckin', {
  methods: ['POST'], authLevel: 'anonymous', route: 'team-events/checkin', handler: eventCheckinHandler,
});
app.http('teamEventAudience', {
  methods: ['GET'], authLevel: 'anonymous', route: 'team-events/audience', handler: eventAudienceOptionsHandler,
});
app.http('teamEventFlyer', {
  methods: ['GET'], authLevel: 'anonymous', route: 'team-events/flyer', handler: eventFlyerHandler,
});
app.http('snacks', {
  methods: ['POST'], authLevel: 'anonymous', route: 'snacks', handler: snacksHandler,
});
