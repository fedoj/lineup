import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { requireUser } from '../lib/auth.js';
import { isAdminAllowlisted } from '../lib/allowlist.js';
import { query, queryOne } from '../lib/db.js';

function clip(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

interface SupportRequestRow {
  id: string;
  subject: string;
  body: string;
  status: string;
  scout_eligible: boolean;
  created_at: Date;
  updated_at: Date;
}

interface SupportCommentRow {
  id: string;
  request_id: string;
  author_kind: 'user' | 'support' | 'scout';
  author_name: string | null;
  body: string;
  created_at: Date;
}

export interface SupportComment {
  id: string;
  authorKind: 'user' | 'support' | 'scout';
  authorName: string;
  body: string;
  createdAt: string;
}

function toComment(row: SupportCommentRow): SupportComment {
  return {
    id: row.id,
    authorKind: row.author_kind,
    authorName:
      row.author_name ??
      (row.author_kind === 'user' ? 'You' : row.author_kind === 'scout' ? 'Scout' : 'Support'),
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

/** Comments for a set of requests, grouped by request id, oldest first. */
export async function commentsFor(requestIds: string[]): Promise<Map<string, SupportComment[]>> {
  const out = new Map<string, SupportComment[]>();
  if (requestIds.length === 0) return out;
  const rows = await query<SupportCommentRow>(
    `SELECT id, request_id, author_kind, author_name, body, created_at
       FROM support_comment
      WHERE request_id = ANY($1::uuid[])
      ORDER BY created_at`,
    [requestIds],
  );
  for (const r of rows) {
    const list = out.get(r.request_id) ?? [];
    list.push(toComment(r));
    out.set(r.request_id, list);
  }
  return out;
}

function toSupportRequest(row: SupportRequestRow, comments: SupportComment[] = []) {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    scoutEligible: row.scout_eligible,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    comments,
  };
}

/**
 * The requester replies on their own ticket. A reply on a closed ticket
 * reopens it, because it means the fix did not land or raised something new.
 */
export async function supportCommentHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    const b = (await req.json()) as { requestId?: unknown; body?: unknown };
    const requestId = clip(b.requestId, 40);
    const text = clip(b.body, 4000);
    if (!requestId || !text) {
      return { status: 400, jsonBody: { error: 'requestId and body are required.' } };
    }

    const owned = await queryOne<{ id: string }>(
      'SELECT id FROM support_request WHERE id = $1 AND user_id = $2',
      [requestId, user.id],
    );
    // Same answer for "not yours" and "does not exist".
    if (!owned) return { status: 404, jsonBody: { error: 'Request not found.' } };

    const row = await queryOne<SupportCommentRow>(
      `INSERT INTO support_comment (request_id, author_kind, author_id, author_name, body)
       VALUES ($1, 'user', $2, NULL, $3)
       RETURNING id, request_id, author_kind, author_name, body, created_at`,
      [requestId, user.id, text],
    );
    await query(
      `UPDATE support_request
          SET updated_at = now(),
              status = CASE WHEN status IN ('resolved', 'dismissed') THEN 'open' ELSE status END,
              resolved_at = CASE WHEN status IN ('resolved', 'dismissed') THEN NULL ELSE resolved_at END
        WHERE id = $1`,
      [requestId],
    );

    return { status: 201, jsonBody: row ? toComment(row) : null };
  } catch (err) {
    ctx.error('support comment failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

export async function supportHandler(
  req: HttpRequest,
  ctx: InvocationContext,
): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const rows = await query<SupportRequestRow>(
        `SELECT id, subject, body, status, scout_eligible, created_at, updated_at
           FROM support_request
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 25`,
        [user.id],
      );
      const comments = await commentsFor(rows.map((r) => r.id));
      return {
        status: 200,
        jsonBody: rows.map((r) => toSupportRequest(r, comments.get(r.id) ?? [])),
      };
    }

    const body = (await req.json()) as { subject?: unknown; body?: unknown };
    const subject = clip(body.subject, 120);
    const details = clip(body.body, 4000);

    if (!subject || !details) {
      return { status: 400, jsonBody: { error: 'Subject and details are required.' } };
    }

    const email = user.email?.toLowerCase() ?? null;
    // Scout only remediates requests from the tester accounts on the admin
    // allowlist; everyone else's requests stay with a human.
    const scoutEligible = isAdminAllowlisted(user);
    const row = await queryOne<SupportRequestRow>(
      `INSERT INTO support_request (user_id, email, subject, body, scout_eligible)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, subject, body, status, scout_eligible, created_at, updated_at`,
      [user.id, email, subject, details, scoutEligible],
    );

    return { status: 201, jsonBody: row ? toSupportRequest(row) : null };
  } catch (err) {
    ctx.error('support failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('support', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'support',
  handler: supportHandler,
});

app.http('supportComments', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'support/comments',
  handler: supportCommentHandler,
});
