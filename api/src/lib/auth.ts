import type { HttpRequest } from '@azure/functions';
import { queryOne } from './db.js';

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

/** Resolve the caller to a row in app_user, creating it on first sight. */
export async function requireUser(req: HttpRequest): Promise<AuthedUser | null> {
  const principal = readPrincipal(req);
  if (!principal?.userId) return null;

  const email = principal.userDetails?.includes('@') ? principal.userDetails : null;

  const row = await queryOne<{
    id: string;
    provider: string;
    subject: string;
    email: string | null;
  }>(
    `INSERT INTO app_user (provider, subject, email, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, subject)
     DO UPDATE SET email = COALESCE(EXCLUDED.email, app_user.email)
     RETURNING id, provider, subject, email`,
    [principal.identityProvider, principal.userId, email, principal.userDetails ?? null],
  );

  return row ?? null;
}

/** Confirm the user owns the team before any read or write touches it. */
export async function assertTeamOwner(userId: string, teamId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM team WHERE id = $1 AND owner_id = $2',
    [teamId, userId],
  );
  return Boolean(row);
}
