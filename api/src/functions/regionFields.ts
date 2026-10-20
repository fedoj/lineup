import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { canOnScope, type AccessContext } from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { buildAccessContext, loadTeamContext, reachableTeamIds } from '../lib/authz.js';
import { query, queryOne } from '../lib/db.js';

/**
 * A region's fields and field maps (Fady, 10/17, migration 052): up to 10,
 * each a name, a location and a field map image. Region staff (team.create
 * at the region, as for its teams) manage them on the region's Settings;
 * anyone in the region sees them, game forms offer them as quick picks, and a
 * game at one of them shows "Field map".
 */

export const MAX_FIELDS = 10;
const MAX_MAP_BYTES = 600 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
const FORBIDDEN: HttpResponseInit = { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };

interface RegionRef {
  id: string;
  org_id: string;
}

async function regionOf(id: string): Promise<RegionRef | undefined> {
  return queryOne<RegionRef>('SELECT id, org_id FROM region WHERE id = $1 AND deleted_at IS NULL', [id]);
}

/** May the caller see this region's fields: its staff, or anyone on one of its teams. */
async function canSeeRegion(access: AccessContext, userId: string, r: RegionRef): Promise<boolean> {
  if (canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.view').allowed) return true;
  const mine = await reachableTeamIds(userId);
  if (!mine.length) return false;
  return Boolean(
    await queryOne('SELECT 1 FROM team WHERE region_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL LIMIT 1', [r.id, mine]),
  );
}

const canManage = (access: AccessContext, r: RegionRef) =>
  canOnScope(access, { orgId: r.org_id, regionId: r.id }, 'team.create').allowed;

async function listFields(regionIds: string[]) {
  if (!regionIds.length) return [];
  const rows = await query<{ id: string; region_id: string; region_name: string; name: string; location: string; has_map: boolean; updated_at: Date }>(
    `SELECT f.id, f.region_id, r.name AS region_name, f.name, f.location, (f.map_data IS NOT NULL) AS has_map, f.updated_at
       FROM region_field f JOIN region r ON r.id = f.region_id
      WHERE f.region_id = ANY($1::uuid[]) ORDER BY r.name, f.name`,
    [regionIds],
  );
  return rows.map((f) => ({
    id: f.id,
    regionId: f.region_id,
    regionName: f.region_name,
    name: f.name,
    location: f.location,
    hasMap: f.has_map,
    version: f.updated_at.getTime().toString(36),
  }));
}

function cleanMap(raw: unknown): { mime: string; data: Buffer } | null | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = DATA_URL_RE.exec(String(raw));
  if (!m) return { error: 'The field map must be a JPEG, PNG or WebP image.' };
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_MAP_BYTES) return { error: 'The field map is too large. Try a smaller picture.' };
  return { mime: m[1], data };
}

export async function regionFieldsHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const access = await buildAccessContext(user);

    if (req.method === 'GET') {
      // The fields for a region, a team's region, or a league's region(s).
      const regionId = (req.query.get('regionId') ?? '').slice(0, 36);
      const teamId = (req.query.get('teamId') ?? '').slice(0, 36);
      const competitionId = (req.query.get('competitionId') ?? '').slice(0, 36);
      let regionIds: string[] = [];
      let manage = false;
      if (regionId) {
        const r = await regionOf(regionId);
        if (!r || !(await canSeeRegion(access, user.id, r))) return FORBIDDEN;
        regionIds = [r.id];
        manage = canManage(access, r);
      } else if (teamId) {
        const team = await loadTeamContext(teamId);
        const mine = new Set(await reachableTeamIds(user.id));
        if (!team || !(mine.has(team.teamId) || access.isPlatformAdmin)) return FORBIDDEN;
        regionIds = team.regionId ? [team.regionId] : [];
      } else if (competitionId) {
        const c = await queryOne<{ org_id: string | null; region_id: string | null }>(
          'SELECT org_id, region_id FROM competition WHERE id = $1 AND deleted_at IS NULL',
          [competitionId],
        );
        if (!c?.org_id) return { status: 200, jsonBody: { fields: [], canManage: false, max: MAX_FIELDS } };
        if (!canOnScope(access, { orgId: c.org_id, regionId: c.region_id }, 'team.view').allowed) return FORBIDDEN;
        regionIds = c.region_id
          ? [c.region_id]
          : (await query<{ id: string }>('SELECT id FROM region WHERE org_id = $1 AND deleted_at IS NULL', [c.org_id])).map((r) => r.id);
      } else {
        return { status: 400, jsonBody: { error: 'regionId, teamId or competitionId is required' } };
      }
      return { status: 200, jsonBody: { fields: await listFields(regionIds), canManage: manage, max: MAX_FIELDS } };
    }

    const b = (await req.json()) as { action?: string; regionId?: string; id?: string; name?: string; location?: string; map?: unknown };
    let region: RegionRef | undefined;
    let fieldId = '';
    if (b.action === 'add') {
      region = await regionOf(String(b.regionId ?? '').slice(0, 36));
    } else {
      fieldId = String(b.id ?? '').slice(0, 36);
      const f = await queryOne<{ region_id: string }>('SELECT region_id FROM region_field WHERE id = $1', [fieldId]);
      region = f ? await regionOf(f.region_id) : undefined;
    }
    if (!region || !canManage(access, region)) return FORBIDDEN;

    if (b.action === 'remove') {
      await query('DELETE FROM region_field WHERE id = $1', [fieldId]);
      return { status: 200, jsonBody: { fields: await listFields([region.id]) } };
    }

    const name = String(b.name ?? '').trim().slice(0, 80);
    const location = String(b.location ?? '').trim().slice(0, 160);
    if (!name || !location) return { status: 400, jsonBody: { error: 'Give the field a name and a location.' } };
    const map = cleanMap(b.map);
    if (map && 'error' in map) return { status: 400, jsonBody: { error: map.error } };

    if (b.action === 'add') {
      const n = await queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM region_field WHERE region_id = $1', [region.id]);
      if ((n?.n ?? 0) >= MAX_FIELDS) return { status: 400, jsonBody: { error: `A region can have up to ${MAX_FIELDS} fields.` } };
      await query(
        `INSERT INTO region_field (region_id, name, location, map_mime, map_data, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [region.id, name, location, map?.mime ?? null, map?.data ?? null, user.id],
      );
    } else if (b.action === 'update') {
      await query(
        `UPDATE region_field SET name = $2, location = $3,
                map_mime = COALESCE($4, map_mime), map_data = COALESCE($5, map_data), updated_at = now()
          WHERE id = $1`,
        [fieldId, name, location, map?.mime ?? null, map?.data ?? null],
      );
    } else {
      return { status: 400, jsonBody: { error: 'Unknown action' } };
    }
    return { status: 200, jsonBody: { fields: await listFields([region.id]) } };
  } catch (err) {
    ctx.error('region fields failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** A field map image, for anyone who can see the region. */
export async function fieldMapHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    const f = await queryOne<{ region_id: string; map_mime: string | null; map_data: Buffer | null }>(
      'SELECT region_id, map_mime, map_data FROM region_field WHERE id = $1',
      [(req.query.get('id') ?? '').slice(0, 36)],
    );
    const region = f ? await regionOf(f.region_id) : undefined;
    if (!f || !region || !f.map_data || !f.map_mime) return { status: 404, jsonBody: { error: 'No field map.' } };
    if (!(await canSeeRegion(await buildAccessContext(user), user.id, region))) return FORBIDDEN;
    return {
      status: 200,
      body: f.map_data,
      headers: { 'Content-Type': f.map_mime, 'Cache-Control': 'private, max-age=86400' },
    };
  } catch (err) {
    ctx.error('field map failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('regionFields', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'region-fields',
  handler: regionFieldsHandler,
});
app.http('fieldMap', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'region-fields/map',
  handler: fieldMapHandler,
});
