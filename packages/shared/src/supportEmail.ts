/**
 * Email to support@mahoul.io becomes a ticket in the support queue (Fady,
 * 10/16). Cloudflare Email Routing hands each message to a small Worker
 * (infra/cloudflare/support-email-worker.js), which posts it to
 * /api/support/inbound. A new message opens a ticket; a reply whose subject
 * carries the ticket's tag ("[#7de1c4b6]") is added to that ticket's thread.
 * Replies from support or Scout go back by email with the tag in the subject.
 */

export const SUPPORT_ADDRESS = 'support@mahoul.io';

/** Longest subject and message kept, as for requests made in the app. */
export const SUPPORT_SUBJECT_MAX = 120;
export const SUPPORT_BODY_MAX = 4000;

/** New email tickets one address may open per hour. */
export const SUPPORT_EMAIL_TICKETS_PER_HOUR = 5;

/** "[#7de1c4b6]": the first 8 characters of the ticket id. */
export function ticketTag(id: string): string {
  return `[#${id.slice(0, 8).toLowerCase()}]`;
}

/** The ticket id prefix tagged in a subject, if any. */
export function findTicketTag(subject: string | null | undefined): string | null {
  const m = /\[#([0-9a-f]{8})\]/i.exec(subject ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** "Re: Fwd: Help [#7de1c4b6]" -> "Help". */
export function cleanEmailSubject(subject: string | null | undefined): string {
  let s = String(subject ?? '').replace(/\[#[0-9a-f]{8}\]/gi, ' ');
  for (;;) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|sv)\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+/g, ' ').trim();
  return (s || 'Email to support').slice(0, SUPPORT_SUBJECT_MAX);
}

/**
 * The new part of an email: the text above the quoted earlier message
 * ("On Fri, Oct 16 … wrote:", "-----Original Message-----", "From: …" or
 * lines starting with ">"), with signature dashes and extra blank lines removed.
 */
export function newPartOfEmail(text: string | null | undefined): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^on .{3,200} wrote:$/i.test(t)) break;
    // Outlook: "From: …" followed soon after by "Sent:" or "Date:".
    if (/^from:\s/i.test(t) && lines.slice(i + 1, i + 4).some((l) => /^(sent|date):\s/i.test(l.trim()))) break;
    if (/^_{8,}$/.test(t)) break;
    if (t === '--' || t === '-- ') break;
    if (t.startsWith('>')) continue;
    out.push(line.replace(/\s+$/, ''));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, SUPPORT_BODY_MAX);
}

/** A sender that must never get an automatic reply (bounces, robots, ourselves). */
export function isAutomatedSender(address: string, headers: { autoSubmitted?: string | null; precedence?: string | null } = {}): boolean {
  const a = address.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) return true;
  const local = a.split('@')[0];
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)(\+.*)?$/.test(local)) return true;
  if (a.endsWith('@mahoul.io')) return true;
  const auto = (headers.autoSubmitted ?? '').trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  const precedence = (headers.precedence ?? '').trim().toLowerCase();
  return ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence);
}
