import type { HttpRequest } from '@azure/functions';
import { query, queryOne, queryQuiet } from './db.js';
import { impersonationFromRow } from './impersonation.js';
import { outsideRequestScope, prime } from './requestScope.js';

/**
 * Static Web Apps injects the authenticated principal as a base64 JSON header.
 * No token parsing or JWKS fetching needed — the platform has already
 * validated the identity before the request reaches us.
 */
export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

export interface AuthedUser {
  id: string;
  provider: string;
  subject: string;
  email: string | null;
}

/**
 * Sign-in and sign-up are two Static Web Apps provider entries over the same
 * Entra External ID app registration, so they return the same subject under
 * different identityProvider names. Collapse them to one logical provider or
 * the same person gets two app_user rows.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  lineupsignup: 'lineup',
};

function normalizeProvider(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
}

export function readPrincipal(req: HttpRequest): ClientPrincipal | null {
  const header = req.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    return JSON.parse(decoded) as ClientPrincipal;
  } catch {
    return null;
  }
}

/** Why an otherwise signed-in caller is refused, if they are. */
export type AccountBlock = 'disabled' | 'deactivated' | 'signout';

function blockOf(row: {
  disabled_at: Date | null;
  deactivated_at: Date | null;
  signout_requested_at: Date | null;
  signout_acked_at: Date | null;
}): AccountBlock | null {
  if (row.disabled_at) return 'disabled';
  // The person closed their own account; they may reactivate it themselves.
  if (row.deactivated_at) return 'deactivated';
  if (
    row.signout_requested_at &&
    (!row.signout_acked_at || row.signout_acked_at < row.signout_requested_at)
  ) {
    return 'signout';
  }
  return null;
}

/**
 * Resolve the caller to a row in app_user, creating it on first sight.
 *
 * Disabled accounts, and accounts an admin has signed out everywhere, resolve
 * to null so every endpoint refuses them. /api/me reports which it was.
 */
export async function requireUser(req: HttpRequest): Promise<AuthedUser | null> {
  const resolved = await resolveUser(req);
  return resolved && !resolved.block ? resolved.user : null;
}

/** How stale last_seen_at may get before a request refreshes it. */
const SEEN_REFRESH_MS = 5 * 60_000;

interface UserRow {
  id: string;
  provider: string;
  subject: string;
  email: string | null;
  disabled_at: Date | null;
  deactivated_at: Date | null;
  signout_requested_at: Date | null;
  signout_acked_at: Date | null;
  last_seen_at: Date | null;
  impersonate_role: string | null;
  impersonate_tier: string | null;
  impersonate_until: Date | null;
  is_platform_admin: boolean;
}

const USER_COLUMNS = `id, provider, subject, email, disabled_at, deactivated_at, signout_requested_at, signout_acked_at,
               last_seen_at, impersonate_role, impersonate_tier, impersonate_until, is_platform_admin`;

/** Per-instance request counts not yet written to usage_daily. */
const pendingUsage = new Map<string, { n: number; flushedAt: number }>();
const USAGE_FLUSH_MS = 60_000;

/**
 * Daily request count for the admin dashboard, written at most once a minute
 * per person per instance instead of on every request. Never blocks or fails
 * a request.
 */
function countRequest(userId: string): void {
  const now = Date.now();
  const entry = pendingUsage.get(userId) ?? { n: 0, flushedAt: 0 };
  entry.n += 1;
  pendingUsage.set(userId, entry);
  if (now - entry.flushedAt < USAGE_FLUSH_MS) return;
  const n = entry.n;
  entry.n = 0;
  entry.flushedAt = now;
  void outsideRequestScope(() =>
    queryQuiet(
      `INSERT INTO usage_daily (user_id, day, requests) VALUES ($1, current_date, $2)
       ON CONFLICT (user_id, day) DO UPDATE SET requests = usage_daily.requests + EXCLUDED.requests`,
      [userId, n],
    ),
  ).catch(() => {
    entry.n += n;
  });
}

/** The caller's account and any block on it, without refusing. */
export async function resolveUser(
  req: HttpRequest,
): Promise<{ user: AuthedUser; block: AccountBlock | null } | null> {
  const principal = readPrincipal(req);
  if (!principal?.userId) return null;

  const email = principal.userDetails?.includes('@') ? principal.userDetails : null;
  const provider = normalizeProvider(principal.identityProvider);

  // Usually one read. The account row is written only on first sight, when
  // the email changes, or every few minutes to keep last_seen_at current.
  let row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM app_user WHERE provider = $1 AND subject = $2`,
    [provider, principal.userId],
  );
  const stale =
    !row ||
    (email !== null && email !== row.email) ||
    !row.last_seen_at ||
    Date.now() - row.last_seen_at.getTime() > SEEN_REFRESH_MS;
  if (stale) {
    row = await queryOne<UserRow>(
      `INSERT INTO app_user (provider, subject, email, display_name, last_seen_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (provider, subject)
       DO UPDATE SET email = COALESCE(EXCLUDED.email, app_user.email),
                     last_seen_at = now()
       RETURNING ${USER_COLUMNS}`,
      [provider, principal.userId, email, principal.userDetails ?? null],
    );
  }
  if (!row) return null;

  // The same row answers "impersonating?" and "platform admin?" later in
  // this request, so those are not looked up again.
  prime(`imp:${row.id}`, impersonationFromRow(row));
  prime(`padmin:${row.id}`, row.is_platform_admin);

  const block = blockOf(row);
  if (!block) countRequest(row.id);

  return {
    user: { id: row.id, provider: row.provider, subject: row.subject, email: row.email },
    block,
  };
}
