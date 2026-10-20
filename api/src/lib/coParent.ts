import { randomBytes } from 'node:crypto';
import { escapeHtml, sendEmail } from './email.js';
import { query, queryOne } from './db.js';

/**
 * The other parent (Fady, 10/19). A parent can call themselves mother, father
 * or guardian, add a salutation, and invite the other parent by email; the
 * other parent's invite gives them the same children.
 */

export type ParentLabel = 'mother' | 'father' | 'guardian';
const LABELS: readonly ParentLabel[] = ['mother', 'father', 'guardian'];
export const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanLabel(v: unknown): ParentLabel | null {
  const s = String(v ?? '').trim().toLowerCase();
  return (LABELS as readonly string[]).includes(s) ? (s as ParentLabel) : null;
}

export function cleanSalutation(v: unknown): string | null {
  const s = String(v ?? '').trim().replace(/\.$/, '');
  const hit = SALUTATIONS.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit ?? null;
}

export function cleanEmail(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase().slice(0, 200);
  return EMAIL_RE.test(s) ? s : null;
}

function appOrigin(): string {
  const configured = process.env.APP_ORIGIN?.replace(/\/+$/, '');
  if (configured) return configured;
  return process.env.APP_ENV === 'prd' ? 'https://lineup.mahoul.io' : 'https://lineup-dev.mahoul.io';
}

const LABEL_WORD: Record<ParentLabel, string> = { mother: 'mother', father: 'father', guardian: 'guardian' };

export interface CoParentResult {
  /** An invite was made (or the existing co-parent was linked straight away). */
  created: boolean;
  linked?: boolean;
  emailed?: boolean;
  link?: string;
  reason?: 'invalid-email' | 'self' | 'already-invited';
}

/**
 * Invite the other parent of `parentUserId`'s children, starting from one
 * child on one team. Someone who already shares a child with this parent (they
 * accepted an earlier invite) is linked to the new child straight away;
 * otherwise an invite is emailed, unless one is already waiting.
 */
export async function inviteCoParent(opts: {
  email: string;
  label: ParentLabel | null;
  parentUserId: string;
  teamId: string;
  playerId: string;
}): Promise<CoParentResult> {
  const email = cleanEmail(opts.email);
  if (!email) return { created: false, reason: 'invalid-email' };
  const parent = await queryOne<{ email: string | null; display_name: string | null; salutation: string | null }>(
    'SELECT email, display_name, salutation FROM app_user WHERE id = $1',
    [opts.parentUserId],
  );
  if (parent?.email && parent.email.toLowerCase() === email) return { created: false, reason: 'self' };

  // Already the other parent of one of these children: add this child too.
  const coParent = await queryOne<{ id: string }>(
    `SELECT u.id FROM app_user u
      WHERE lower(u.email) = $1 AND u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM player_guardian a JOIN player_guardian b ON b.player_id = a.player_id
                     WHERE a.user_id = $2 AND b.user_id = u.id)`,
    [email, opts.parentUserId],
  );
  if (coParent) {
    await query(
      `INSERT INTO player_guardian (player_id, user_id, relation, label, consented_at, consented_by)
       VALUES ($1, $2, 'parent', $3, now(), $4) ON CONFLICT DO NOTHING`,
      [opts.playerId, coParent.id, opts.label, opts.parentUserId],
    );
    await query(
      `INSERT INTO membership (user_id, role, team_id)
       SELECT $1, 'parent', $2 WHERE NOT EXISTS (SELECT 1 FROM membership WHERE user_id = $1 AND team_id = $2)`,
      [coParent.id, opts.teamId],
    );
    const child = await queryOne<{ name: string; team: string }>(
      'SELECT p.name, t.name AS team FROM player p JOIN team t ON t.id = p.team_id WHERE p.id = $1',
      [opts.playerId],
    );
    await query(
      `INSERT INTO notification (user_id, kind, title, body, link) VALUES ($1, 'system', $2, $3, '/')`,
      [coParent.id, `${child?.name ?? 'Your child'} is on ${child?.team ?? 'a team'}`, `You can now see ${child?.name ?? 'your child'} on ${child?.team ?? 'the team'}, as the other parent.`],
    ).catch(() => undefined);
    return { created: true, linked: true };
  }

  const waiting = await queryOne(
    `SELECT 1 FROM invite WHERE lower(email) = $1 AND co_parent_of = $2
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [email, opts.parentUserId],
  );
  if (waiting) return { created: false, reason: 'already-invited' };

  const token = randomBytes(24).toString('base64url');
  await query(
    `INSERT INTO invite (email, role, team_id, player_id, token, invited_by, co_parent_of, guardian_label)
     VALUES ($1, 'parent', $2, $3, $4, $5, $5, $6)`,
    [email, opts.teamId, opts.playerId, token, opts.parentUserId, opts.label],
  );
  const kids = await query<{ name: string }>(
    `SELECT DISTINCT p.name FROM player_guardian pg JOIN player p ON p.id = pg.player_id
      WHERE pg.user_id = $1 ORDER BY p.name`,
    [opts.parentUserId],
  );
  const names = kids.map((k) => k.name);
  const childText = names.length ? names.join(' and ') : 'your child';
  const who = [parent?.salutation, parent?.display_name && !parent.display_name.includes('@') ? parent.display_name : null]
    .filter(Boolean)
    .join(' ') || 'The other parent';
  const link = `${appOrigin()}/invite/${token}`;
  const as = opts.label ? ` as their ${LABEL_WORD[opts.label]}` : '';
  const text = `${who} invited you to Lineup${as}, so you can follow ${childText}'s team: games, practices, RSVPs and messages.\n\nAccept the invite: ${link}\n\nThe link works for 14 days.`;
  const html = `<p>${escapeHtml(who)} invited you to Lineup${escapeHtml(as)}, so you can follow ${escapeHtml(childText)}'s team: games, practices, RSVPs and messages.</p><p><a href="${link}">Accept the invite</a></p><p>The link works for 14 days.</p>`;
  const sent = await sendEmail({ to: email, subject: `${who} invited you to follow ${childText} on Lineup`, text, html });
  return { created: true, emailed: sent.sent, link };
}

/**
 * Accepting the other parent's invite: link them to every child of the parent
 * who sent it, with the parent role on each child's team.
 */
export async function linkCoParentChildren(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  coParentOf: string,
  userId: string,
  label: string | null,
): Promise<number> {
  const kids = await client.query(
    `SELECT pg.player_id, p.team_id FROM player_guardian pg
       JOIN player p ON p.id = pg.player_id
       JOIN team t ON t.id = p.team_id AND t.deleted_at IS NULL
      WHERE pg.user_id = $1`,
    [coParentOf],
  );
  for (const k of kids.rows) {
    await client.query(
      `INSERT INTO player_guardian (player_id, user_id, relation, label, consented_at, consented_by)
       VALUES ($1, $2, 'parent', $3, now(), $4) ON CONFLICT DO NOTHING`,
      [k.player_id, userId, label, coParentOf],
    );
    await client.query(
      `INSERT INTO membership (user_id, role, team_id)
       SELECT $1, 'parent', $2 WHERE NOT EXISTS (SELECT 1 FROM membership WHERE user_id = $1 AND team_id = $2)`,
      [userId, k.team_id],
    );
  }
  return kids.rows.length;
}
