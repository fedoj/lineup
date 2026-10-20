/**
 * Role and tier impersonation, for testing what each plan and role can see.
 *
 * Access is an explicit ALLOWLIST of people, not a shared code. A code can be
 * forwarded, screenshotted or leaked; an allowlist cannot be handed to someone
 * else. The list lives in configuration (sourced from Key Vault), never in
 * source, and an empty list disables the feature outright.
 *
 * Entries may be either an Entra object id (the stable `sub` in the token) or
 * an email address. Email is matched only when the token actually carries one
 * — the CIAM tenant currently does not emit an email claim, so object ids are
 * the reliable form and what the setup script writes.
 *
 * Other rules that keep this from becoming a backdoor:
 *   1. Always expires, so a forgotten session cannot persist.
 *   2. Scope-preserving: it swaps the ROLE on memberships the caller already
 *      has, never granting one, so it cannot reach another coach's data.
 *   3. Never confers platform admin.
 *   4. Every start, stop and refusal is written to impersonation_log.
 */
import { createHash } from 'node:crypto';
import type { HttpRequest } from '@azure/functions';
import {
  ROLE_RANK,
  normalizeTier,
  TIER_ORDER,
  type Role,
  type TierId,
} from '@lineup/shared';
import { query, queryOne } from './db.js';
import { memo } from './requestScope.js';
import type { AuthedUser } from './auth.js';

/** How long an impersonation session lasts before it lapses on its own. */
const SESSION_HOURS = 8;

export interface ImpersonationState {
  role: Role | null;
  tier: TierId | null;
  until: string | null;
  active: boolean;
}

function allowlist(): string[] {
  return (process.env.IMPERSONATION_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when anyone at all may impersonate in this environment. */
export function impersonationEnabled(): boolean {
  return allowlist().length > 0;
}

/**
 * May this specific caller impersonate?
 *
 * Checked on every request rather than cached, so removing someone from the
 * list takes effect at the next deploy without needing them to sign out.
 */
export function mayImpersonate(user: AuthedUser): boolean {
  const list = allowlist();
  if (list.length === 0) return false;

  const subject = user.subject?.toLowerCase();
  const email = user.email?.toLowerCase();

  return list.some((entry) => entry === subject || (Boolean(email) && entry === email));
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && v in ROLE_RANK;
}

export function isTier(v: unknown): v is TierId {
  return typeof v === 'string' && (TIER_ORDER as readonly string[]).includes(v);
}

/** Current override for a user, or an inactive state once it has lapsed. */
export function getImpersonation(userId: string): Promise<ImpersonationState> {
  return memo(`imp:${userId}`, async () =>
    impersonationFromRow(
      await queryOne<ImpersonationRow>(
        `SELECT impersonate_role, impersonate_tier, impersonate_until
           FROM app_user WHERE id = $1`,
        [userId],
      ),
    ),
  );
}

interface ImpersonationRow {
  impersonate_role: string | null;
  impersonate_tier: string | null;
  impersonate_until: Date | null;
}

/** The override held in an app_user row. */
export function impersonationFromRow(row: ImpersonationRow | undefined | null): ImpersonationState {
  const until = row?.impersonate_until ?? null;
  const live = Boolean(until && until.getTime() > Date.now());

  return {
    role: live ? ((row?.impersonate_role as Role) ?? null) : null,
    tier: live && row?.impersonate_tier ? normalizeTier(row.impersonate_tier) : null,
    until: live ? until!.toISOString() : null,
    active: live && Boolean(row?.impersonate_role || row?.impersonate_tier),
  };
}

function hashIp(req: HttpRequest): string | null {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-azure-clientip') ??
    null;
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT ?? '';
  return createHash('sha256').update(`${salt}:${ip}`, 'utf8').digest('hex').slice(0, 32);
}

export async function logImpersonation(
  userId: string,
  action: 'start' | 'stop' | 'denied',
  req: HttpRequest,
  role?: Role | null,
  tier?: TierId | null,
): Promise<void> {
  await query(
    `INSERT INTO impersonation_log (user_id, action, role, tier, ip_hash)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, action, role ?? null, tier ?? null, hashIp(req)],
  );
}

export async function startImpersonation(
  userId: string,
  role: Role | null,
  tier: TierId | null,
  req: HttpRequest,
): Promise<ImpersonationState> {
  const until = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await query(
    `UPDATE app_user
        SET impersonate_role = $2, impersonate_tier = $3, impersonate_until = $4
      WHERE id = $1`,
    [userId, role, tier, until],
  );
  await logImpersonation(userId, 'start', req, role, tier);
  return { role, tier, until: until.toISOString(), active: Boolean(role || tier) };
}

export async function stopImpersonation(
  userId: string,
  req: HttpRequest,
): Promise<ImpersonationState> {
  await query(
    `UPDATE app_user
        SET impersonate_role = NULL, impersonate_tier = NULL, impersonate_until = NULL
      WHERE id = $1`,
    [userId],
  );
  await logImpersonation(userId, 'stop', req);
  return { role: null, tier: null, until: null, active: false };
}
