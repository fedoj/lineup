/**
 * RSVP: going or not going to a game, practice or event, as soon as it is on
 * the schedule. Not going carries a reason (sick, injured or other) and, for
 * other, an optional comment. Coaches and staff see the reasons; everyone
 * else sees the team totals only.
 */

export type RsvpReason = 'sick' | 'injured' | 'other';

export const RSVP_REASONS: ReadonlyArray<[RsvpReason, string]> = [
  ['sick', 'Sick'],
  ['injured', 'Injured'],
  ['other', 'Other'],
];

export const RSVP_NOTE_MAX = 200;

export function isRsvpReason(v: unknown): v is RsvpReason {
  return v === 'sick' || v === 'injured' || v === 'other';
}

/**
 * The reason and comment to store with a not-going answer. A comment is kept
 * only with "other"; no reason at all is allowed (older apps) and stays null.
 */
export function cleanRsvpReason(reason: unknown, note: unknown): { reason: RsvpReason | null; note: string | null } {
  const r = isRsvpReason(reason) ? reason : null;
  const text = r === 'other' ? String(note ?? '').trim().replace(/\s+/g, ' ').slice(0, RSVP_NOTE_MAX) : '';
  return { reason: r, note: text || null };
}

/** "Ben (sick)", "Ava (other: family trip)", or just the name. */
export function nameWithReason(name: string, reason: string | null | undefined, note?: string | null): string {
  if (!isRsvpReason(reason)) return name;
  const label = RSVP_REASONS.find(([r]) => r === reason)![1].toLowerCase();
  return note ? `${name} (${label}: ${note})` : `${name} (${label})`;
}

/* --------------------------------------------------------- add to calendar */

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * One calendar entry as an .ics file, for "add to my calendar". Times are
 * local ("floating"), as the team wrote them; with no time it is an all-day
 * entry. Lines are folded at 75 characters as the format requires.
 */
export interface IcsEvent {
  uid: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, local time */
  time?: string | null;
  durationMinutes?: number;
  location?: string | null;
  description?: string | null;
}

export function buildIcs(e: IcsEvent & { now?: Date }): string {
  return buildIcsCalendar([e], e.now);
}

/**
 * Several calendar entries in one .ics file, for "add all games (or
 * practices, events) to your own calendar".
 */
export function buildIcsCalendar(events: readonly IcsEvent[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mahoul.io//Lineup//EN', 'CALSCALE:GREGORIAN'];
  for (const e of events) lines.push(...icsEvent(e, stamp));
  lines.push('END:VCALENDAR');
  return fold(lines);
}

function icsEvent(e: IcsEvent, stamp: string): string[] {
  const [y, m, d] = e.date.split('-').map(Number);
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${e.uid}@lineup.mahoul.io`, `DTSTAMP:${stamp}`);
  if (e.time && /^\d{1,2}:\d{2}$/.test(e.time)) {
    const [hh, mm] = e.time.split(':').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d, hh, mm));
    const end = new Date(start.getTime() + (e.durationMinutes ?? 90) * 60_000);
    const fmt = (t: Date) =>
      `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00`;
    lines.push(`DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`);
  } else {
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    lines.push(
      `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`,
      `DTEND;VALUE=DATE:${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`,
    );
  }
  lines.push(`SUMMARY:${icsEscape(e.title)}`);
  if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
  // Everything shared out names the site (Fady, 10/19).
  lines.push(`DESCRIPTION:${icsEscape([e.description, `Shared from Lineup: ${SITE_URL}`].filter(Boolean).join('\n\n'))}`);
  lines.push(`URL:${SITE_URL}`);
  lines.push('END:VEVENT');
  return lines;
}

/** The site named on everything Lineup shares out: pictures, cards and calendar files. */
export const SITE_URL = 'https://lineup.mahoul.io';
export const SITE_HOST = 'lineup.mahoul.io';

/** Lines are folded at 75 characters, as the format requires. */
function fold(lines: string[]): string {
  const folded = lines.flatMap((line) => {
    const out: string[] = [];
    let rest = line;
    while (rest.length > 75) {
      out.push(rest.slice(0, 75));
      rest = ` ${rest.slice(75)}`;
    }
    out.push(rest);
    return out;
  });
  return `${folded.join('\r\n')}\r\n`;
}
