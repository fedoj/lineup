/**
 * Reminders: everyone on a team gets an in-app reminder (the bell) a week
 * before and two days before each of its games and events, and two days
 * before each practice (a week ahead too would be several a week for a team
 * that practices twice). An event of a region or organization reminds
 * everyone on its teams. Each reminder links to the item on the Calendar.
 *
 * There is no timer in Static Web Apps managed functions, so reminders are
 * sent lazily: sendReminders() runs at most every few minutes per instance
 * from the access check every request already makes. Each reminder is claimed
 * first (event_reminder, game_reminder, practice_reminder), so it goes out
 * once even with several instances. A reminder whose moment passed before the
 * item was created is skipped (the "new" notice already covered it), as are
 * cancelled practices. Games and practices record the date a reminder was for,
 * so moving one to a new date sends its reminders again; an event's date
 * change clears them (events.ts).
 */

import type pg from 'pg';
import { query, transaction } from './db.js';
import { audienceSql } from './eventAudience.js';
import { calendarLink } from './links.js';

const EVERY_MS = 5 * 60_000;
const BATCH = 50;
let last = 0;
let running: Promise<number> | null = null;

export type ReminderKind = '7d' | '2d';

/** Lead and cut-off in days: a week before, then two days before. */
const WINDOWS = `(VALUES ('7d', 7, 2), ('2d', 2, 0)) AS k(kind, lead_days, stop_days)`;
/** Practices: two days before only. */
const PRACTICE_WINDOWS = `(VALUES ('2d', 2, 0)) AS k(kind, lead_days, stop_days)`;

function prettyDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function prettyTime(t: string | null): string {
  if (!t || !/^\d{1,2}:\d{2}/.test(t)) return '';
  const [h, m] = t.split(':').map(Number);
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function whenText(kind: ReminderKind): string {
  return kind === '7d' ? 'in 1 week' : 'in 2 days';
}

function onText(date: string, time: string | null, location: string | null): string {
  const at = prettyTime(time) ? ` at ${prettyTime(time)}` : '';
  const where = location ? `, ${location}` : '';
  return `${prettyDay(date)}${at}${where}`;
}

export function reminderText(r: {
  kind: ReminderKind;
  title: string;
  date: string;
  start_time: string | null;
  location: string | null;
}): { title: string; body: string } {
  return {
    title: `Reminder: ${r.title} ${whenText(r.kind)}`,
    body: `${r.title} is on ${onText(r.date, r.start_time, r.location)}. Let the team know if your child is going on the Calendar.`,
  };
}

export function gameReminderText(r: {
  kind: ReminderKind;
  team: string;
  opponent: string;
  is_home: boolean;
  date: string;
  kickoff: string | null;
  location: string | null;
}): { title: string; body: string } {
  const match = `${r.team} ${r.is_home ? 'vs' : 'at'} ${r.opponent || 'TBD'}`;
  return {
    title: `Reminder: ${match} ${whenText(r.kind)}`,
    body: `The game is on ${onText(r.date, r.kickoff, r.location)}. Let the coach know if your child is going on the Calendar.`,
  };
}

export function practiceReminderText(r: {
  kind: ReminderKind;
  team: string;
  date: string;
  start_time: string | null;
  location: string | null;
}): { title: string; body: string } {
  return {
    title: `Reminder: ${r.team} practice ${whenText(r.kind)}`,
    body: `Practice is on ${onText(r.date, r.start_time, r.location)}. Check your child in on the Calendar.`,
  };
}

/** Tell everyone on one team; returns how many people were told. */
async function notifyTeam(
  c: pg.PoolClient,
  teamId: string,
  text: { title: string; body: string },
  focus: string,
): Promise<number> {
  const res = await c.query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT DISTINCT m.user_id, 'reminder', $2, $3, $4
       FROM membership m JOIN team t ON t.id = m.team_id AND t.deleted_at IS NULL
      WHERE t.id = $1`,
    [teamId, text.title, text.body, calendarLink(teamId, focus)],
  );
  return res.rowCount ?? 0;
}

async function eventReminders(): Promise<number> {
  const due = await query<{
    id: string; kind: ReminderKind; title: string; date: string; start_time: string | null;
    location: string | null; team_id: string | null; region_id: string | null; org_id: string | null;
  }>(
    `SELECT e.id, k.kind, e.title, to_char(e.date, 'YYYY-MM-DD') AS date,
            to_char(e.start_time, 'HH24:MI') AS start_time, e.location,
            e.team_id, e.region_id, e.org_id
       FROM team_event e
       CROSS JOIN ${WINDOWS}
      WHERE e.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM team ta WHERE ta.id = e.team_id AND ta.archived_at IS NOT NULL)
        AND current_date >= e.date - k.lead_days
        AND current_date < e.date - k.stop_days
        AND e.created_at::date < e.date - k.lead_days
        AND NOT EXISTS (SELECT 1 FROM event_reminder r WHERE r.event_id = e.id AND r.kind = k.kind)
      ORDER BY e.date
      LIMIT ${BATCH}`,
  );
  let sent = 0;
  for (const r of due) {
    await transaction(async (c) => {
      const claim = await c.query(
        `INSERT INTO event_reminder (event_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`,
        [r.id, r.kind],
      );
      if (!claim.rowCount) return;
      const text = reminderText(r);
      // Everyone on the event's team, or on every team in its region or
      // organization; teams paused by a lapsed trial are left out. Each
      // person's link opens the event on their own team's Calendar. An event
      // for chosen regions, age groups, teams or people reminds only them.
      const res = await c.query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT ON (m.user_id) m.user_id, 'reminder', $4, $5,
                '/calendar?team=' || t.id || '&focus=event:' || $6
           FROM membership m
           JOIN team t ON t.id = m.team_id AND t.deleted_at IS NULL
           LEFT JOIN division d ON d.id = t.division_id
          WHERE (($1::uuid IS NOT NULL AND t.id = $1)
             OR ($1::uuid IS NULL AND $2::uuid IS NOT NULL AND t.region_id = $2)
             OR ($1::uuid IS NULL AND $2::uuid IS NULL AND t.org_id = $3))
            AND ${audienceSql('$7::uuid', 't', 'd', 'm.user_id')}`,
        [r.team_id, r.region_id, r.org_id, text.title, text.body, r.id, r.id],
      );
      await c.query('UPDATE event_reminder SET recipients = $3 WHERE event_id = $1 AND kind = $2', [
        r.id, r.kind, res.rowCount ?? 0,
      ]);
      sent++;
    });
  }
  return sent;
}

async function gameReminders(): Promise<number> {
  // A league game's kick-off and venue live on its fixture.
  const due = await query<{
    id: string; kind: ReminderKind; team_id: string; team: string; opponent: string; is_home: boolean;
    date: string; kickoff: string | null; location: string | null;
  }>(
    `SELECT g.id, k.kind, g.team_id, t.name AS team, g.opponent, g.is_home,
            to_char(g.date, 'YYYY-MM-DD') AS date,
            COALESCE(f.kickoff, g.kickoff) AS kickoff, COALESCE(f.location, g.location) AS location
       FROM game g
       JOIN team t ON t.id = g.team_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
       LEFT JOIN fixture f ON f.id = g.fixture_id AND f.deleted_at IS NULL
       CROSS JOIN ${WINDOWS}
      WHERE g.deleted_at IS NULL AND g.canceled_at IS NULL AND g.date IS NOT NULL
        AND current_date >= g.date - k.lead_days
        AND current_date < g.date - k.stop_days
        AND g.created_at::date < g.date - k.lead_days
        AND NOT EXISTS (SELECT 1 FROM game_reminder r
                         WHERE r.game_id = g.id AND r.kind = k.kind AND r.for_date = g.date)
      ORDER BY g.date
      LIMIT ${BATCH}`,
  );
  let sent = 0;
  for (const r of due) {
    await transaction(async (c) => {
      const claim = await c.query(
        `INSERT INTO game_reminder (game_id, kind, for_date) VALUES ($1, $2, $3::date)
         ON CONFLICT DO NOTHING RETURNING game_id`,
        [r.id, r.kind, r.date],
      );
      if (!claim.rowCount) return;
      const n = await notifyTeam(c, r.team_id, gameReminderText(r), `game:${r.id}`);
      await c.query('UPDATE game_reminder SET recipients = $4 WHERE game_id = $1 AND kind = $2 AND for_date = $3::date', [
        r.id, r.kind, r.date, n,
      ]);
      sent++;
    });
  }
  return sent;
}

async function practiceReminders(): Promise<number> {
  // Practices count days in their own time zone.
  const due = await query<{
    id: string; kind: ReminderKind; team_id: string; team: string; date: string;
    start_time: string | null; location: string | null;
  }>(
    `SELECT p.id, k.kind, p.team_id, t.name AS team, to_char(p.date, 'YYYY-MM-DD') AS date,
            to_char(p.start_time, 'HH24:MI') AS start_time, p.location
       FROM practice p
       JOIN team t ON t.id = p.team_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
       CROSS JOIN ${PRACTICE_WINDOWS}
      WHERE p.canceled_at IS NULL
        AND (now() AT TIME ZONE p.timezone)::date >= p.date - k.lead_days
        AND (now() AT TIME ZONE p.timezone)::date < p.date - k.stop_days
        AND (p.created_at AT TIME ZONE p.timezone)::date < p.date - k.lead_days
        AND NOT EXISTS (SELECT 1 FROM practice_reminder r
                         WHERE r.practice_id = p.id AND r.kind = k.kind AND r.for_date = p.date)
      ORDER BY p.date
      LIMIT ${BATCH}`,
  );
  let sent = 0;
  for (const r of due) {
    await transaction(async (c) => {
      const claim = await c.query(
        `INSERT INTO practice_reminder (practice_id, kind, for_date) VALUES ($1, $2, $3::date)
         ON CONFLICT DO NOTHING RETURNING practice_id`,
        [r.id, r.kind, r.date],
      );
      if (!claim.rowCount) return;
      const n = await notifyTeam(c, r.team_id, practiceReminderText(r), `practice:${r.id}`);
      await c.query(
        'UPDATE practice_reminder SET recipients = $4 WHERE practice_id = $1 AND kind = $2 AND for_date = $3::date',
        [r.id, r.kind, r.date, n],
      );
      sent++;
    });
  }
  return sent;
}

/**
 * Leagues (Shadi, 10/21): three quarters of the way through, the coaches and
 * assistant coaches of every team in it are reminded to evaluate their
 * players, once. Tournaments are too short for it.
 */
async function evaluationReminders(): Promise<number> {
  const due = await query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM competition c
      WHERE c.kind = 'season' AND c.deleted_at IS NULL AND c.eval_reminded_at IS NULL
        AND c.ends_on > c.starts_on
        AND current_date >= c.starts_on + ((c.ends_on - c.starts_on) * 3 / 4)
        AND current_date <= c.ends_on
      ORDER BY c.ends_on
      LIMIT ${BATCH}`,
  );
  let sent = 0;
  for (const c of due) {
    await transaction(async (tx) => {
      const claim = await tx.query(
        'UPDATE competition SET eval_reminded_at = now() WHERE id = $1 AND eval_reminded_at IS NULL RETURNING id',
        [c.id],
      );
      if (!claim.rowCount) return;
      await tx.query(
        `INSERT INTO notification (user_id, kind, title, body, link)
         SELECT DISTINCT ON (m.user_id) m.user_id, 'reminder', $2, $3, '/team?team=' || t.id
           FROM competition_team ct
           JOIN team t ON t.id = ct.team_id AND t.deleted_at IS NULL AND t.archived_at IS NULL
           JOIN membership m ON m.team_id = t.id AND m.role IN ('coach', 'assistant')
          WHERE ct.competition_id = $1
          ORDER BY m.user_id, t.name`,
        [
          c.id,
          'Time to evaluate your players',
          `${c.name} is three quarters done. Rate each player on Team & roster while the season is fresh.`,
        ],
      );
      sent++;
    });
  }
  return sent;
}

/**
 * Send every reminder that is due: events, games and practices. Throttled;
 * pass force to run now. Returns how many reminders went out.
 */
export async function sendReminders(force = false): Promise<number> {
  if (running) {
    await running;
    return 0;
  }
  const now = Date.now();
  if (!force && now - last < EVERY_MS) return 0;
  last = now;
  running = (async () => {
    try {
      // One kind failing must not stop the others.
      const counts = await Promise.all([
        eventReminders().catch(() => 0),
        gameReminders().catch(() => 0),
        practiceReminders().catch(() => 0),
        evaluationReminders().catch(() => 0),
      ]);
      return counts.reduce((a, b) => a + b, 0);
    } finally {
      running = null;
    }
  })();
  return running;
}
