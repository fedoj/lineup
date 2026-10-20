/**
 * Data rights — export, deletion, subscription cancellation and email opt-out.
 *
 * Deletion is queued with a grace window rather than executed inline: an
 * accidental tap is recoverable, and a cascade across a season of records is
 * not something to run inside an HTTP request.
 */

import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { randomBytes } from 'node:crypto';
import { requireUser, resolveUser } from '../lib/auth.js';
import { guardTeam } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { purgeArchivedTeams } from '../lib/teamPurge.js';
import { StripeError, periodEnd, stripe, stripeEnabled } from '../lib/stripe.js';
import { applySubscription } from './stripe.js';

/**
 * A plan bought through Stripe is cancelled or resumed in Stripe (at the end
 * of the term), then mirrored here. Returns null for plans granted by hand.
 */
async function setStripeCancel(userId: string, cancel: boolean): Promise<{ accessUntil: Date | null; tier: string } | null> {
  const row = await queryOne<{ external_ref: string | null; tier: string }>(
    `SELECT external_ref, tier FROM entitlement WHERE app_id = 'lineup' AND user_id = $1 AND external_ref LIKE 'stripe:%'
        AND (status = 'active' OR (status = 'cancelled' AND access_until > now()))`,
    [userId],
  );
  if (!row?.external_ref || !stripeEnabled()) return null;
  const sub = await stripe<Record<string, any>>('POST', `/subscriptions/${row.external_ref.slice('stripe:'.length)}`, {
    cancel_at_period_end: cancel ? 'true' : 'false',
  });
  await applySubscription(sub, userId);
  return { accessUntil: periodEnd(sub), tier: row.tier };
}

/* --------------------------------------------------------------- export */

/** Everything we hold for one team, or for the whole account. */
export async function exportHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const teamId = req.query.get('teamId') ?? undefined;
    if (!teamId) return { status: 400, jsonBody: { error: 'teamId is required' } };

    const guard = await guardTeam(user, teamId, 'data.export');
    if (!guard.ok) return guard.response;

    const [team, players, games, periods, practices, attendance, events, contacts] =
      await Promise.all([
        queryOne('SELECT * FROM team WHERE id = $1', [teamId]),
        query('SELECT * FROM player WHERE team_id = $1 ORDER BY name', [teamId]),
        query('SELECT * FROM game WHERE team_id = $1 ORDER BY game_no', [teamId]),
        query(
          `SELECT p.* FROM game_period p JOIN game g ON g.id = p.game_id
            WHERE g.team_id = $1 ORDER BY p.game_id, p.period_index`,
          [teamId],
        ),
        query('SELECT * FROM practice WHERE team_id = $1 ORDER BY date', [teamId]),
        query('SELECT * FROM attendance WHERE team_id = $1 ORDER BY on_date', [teamId]),
        query(
          `SELECT e.* FROM game_event e JOIN game g ON g.id = e.game_id
            WHERE g.team_id = $1`,
          [teamId],
        ),
        query('SELECT * FROM contact WHERE team_id = $1', [teamId]),
      ]);

    return {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="lineup-export-${teamId}.json"`,
      },
      jsonBody: {
        exportedAt: new Date().toISOString(),
        exportedBy: user.email ?? user.id,
        team,
        players,
        games,
        periods,
        practices,
        attendance,
        events,
        contacts,
      },
    };
  } catch (err) {
    ctx.error('export failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* -------------------------------------------------------------- delete */

/** Soft-delete a team, game or player; or queue an account closure. */
export async function deleteHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const scope = req.query.get('scope') ?? '';
    const id = req.query.get('id') ?? undefined;

    if (scope === 'team') {
      const guard = await guardTeam(user, id, 'team.delete');
      if (!guard.ok) return guard.response;
      await query('UPDATE team SET deleted_at = now() WHERE id = $1', [id]);
      return { status: 200, jsonBody: { deleted: 'team', id } };
    }

    if (scope === 'game') {
      const g = await queryOne<{ team_id: string }>(
        'SELECT team_id FROM game WHERE id = $1',
        [id],
      );
      const guard = await guardTeam(user, g?.team_id, 'game.delete');
      if (!guard.ok) return guard.response;
      await query('UPDATE game SET deleted_at = now() WHERE id = $1', [id]);
      return { status: 200, jsonBody: { deleted: 'game', id } };
    }

    if (scope === 'player') {
      const p = await queryOne<{ team_id: string }>(
        'SELECT team_id FROM player WHERE id = $1',
        [id],
      );
      const guard = await guardTeam(user, p?.team_id, 'roster.edit');
      if (!guard.ok) return guard.response;
      // Hard delete: a parent asking for their child's removal should not
      // leave the record sitting in the table behind a flag.
      await query('DELETE FROM player WHERE id = $1', [id]);
      return { status: 200, jsonBody: { deleted: 'player', id } };
    }

    if (scope === 'account') {
      const existing = await queryOne<{ id: string; execute_at: Date }>(
        `SELECT id, execute_at FROM deletion_request
          WHERE user_id = $1 AND scope = 'account'
            AND cancelled_at IS NULL AND executed_at IS NULL`,
        [user.id],
      );
      if (existing) {
        return {
          status: 200,
          jsonBody: { queued: true, executeAt: existing.execute_at.toISOString() },
        };
      }
      const row = await queryOne<{ execute_at: Date }>(
        `INSERT INTO deletion_request (user_id, scope) VALUES ($1, 'account')
         RETURNING execute_at`,
        [user.id],
      );
      return {
        status: 202,
        jsonBody: {
          queued: true,
          executeAt: row?.execute_at.toISOString(),
          message: 'Your account will be deleted after the grace period. Sign in to cancel.',
        },
      };
    }

    return { status: 400, jsonBody: { error: 'Unknown scope' } };
  } catch (err) {
    ctx.error('delete failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Cancel a queued account deletion. */
export async function undeleteHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    await query(
      `UPDATE deletion_request SET cancelled_at = now()
        WHERE user_id = $1 AND cancelled_at IS NULL AND executed_at IS NULL`,
      [user.id],
    );
    return { status: 200, jsonBody: { cancelled: true } };
  } catch (err) {
    ctx.error('undelete failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ---------------------------------------------------------- deactivate */

/** How long a deactivated account is kept before it is deleted. */
export const DEACTIVATION_KEEP = '1 year';

/**
 * "Delete my account" deactivates (Fady, 10/17): the person can't use the
 * app until they reactivate, everything is kept for a year, then the purge
 * deletes it. A paid plan stops renewing.
 */
export async function deactivateHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const row = await transaction(async (client) => {
      await client.query('UPDATE app_user SET deactivated_at = COALESCE(deactivated_at, now()) WHERE id = $1', [
        user.id,
      ]);
      await client.query(
        `INSERT INTO deletion_request (user_id, scope, kind, execute_at)
         SELECT $1, 'account', 'deactivate', now() + $2::interval
          WHERE NOT EXISTS (SELECT 1 FROM deletion_request WHERE user_id = $1 AND scope = 'account'
                              AND kind = 'deactivate' AND executed_at IS NULL AND cancelled_at IS NULL)`,
        [user.id, DEACTIVATION_KEEP],
      );
      const due = await client.query<{ execute_at: Date }>(
        `SELECT execute_at FROM deletion_request
          WHERE user_id = $1 AND scope = 'account' AND executed_at IS NULL AND cancelled_at IS NULL
          ORDER BY execute_at LIMIT 1`,
        [user.id],
      );
      return due.rows[0] ?? null;
    });

    // Nobody should be billed for an account they have switched off.
    try {
      await setStripeCancel(user.id, true);
    } catch (err) {
      ctx.warn('deactivate: stripe cancel failed', err);
    }

    return {
      status: 200,
      jsonBody: { deactivated: true, deletesAt: row?.execute_at.toISOString() ?? null },
    };
  } catch (err) {
    ctx.error('deactivate failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/**
 * Switch a deactivated account back on. Called while deactivated, so it
 * resolves the caller itself instead of using requireUser (which refuses
 * deactivated accounts). Accounts disabled by support stay disabled.
 */
export async function reactivateHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const resolved = await resolveUser(req);
    if (!resolved) return { status: 401, jsonBody: { error: 'Not authenticated' } };
    if (resolved.block === 'disabled') {
      return {
        status: 403,
        jsonBody: {
          error: 'This account has been disabled. Contact support through mahoul.io/support.',
          code: 'ACCOUNT_DISABLED',
        },
      };
    }
    await transaction(async (client) => {
      await client.query(
        `UPDATE app_user SET deactivated_at = NULL,
                signout_acked_at = GREATEST(COALESCE(signout_acked_at, now()), now())
          WHERE id = $1`,
        [resolved.user.id],
      );
      await client.query(
        `UPDATE deletion_request SET cancelled_at = now()
          WHERE user_id = $1 AND scope = 'account' AND executed_at IS NULL AND cancelled_at IS NULL`,
        [resolved.user.id],
      );
    });
    return { status: 200, jsonBody: { reactivated: true } };
  } catch (err) {
    ctx.error('reactivate failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* -------------------------------------------------------- subscription */

/** Reinstate a cancelled plan while it is still inside the access window. */
export async function resumeSubscriptionHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    try {
      const viaStripe = await setStripeCancel(user.id, false);
      if (viaStripe) return { status: 200, jsonBody: { resumed: true, tier: viaStripe.tier } };
    } catch (err) {
      if (err instanceof StripeError) {
        ctx.warn('stripe resume failed', err.status, err.code, err.message);
        return { status: 502, jsonBody: { error: "Stripe couldn't resume the plan right now. Please try again." } };
      }
      throw err;
    }

    const row = await queryOne<{ tier: string }>(
      `UPDATE entitlement
          SET status = 'active', cancelled_at = NULL
        WHERE app_id = 'lineup' AND user_id = $1
          AND status = 'cancelled' AND access_until > now()
        RETURNING tier`,
      [user.id],
    );
    if (!row) {
      return { status: 404, jsonBody: { error: 'Nothing to resume.' } };
    }
    return { status: 200, jsonBody: { resumed: true, tier: row.tier } };
  } catch (err) {
    ctx.error('resume failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* --------------------------------------------------------- unsubscribe */

/**
 * One-click email opt-out. Deliberately unauthenticated — the token in the
 * link is the authorisation, because an unsubscribe that requires signing in
 * is not an unsubscribe.
 */
export async function unsubscribeHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const token = req.query.get('token');
    if (!token) return { status: 400, jsonBody: { error: 'token is required' } };

    const row = await queryOne<{ email: string }>(
      `UPDATE email_optout SET unsubscribed_at = now() WHERE token = $1
       RETURNING email`,
      [token],
    );
    if (!row) return { status: 404, jsonBody: { error: 'Unknown link.' } };

    await query('UPDATE contact SET unsubscribed_at = now() WHERE lower(email) = lower($1)', [
      row.email,
    ]);

    return {
      status: 200,
      jsonBody: { unsubscribed: true, email: row.email },
    };
  } catch (err) {
    ctx.error('unsubscribe failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/** Issue an opt-out token for an address, used when composing an email. */
export async function optOutTokenHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const body = (await req.json()) as { email?: string; scope?: string };
    if (!body.email) return { status: 400, jsonBody: { error: 'email is required' } };

    const token = randomBytes(24).toString('base64url');
    const row = await queryOne<{ token: string; unsubscribed_at: Date }>(
      `INSERT INTO email_optout (email, scope, token)
       VALUES (lower($1), $2, $3)
       ON CONFLICT (email) DO UPDATE SET scope = EXCLUDED.scope
       RETURNING token, unsubscribed_at`,
      [body.email, body.scope ?? 'all', token],
    );
    return { status: 200, jsonBody: { token: row?.token } };
  } catch (err) {
    ctx.error('optOutToken failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

/* ------------------------------------------------------------ purge job */

/**
 * Runs the queued deletions whose grace period has passed.
 * Scheduled daily; also safe to invoke manually by a platform admin.
 */
export async function purgeHandler(
  _req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const due = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM deletion_request
        WHERE executed_at IS NULL AND cancelled_at IS NULL
          AND execute_at <= now() AND scope = 'account'`,
    );

    for (const d of due) {
      await transaction(async (client) => {
        // app_user cascades to membership, entitlement and personal orgs;
        // orgs cascade to regions, divisions, teams and everything below.
        await client.query('DELETE FROM app_user WHERE id = $1', [d.user_id]);
        await client.query(
          'UPDATE deletion_request SET executed_at = now() WHERE id = $1',
          [d.id],
        );
      });
    }

    // Trim telemetry beyond the retention window.
    const logs = await query<{ count: string }>(
      `WITH gone AS (DELETE FROM access_log WHERE at < now() - INTERVAL '90 days' RETURNING 1)
       SELECT COUNT(*) AS count FROM gone`,
    );
    // Archived teams past their month (also swept on ordinary requests).
    const teamsDeleted = await purgeArchivedTeams(true);

    return {
      status: 200,
      jsonBody: {
        accountsDeleted: due.length,
        logRowsTrimmed: Number(logs[0]?.count ?? 0),
        archivedTeamsDeleted: teamsDeleted,
      },
    };
  } catch (err) {
    ctx.error('purge failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('export', {
  methods: ['GET'], authLevel: 'anonymous', route: 'export', handler: exportHandler,
});
app.http('delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'delete', handler: deleteHandler,
});
app.http('undelete', {
  methods: ['POST'], authLevel: 'anonymous', route: 'undelete', handler: undeleteHandler,
});
app.http('deactivate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'me/deactivate', handler: deactivateHandler,
});
app.http('reactivate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'me/reactivate', handler: reactivateHandler,
});
app.http('resumeSubscription', {
  methods: ['POST'], authLevel: 'anonymous', route: 'subscription/resume',
  handler: resumeSubscriptionHandler,
});
app.http('unsubscribe', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'unsubscribe',
  handler: unsubscribeHandler,
});
app.http('optOutToken', {
  methods: ['POST'], authLevel: 'anonymous', route: 'unsubscribe/token',
  handler: optOutTokenHandler,
});
app.http('purge', {
  methods: ['POST'], authLevel: 'function', route: 'console/purge', handler: purgeHandler,
});
