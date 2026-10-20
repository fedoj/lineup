import { timingSafeEqual } from 'node:crypto';
import PostalMime from 'postal-mime';
import {
  cleanEmailSubject,
  findTicketTag,
  isAutomatedSender,
  newPartOfEmail,
  SUPPORT_ADDRESS,
  SUPPORT_EMAIL_TICKETS_PER_HOUR,
  ticketTag,
} from '@lineup/shared';
import { query, queryOne, queryQuiet } from './db.js';
import { escapeHtml, sendEmail } from './email.js';

/**
 * Email to support@mahoul.io (rules in packages/shared/src/supportEmail.ts).
 *
 * The Cloudflare Email Worker posts each message here with a shared secret.
 * Email tickets are never Scout-eligible by themselves: a From address can be
 * forged, so an admin decides in the console whether Scout may work on one.
 */

export function inboundSecretOk(given: string | null): boolean {
  const want = process.env.SUPPORT_INBOUND_SECRET ?? '';
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InboundEmail {
  /** The envelope sender from Cloudflare (used when the From header is missing). */
  from?: string;
  /** The whole message as received (RFC 822), base64. */
  raw?: string;
  /** Set by the Worker when the message was too big to pass on whole. */
  tooLarge?: boolean;
  subject?: string;
}

export type InboundResult =
  | { kind: 'ticket'; id: string; acknowledged: boolean }
  | { kind: 'comment'; id: string; ticketId: string }
  | { kind: 'duplicate' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'limited' };

interface Parsed {
  from: string;
  fromName: string | null;
  subject: string;
  text: string;
  messageId: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
  attachments: number;
}

async function parse(input: InboundEmail): Promise<Parsed> {
  if (!input.raw) {
    return {
      from: String(input.from ?? '').toLowerCase(),
      fromName: null,
      subject: String(input.subject ?? ''),
      text: input.tooLarge ? '(This email was too large to receive. Please send it again without attachments.)' : '',
      messageId: null,
      autoSubmitted: null,
      precedence: null,
      attachments: 0,
    };
  }
  const email = await PostalMime.parse(Buffer.from(input.raw, 'base64'));
  const header = (name: string) => email.headers.find((h) => h.key.toLowerCase() === name)?.value ?? null;
  const fromAddress = (email.from && 'address' in email.from ? email.from.address : undefined) ?? input.from ?? '';
  const htmlAsText = email.html
    ? email.html
        .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
    : '';
  return {
    from: fromAddress.trim().toLowerCase(),
    fromName: (email.from && 'name' in email.from ? email.from.name : '')?.trim().slice(0, 120) || null,
    subject: email.subject ?? input.subject ?? '',
    text: email.text ?? htmlAsText,
    messageId: (email.messageId ?? '').trim().slice(0, 300) || null,
    autoSubmitted: header('auto-submitted'),
    precedence: header('precedence'),
    attachments: email.attachments?.length ?? 0,
  };
}

/** Open a ticket from an email, or add it to the ticket its subject tags. */
export async function receiveSupportEmail(input: InboundEmail): Promise<InboundResult> {
  const m = await parse(input);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.from)) return { kind: 'ignored', reason: 'no sender' };
  // Mail Lineup itself sent (an acknowledgement bouncing back) never makes a ticket.
  if (m.from.endsWith('@mahoul.io')) return { kind: 'ignored', reason: 'own address' };

  if (m.messageId) {
    const seen = await queryOne(
      `SELECT 1 FROM support_request WHERE message_id = $1
       UNION ALL SELECT 1 FROM support_comment WHERE message_id = $1 LIMIT 1`,
      [m.messageId],
    );
    if (seen) return { kind: 'duplicate' };
  }

  const note = m.attachments ? `\n\n(${m.attachments} attachment${m.attachments > 1 ? 's' : ''} not kept.)` : '';
  const body = (newPartOfEmail(m.text) || '(No message text.)') + note;

  // A reply to one of our emails: add it to that ticket, if it is the same person's.
  const tag = findTicketTag(m.subject);
  if (tag) {
    const t = await queryOne<{ id: string }>(
      `SELECT id FROM support_request WHERE id::text LIKE $1 AND lower(email) = $2 LIMIT 1`,
      [`${tag}%`, m.from],
    );
    if (t) {
      const c = await queryOne<{ id: string }>(
        `INSERT INTO support_comment (request_id, author_kind, author_name, body, message_id)
         VALUES ($1, 'user', $2, $3, $4) RETURNING id`,
        [t.id, m.fromName ?? m.from, body, m.messageId],
      );
      // A reply on a closed ticket reopens it, as in the app.
      await query(
        `UPDATE support_request
            SET updated_at = now(),
                status = CASE WHEN status IN ('resolved', 'dismissed') THEN 'open' ELSE status END,
                resolved_at = CASE WHEN status IN ('resolved', 'dismissed') THEN NULL ELSE resolved_at END
          WHERE id = $1`,
        [t.id],
      );
      return { kind: 'comment', id: c!.id, ticketId: t.id };
    }
  }

  const recent = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM support_request
      WHERE source = 'email' AND lower(email) = $1 AND created_at > now() - interval '1 hour'`,
    [m.from],
  );
  if ((recent?.n ?? 0) >= SUPPORT_EMAIL_TICKETS_PER_HOUR) return { kind: 'limited' };

  // Linked to the sender's Lineup account when the address matches one.
  const account = await queryOne<{ id: string }>('SELECT id FROM app_user WHERE lower(email) = $1 AND deleted_at IS NULL LIMIT 1', [
    m.from,
  ]);
  const subject = cleanEmailSubject(m.subject);
  const row = await queryOne<{ id: string }>(
    `INSERT INTO support_request (user_id, email, subject, body, scout_eligible, source, from_name, message_id)
     VALUES ($1, $2, $3, $4, false, 'email', $5, $6) RETURNING id`,
    [account?.id ?? null, m.from, subject, body, m.fromName, m.messageId],
  );
  const id = row!.id;

  let acknowledged = false;
  if (!isAutomatedSender(m.from, { autoSubmitted: m.autoSubmitted, precedence: m.precedence })) {
    const text =
      `Hi${m.fromName ? ` ${m.fromName.split(' ')[0]}` : ''},\n\n` +
      `Thanks for writing to Lineup support. We got your message and will reply to this address.\n\n` +
      `To add anything, reply to this email and keep ${ticketTag(id)} in the subject.\n\nThe Lineup team`;
    const r = await sendEmail({
      to: m.from,
      toName: m.fromName ?? undefined,
      subject: `Re: ${subject} ${ticketTag(id)}`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
      replyTo: SUPPORT_ADDRESS,
    });
    acknowledged = r.sent;
  }
  return { kind: 'ticket', id, acknowledged };
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;

/**
 * Email the replies support and Scout wrote on email tickets (from the last
 * 7 days) that have not gone out yet. Throttled unless forced.
 */
export async function sendSupportReplies(force = false): Promise<{ sent: number; failed: number }> {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_EVERY_MS) return { sent: 0, failed: 0 };
  lastSweep = now;
  const rows = await query<{
    id: string;
    request_id: string;
    body: string;
    author_kind: string;
    email: string;
    from_name: string | null;
    subject: string;
    status: string;
  }>(
    `SELECT c.id, c.request_id, c.body, c.author_kind, s.email, s.from_name, s.subject, s.status
       FROM support_comment c JOIN support_request s ON s.id = c.request_id
      WHERE s.source = 'email' AND s.email IS NOT NULL
        AND c.author_kind IN ('support', 'scout') AND c.emailed_at IS NULL
        AND c.created_at > now() - interval '7 days'
      ORDER BY c.created_at
      LIMIT 25`,
  );
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    if (isAutomatedSender(r.email)) {
      await queryQuiet('UPDATE support_comment SET emailed_at = now() WHERE id = $1', [r.id]);
      continue;
    }
    const closing =
      r.status === 'resolved'
        ? 'We have marked this request as done. If anything is still not right, just reply to this email.'
        : `Reply to this email to answer. Keep ${ticketTag(r.request_id)} in the subject.`;
    const text = `${r.body}\n\n${closing}\n\nThe Lineup team`;
    const res = await sendEmail({
      to: r.email,
      toName: r.from_name ?? undefined,
      subject: `Re: ${r.subject} ${ticketTag(r.request_id)}`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
      replyTo: SUPPORT_ADDRESS,
    });
    if (res.sent) {
      sent++;
      await queryQuiet('UPDATE support_comment SET emailed_at = now() WHERE id = $1', [r.id]);
    } else {
      failed++;
      if (res.reason === 'not-configured') break;
    }
  }
  return { sent, failed };
}
