import { query } from './db.js';

/**
 * Who sees an event (Fady, 10/17, migration 054). No audience rows means
 * everyone in the event's team, region or organization. Otherwise only the
 * chosen regions, age groups (a team's division code, like BU10), teams and
 * people. Staff who can edit the event always see it; callers check that.
 */

export type AudienceKind = 'region' | 'division' | 'team' | 'user';
export interface AudienceEntry {
  kind: AudienceKind;
  ref: string;
}

/** A team as far as audiences care: its id, region and age group. */
export interface AudienceTeam {
  id: string;
  regionId: string | null;
  division: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIVISION_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/;
export const MAX_AUDIENCE = 500;

/** Which kinds each scope may pick from. A team event can only pick people. */
export const AUDIENCE_KINDS: Record<'org' | 'region' | 'team', readonly AudienceKind[]> = {
  org: ['region', 'division', 'team', 'user'],
  region: ['division', 'team', 'user'],
  team: ['user'],
};

/**
 * Read an audience from a request: undefined leaves it unchanged, an empty
 * list means everyone.
 */
export function parseAudience(raw: unknown, scope: 'org' | 'region' | 'team'): AudienceEntry[] | undefined | { error: string } {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return { error: 'Choose who sees the event.' };
  if (raw.length > MAX_AUDIENCE) return { error: `Pick at most ${MAX_AUDIENCE} regions, age groups, teams and people.` };
  const allowed = AUDIENCE_KINDS[scope];
  const out = new Map<string, AudienceEntry>();
  for (const item of raw as Array<{ kind?: unknown; ref?: unknown }>) {
    const kind = String(item?.kind ?? '') as AudienceKind;
    const ref = String(item?.ref ?? '').trim();
    if (!allowed.includes(kind)) return { error: 'That choice is not available for this event.' };
    const ok = kind === 'division' ? DIVISION_RE.test(ref) : UUID_RE.test(ref);
    if (!ok) return { error: 'One of the choices for who sees the event is not valid.' };
    const clean = kind === 'division' ? ref : ref.toLowerCase();
    out.set(`${kind}:${clean}`, { kind, ref: clean });
  }
  return [...out.values()];
}

/** Replace an event's audience. */
export async function saveAudience(eventId: string, audience: AudienceEntry[]): Promise<void> {
  await query('DELETE FROM team_event_audience WHERE event_id = $1', [eventId]);
  if (!audience.length) return;
  await query(
    `INSERT INTO team_event_audience (event_id, kind, ref)
     SELECT $1, k, r FROM unnest($2::text[], $3::text[]) AS x(k, r)
     ON CONFLICT DO NOTHING`,
    [eventId, audience.map((a) => a.kind), audience.map((a) => a.ref)],
  );
}

export async function loadAudiences(eventIds: string[]): Promise<Map<string, AudienceEntry[]>> {
  const by = new Map<string, AudienceEntry[]>();
  if (!eventIds.length) return by;
  const rows = await query<{ event_id: string; kind: AudienceKind; ref: string }>(
    'SELECT event_id, kind, ref FROM team_event_audience WHERE event_id = ANY($1::uuid[])',
    [eventIds],
  );
  for (const r of rows) by.set(r.event_id, [...(by.get(r.event_id) ?? []), { kind: r.kind, ref: r.ref }]);
  return by;
}

/** Region and age group of each team, for matching audiences. */
export async function audienceTeams(teamIds: string[]): Promise<AudienceTeam[]> {
  if (!teamIds.length) return [];
  const rows = await query<{ id: string; region_id: string | null; division: string | null }>(
    `SELECT t.id, t.region_id, COALESCE(t.catalog_division_id, d.code) AS division
       FROM team t LEFT JOIN division d ON d.id = t.division_id
      WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL`,
    [teamIds],
  );
  return rows.map((r) => ({ id: r.id, regionId: r.region_id, division: r.division }));
}

/** Does this person, on these teams, belong to the audience? */
export function audienceMatches(audience: AudienceEntry[] | undefined, userId: string, teams: AudienceTeam[]): boolean {
  if (!audience || audience.length === 0) return true;
  return audience.some((a) => {
    if (a.kind === 'user') return a.ref === userId.toLowerCase();
    return teams.some(
      (t) =>
        (a.kind === 'team' && a.ref === t.id) ||
        (a.kind === 'region' && a.ref === t.regionId) ||
        (a.kind === 'division' && t.division !== null && a.ref.toUpperCase() === t.division.toUpperCase()),
    );
  });
}

/**
 * The same test in SQL, for notifications sent to many people at once.
 * `team` is the alias of a team row, `div` of its LEFT JOINed division row,
 * `userId` the person's id and `eventId` the event's.
 */
export function audienceSql(eventId: string, team: string, div: string, userId: string): string {
  return `(NOT EXISTS (SELECT 1 FROM team_event_audience a WHERE a.event_id = ${eventId})
    OR EXISTS (SELECT 1 FROM team_event_audience a WHERE a.event_id = ${eventId} AND (
         (a.kind = 'team' AND a.ref = ${team}.id::text)
      OR (a.kind = 'region' AND a.ref = ${team}.region_id::text)
      OR (a.kind = 'division' AND upper(a.ref) = upper(COALESCE(${team}.catalog_division_id, ${div}.code)))
      OR (a.kind = 'user' AND a.ref = ${userId}::text))))`;
}
