import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';
import { query, queryOne } from '../lib/db.js';
import { cleanEmail, cleanLabel, cleanSalutation, inviteCoParent } from '../lib/coParent.js';

/**
 * A parent's family on Account (Fady, 10/19): their children, the other
 * parent(s) of those children, invites waiting, and how they call themselves
 * (mother, father or guardian; a salutation). "Invite the other parent" sends
 * an invite that gives the other parent the same children.
 */
export async function familyHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const [me, children, others, pending] = await Promise.all([
        queryOne<{ salutation: string | null; label: string | null }>(
          `SELECT u.salutation, (SELECT pg.label FROM player_guardian pg WHERE pg.user_id = u.id AND pg.label IS NOT NULL LIMIT 1) AS label
             FROM app_user u WHERE u.id = $1`,
          [user.id],
        ),
        query<{ player_id: string; name: string; team_id: string; team_name: string }>(
          `SELECT p.id AS player_id, p.name, t.id AS team_id, t.name AS team_name
             FROM player_guardian pg JOIN player p ON p.id = pg.player_id JOIN team t ON t.id = p.team_id AND t.deleted_at IS NULL
            WHERE pg.user_id = $1 AND pg.relation <> 'self'
            ORDER BY p.name, t.name`,
          [user.id],
        ),
        // Other parents of the same children.
        query<{ user_id: string; name: string | null; email: string | null; salutation: string | null; label: string | null; children: string[] }>(
          `SELECT u.id AS user_id, u.display_name AS name, u.email, u.salutation, max(o.label) AS label,
                  array_agg(DISTINCT p.name) AS children
             FROM player_guardian mine
             JOIN player_guardian o ON o.player_id = mine.player_id AND o.user_id <> mine.user_id
             JOIN app_user u ON u.id = o.user_id AND u.deleted_at IS NULL
             JOIN player p ON p.id = mine.player_id
            WHERE mine.user_id = $1
            GROUP BY u.id, u.display_name, u.email, u.salutation`,
          [user.id],
        ),
        query<{ email: string; label: string | null; created_at: Date }>(
          `SELECT email, guardian_label AS label, created_at FROM invite
            WHERE co_parent_of = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            ORDER BY created_at DESC`,
          [user.id],
        ),
      ]);
      return {
        status: 200,
        jsonBody: {
          salutation: me?.salutation ?? null,
          label: me?.label ?? null,
          children: children.map((c) => ({ playerId: c.player_id, name: c.name, teamId: c.team_id, teamName: c.team_name })),
          otherParents: others.map((o) => ({
            name: o.name && !o.name.includes('@') ? o.name : null,
            email: o.email,
            salutation: o.salutation,
            label: o.label,
            children: o.children,
          })),
          pending: pending.map((p) => ({ email: p.email, label: p.label, sentAt: p.created_at.toISOString() })),
        },
      };
    }

    const b = (await req.json()) as { action?: string; email?: string; label?: string; salutation?: string | null };

    if (b.action === 'profile') {
      const salutation = b.salutation ? cleanSalutation(b.salutation) : null;
      const label = b.label ? cleanLabel(b.label) : null;
      await query('UPDATE app_user SET salutation = $2 WHERE id = $1', [user.id, salutation]);
      await query(`UPDATE player_guardian SET label = $2 WHERE user_id = $1 AND relation <> 'self'`, [user.id, label]);
      return { status: 200, jsonBody: { salutation, label } };
    }

    if (b.action === 'invite') {
      const email = cleanEmail(b.email);
      if (!email) return { status: 400, jsonBody: { error: "That email doesn't look right." } };
      const child = await queryOne<{ player_id: string; team_id: string }>(
        `SELECT p.id AS player_id, p.team_id FROM player_guardian pg
           JOIN player p ON p.id = pg.player_id JOIN team t ON t.id = p.team_id AND t.deleted_at IS NULL
          WHERE pg.user_id = $1 AND pg.relation <> 'self'
          ORDER BY pg.created_at LIMIT 1`,
        [user.id],
      );
      if (!child) return { status: 400, jsonBody: { error: 'Once your child is on a team, you can invite the other parent.' } };
      const open = await queryOne<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM invite WHERE co_parent_of = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [user.id],
      );
      if ((open?.n ?? 0) >= 5) return { status: 429, jsonBody: { error: 'You have 5 invites waiting. Wait for one to be accepted first.' } };
      const r = await inviteCoParent({ email, label: cleanLabel(b.label), parentUserId: user.id, teamId: child.team_id, playerId: child.player_id });
      if (r.reason === 'self') return { status: 400, jsonBody: { error: "That's your own email. Use the other parent's." } };
      if (r.reason === 'already-invited') return { status: 409, jsonBody: { error: 'An invite to that email is already waiting.' } };
      return { status: 201, jsonBody: { invited: !r.linked, linked: Boolean(r.linked), emailed: Boolean(r.emailed), link: r.link ?? null } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action' } };
  } catch (err) {
    ctx.error('family failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('family', { methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'family', handler: familyHandler });
