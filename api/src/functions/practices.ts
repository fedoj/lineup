import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import {
  PRACTICE_CANCEL_REASONS,
  PRACTICE_CHECKIN_LIST,
  PRACTICE_FREE_DAYS,
  canOnTeam,
  cleanRsvpReason,
  cancelLabel,
  cancelReasonOf,
  practiceDates,
  scheduleLengthDays,
} from '@lineup/shared';
import { requireUser } from '../lib/auth.js';
import { guardTeam, TEAM_ARCHIVED } from '../lib/authz.js';
import { query, queryOne, transaction } from '../lib/db.js';
import { enforceFeature, featureEnabled } from '../lib/entitlements.js';
import { calendarLink } from '../lib/links.js';

/**
 * Practices: the schedule, parent check-ins, cancellations and attendance.
 * Rules live in packages/shared/src/practice.ts.
 *
 * Coaches and assistant coaches (game.create) set the schedule and cancel
 * practices. Parents check their own child in or out as soon as a practice is
 * on the schedule, until it starts; that answer is the attendance.
 * Coaches, assistants and team parents can also mark attendance by hand on a
 * paid plan (manualAttendance).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FORBIDDEN: HttpResponseInit = { status: 403, jsonBody: { error: 'You do not have access to this.', code: 'FORBIDDEN' } };
const REASON_LABEL = Object.fromEntries(PRACTICE_CANCEL_REASONS);

function clip(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

async function validTimezone(tz: string): Promise<string> {
  if (!tz || tz.length > 64) return 'America/Los_Angeles';
  const ok = await queryOne('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz]);
  return ok ? tz : 'America/Los_Angeles';
}

interface PracticeRow {
  id: string;
  team_id: string;
  series_id: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  canceled_at: Date | null;
  cancel_reason: string | null;
  cancel_note: string | null;
  opens_at: Date;
  closes_at: Date;
  open: boolean;
  closed: boolean;
}

const PRACTICE_COLUMNS = `p.id, p.team_id, p.series_id, to_char(p.date, 'YYYY-MM-DD') AS date,
  to_char(p.start_time, 'HH24:MI') AS start_time, to_char(p.end_time, 'HH24:MI') AS end_time,
  p.location, p.canceled_at, p.cancel_reason, p.cancel_note,
  p.created_at AS opens_at,
  ((p.date + COALESCE(p.start_time, time '00:00')) AT TIME ZONE p.timezone) AS closes_at,
  (now() < ((p.date + COALESCE(p.start_time, time '00:00')) AT TIME ZONE p.timezone)) AS open,
  (now() >= ((p.date + COALESCE(p.start_time, time '00:00')) AT TIME ZONE p.timezone)) AS closed`;

/**
 * Set (or change) one player's attendance for one practice. A parent's RSVP
 * carries its not-going reason (why); a manual mark by staff leaves the
 * reason and comment as they were.
 */
async function setAttendance(
  p: { id: string; team_id: string; date: string },
  playerId: string,
  status: string,
  by: string,
  why?: { reason: string | null; note: string | null },
) {
  const updated = await queryOne(
    `UPDATE attendance SET status = $3, recorded_by = $4, recorded_at = now(),
            reason = CASE WHEN $5 THEN $6 ELSE reason END,
            note = CASE WHEN $5 THEN $7 ELSE note END
      WHERE practice_id = $1 AND player_id = $2 RETURNING id`,
    [p.id, playerId, status, by, Boolean(why), why?.reason ?? null, why?.note ?? null],
  );
  if (!updated) {
    await query(
      `INSERT INTO attendance (team_id, player_id, practice_id, on_date, status, recorded_by, reason, note)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)`,
      [p.team_id, playerId, p.id, p.date, status, by, why?.reason ?? null, why?.note ?? null],
    );
  }
}

/** Tell the rest of the team, with a link straight to the practice on the Calendar. */
async function notifyTeam(teamId: string, actorId: string, title: string, body: string, focus: string) {
  await query(
    `INSERT INTO notification (user_id, kind, title, body, link)
     SELECT DISTINCT m.user_id, 'message', $3, $4, $5
       FROM membership m WHERE m.team_id = $1 AND m.user_id <> $2`,
    [teamId, actorId, title, body, calendarLink(teamId, focus)],
  );
}

function prettyDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export async function practicesHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const user = await requireUser(req);
    if (!user) return { status: 401, jsonBody: { error: 'Not authenticated' } };

    if (req.method === 'GET') {
      const guard = await guardTeam(user, req.query.get('teamId') ?? undefined, 'team.view');
      if (!guard.ok) return guard.response;
      const teamId = guard.team.teamId;
      const canSchedule = canOnTeam(guard.ctx, guard.team, 'game.create').allowed;
      const staff = canSchedule || canOnTeam(guard.ctx, guard.team, 'attendance.edit').allowed || guard.role === 'team_parent';
      const [practices, players, series, manual, extended, answers] = await Promise.all([
        query<PracticeRow>(
          `SELECT ${PRACTICE_COLUMNS} FROM practice p
            WHERE p.team_id = $1 AND p.date >= (now() AT TIME ZONE p.timezone)::date - $2::int
            ORDER BY p.date, p.start_time NULLS FIRST LIMIT ${PRACTICE_CHECKIN_LIST}`,
          [teamId, staff ? 7 : 0],
        ),
        query<{ id: string; name: string }>('SELECT id, name FROM player WHERE team_id = $1 AND active ORDER BY name', [teamId]),
        canSchedule
          ? query<{
              id: string; days_of_week: number[]; start_time: string; end_time: string | null; location: string | null;
              starts_on: string; ends_on: string; upcoming: number;
            }>(
              `SELECT s.id, s.days_of_week, to_char(s.start_time, 'HH24:MI') AS start_time,
                      to_char(s.end_time, 'HH24:MI') AS end_time, s.location,
                      to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on,
                      (SELECT COUNT(*) FROM practice p WHERE p.series_id = s.id
                         AND p.date >= (now() AT TIME ZONE s.timezone)::date)::int AS upcoming
                 FROM practice_series s
                WHERE s.team_id = $1 AND s.ends_on >= (now() AT TIME ZONE s.timezone)::date ORDER BY s.starts_on`,
              [teamId],
            )
          : Promise.resolve([]),
        featureEnabled(user.id, 'manualAttendance'),
        featureEnabled(user.id, 'extendedPractice'),
        // Answers for the same practices, read beside them.
        query<{ practice_id: string; player_id: string; status: string; reason: string | null; note: string | null }>(
          `SELECT a.practice_id, a.player_id, a.status, a.reason, a.note
             FROM attendance a JOIN practice p ON p.id = a.practice_id
            WHERE p.team_id = $1 AND p.date >= (now() AT TIME ZONE p.timezone)::date - $2::int`,
          [teamId, staff ? 7 : 0],
        ),
      ]);
      const answerOf = (pid: string, playerId: string) =>
        answers.find((a) => a.practice_id === pid && a.player_id === playerId) ?? null;
      const statusOf = (pid: string, playerId: string) => answerOf(pid, playerId)?.status ?? null;
      const whyOf = (pid: string, playerId: string) => {
        const a = answerOf(pid, playerId);
        return { reason: a?.reason ?? null, note: a?.reason === 'other' ? a.note : null };
      };
      const mine = new Set(guard.ctx.guardianOf ?? []);
      const children = players.filter((p) => mine.has(p.id));

      return {
        status: 200,
        jsonBody: {
          canSchedule,
          canSeeSummary: staff,
          canMarkAttendance: staff && manual,
          manualAttendancePaid: manual,
          extendedPractice: extended,
          freeDays: PRACTICE_FREE_DAYS,
          reasons: PRACTICE_CANCEL_REASONS.map(([id, label]) => ({ id, label })),
          series: series.map((s) => ({
            id: s.id,
            days: s.days_of_week,
            startTime: s.start_time,
            endTime: s.end_time,
            location: s.location,
            startsOn: s.starts_on,
            endsOn: s.ends_on,
            upcoming: s.upcoming,
          })),
          players: staff ? players : [],
          practices: practices.map((p) => {
            const statuses = players.map((pl) => statusOf(p.id, pl.id));
            return {
              id: p.id,
              seriesId: p.series_id,
              date: p.date,
              startTime: p.start_time,
              endTime: p.end_time,
              location: p.location,
              canceled: Boolean(p.canceled_at),
              cancelReason: p.cancel_reason,
              cancelLabel: p.cancel_reason ? cancelLabel(p.cancel_reason) : null,
              cancelNote: p.cancel_note,
              opensAt: p.opens_at.toISOString(),
              closesAt: p.closes_at.toISOString(),
              open: p.open && !p.canceled_at,
              closed: p.closed,
              children: children.map((c) => ({ playerId: c.id, name: c.name, status: statusOf(p.id, c.id), ...whyOf(p.id, c.id) })),
              // Totals for everyone on the team; names for staff only.
              counts: {
                going: statuses.filter((s) => s === 'present' || s === 'late').length,
                notGoing: statuses.filter((s) => s === 'absent' || s === 'excused').length,
                noAnswer: statuses.filter((s) => s === null).length,
              },
              attendance: staff
                ? players.map((pl) => ({ playerId: pl.id, name: pl.name, status: statusOf(p.id, pl.id), ...whyOf(p.id, pl.id) }))
                : [],
            };
          }),
        },
      };
    }

    const b = (await req.json()) as {
      action?: string;
      teamId?: string;
      practiceId?: string;
      seriesId?: string;
      playerId?: string;
      status?: string;
      days?: number[];
      date?: string;
      startTime?: string;
      endTime?: string;
      location?: string;
      startsOn?: string;
      endsOn?: string;
      timezone?: string;
      reason?: string;
      note?: string;
    };
    const action = String(b.action ?? '');

    // New practices: a weekly schedule, or one extra practice.
    if (action === 'schedule' || action === 'add') {
      const guard = await guardTeam(user, b.teamId, 'game.create');
      if (!guard.ok) return guard.response;
      const start = clip(b.startTime, 5);
      const end = clip(b.endTime, 5) || null;
      if (!TIME_RE.test(start) || (end && !TIME_RE.test(end))) {
        return { status: 400, jsonBody: { error: 'Times must look like 17:30.' } };
      }
      if (end && end <= start) return { status: 400, jsonBody: { error: 'Practice ends before it starts.' } };
      const location = clip(b.location, 160) || null;
      const tz = await validTimezone(clip(b.timezone, 64));

      if (action === 'add') {
        const date = clip(b.date, 10);
        if (!DATE_RE.test(date)) return { status: 400, jsonBody: { error: 'Pick a date for the practice.' } };
        const row = await queryOne<{ id: string }>(
          `INSERT INTO practice (team_id, date, title, start_time, end_time, location, timezone)
           VALUES ($1, $2::date, 'Practice', $3, $4, $5, $6) RETURNING id`,
          [guard.team.teamId, date, start, end, location, tz],
        );
        return { status: 201, jsonBody: { id: row?.id } };
      }

      const startsOn = clip(b.startsOn, 10);
      const endsOn = clip(b.endsOn, 10);
      if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn) || endsOn < startsOn) {
        return { status: 400, jsonBody: { error: 'Pick a start date and an end date after it.' } };
      }
      const days = Array.isArray(b.days) ? b.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
      if (days.length === 0) return { status: 400, jsonBody: { error: 'Pick at least one practice day.' } };
      if (scheduleLengthDays(startsOn, endsOn) > PRACTICE_FREE_DAYS) {
        const denied = await enforceFeature(user.id, 'extendedPractice');
        if (denied) {
          return {
            status: denied.status,
            jsonBody: { ...denied.body, error: `The free plan schedules up to ${PRACTICE_FREE_DAYS} days of practices at a time. A paid plan allows longer seasons.` },
          };
        }
      }
      const dates = practiceDates(startsOn, endsOn, days);
      if (dates.length === 0) return { status: 400, jsonBody: { error: 'None of those days fall between the two dates.' } };
      const created = await transaction(async (c) => {
        const s = await c.query<{ id: string }>(
          `INSERT INTO practice_series (team_id, days_of_week, start_time, end_time, location, starts_on, ends_on, timezone, created_by)
           VALUES ($1, $2::smallint[], $3, $4, $5, $6::date, $7::date, $8, $9) RETURNING id`,
          [guard.team.teamId, days, start, end, location, startsOn, endsOn, tz, user.id],
        );
        await c.query(
          `INSERT INTO practice (team_id, series_id, date, title, start_time, end_time, location, timezone)
           SELECT $1, $2, d::date, 'Practice', $3, $4, $5, $6 FROM unnest($7::text[]) AS d`,
          [guard.team.teamId, s.rows[0].id, start, end, location, tz, dates],
        );
        return { seriesId: s.rows[0].id, practices: dates.length };
      });
      await notifyTeam(
        guard.team.teamId,
        user.id,
        'Practice schedule added',
        `${created.practices} practices from ${prettyDay(startsOn)} to ${prettyDay(endsOn)} are on the team calendar.`,
        'practices',
      ).catch(() => undefined);
      return { status: 201, jsonBody: created };
    }

    if (action === 'removeSchedule') {
      const s = await queryOne<{ id: string; team_id: string; starts_on: string }>(
        `SELECT id, team_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM practice_series WHERE id = $1`,
        [clip(b.seriesId, 36)],
      );
      if (!s) return FORBIDDEN;
      const guard = await guardTeam(user, s.team_id, 'game.create');
      if (!guard.ok) return guard.response;
      // Past practices keep their attendance; only upcoming ones go.
      await transaction(async (c) => {
        const local = `(SELECT (now() AT TIME ZONE timezone)::date FROM practice_series WHERE id = $1)`;
        await c.query(`DELETE FROM practice WHERE series_id = $1 AND date >= ${local}`, [s.id]);
        const rest = await c.query('SELECT 1 FROM practice WHERE series_id = $1 LIMIT 1', [s.id]);
        if (rest.rowCount === 0) await c.query('DELETE FROM practice_series WHERE id = $1', [s.id]);
        else await c.query(`UPDATE practice_series SET ends_on = GREATEST(starts_on, ${local} - 1) WHERE id = $1`, [s.id]);
      });
      return { status: 200, jsonBody: { ok: true } };
    }

    // Everything below acts on one practice.
    const p = await queryOne<PracticeRow>(
      `SELECT ${PRACTICE_COLUMNS} FROM practice p WHERE p.id = $1`,
      [clip(b.practiceId, 36)],
    );
    if (!p) return FORBIDDEN;

    if (action === 'cancel' || action === 'restore' || action === 'delete') {
      const guard = await guardTeam(user, p.team_id, 'game.create');
      if (!guard.ok) return guard.response;
      if (action === 'delete') {
        await query('DELETE FROM practice WHERE id = $1', [p.id]);
        return { status: 200, jsonBody: { ok: true } };
      }
      if (action === 'restore') {
        await query('UPDATE practice SET canceled_at = NULL, cancel_reason = NULL, cancel_note = NULL, canceled_by = NULL WHERE id = $1', [p.id]);
        await notifyTeam(
          p.team_id,
          user.id,
          `Practice is back on: ${prettyDay(p.date)}`,
          `The practice on ${prettyDay(p.date)} is happening after all.`,
          `practice:${p.id}`,
        ).catch(() => undefined);
        return { status: 200, jsonBody: { ok: true } };
      }
      // Rain, heat and lightning from older apps count as weather.
      const reason = cancelReasonOf(b.reason) ?? 'other';
      const note = clip(b.note, 300) || null;
      await query(
        'UPDATE practice SET canceled_at = now(), cancel_reason = $2, cancel_note = $3, canceled_by = $4 WHERE id = $1',
        [p.id, reason, note, user.id],
      );
      await notifyTeam(
        p.team_id,
        user.id,
        `Practice cancelled: ${prettyDay(p.date)}`,
        `Reason: ${REASON_LABEL[reason]}.${note ? ` ${note}` : ''}`,
        `practice:${p.id}`,
      ).catch(() => undefined);
      return { status: 200, jsonBody: { ok: true } };
    }

    const playerId = clip(b.playerId, 36);
    const player = await queryOne<{ id: string }>('SELECT id FROM player WHERE id = $1 AND team_id = $2 AND active', [playerId, p.team_id]);
    if (!player) return FORBIDDEN;

    if (action === 'checkin') {
      const guard = await guardTeam(user, p.team_id, 'team.view');
      if (!guard.ok) return guard.response;
      if (guard.team.archived) return TEAM_ARCHIVED;
      if (!(guard.ctx.guardianOf ?? []).includes(playerId)) return FORBIDDEN;
      const status = b.status === 'present' || b.status === 'absent' ? b.status : null;
      if (!status) return { status: 400, jsonBody: { error: 'Choose going or not going.' } };
      if (p.canceled_at) return { status: 409, jsonBody: { error: 'This practice is cancelled.', code: 'PRACTICE_CANCELED' } };
      if (!p.open) {
        return { status: 409, jsonBody: { error: 'Check-in closed when this practice started.', code: 'CHECKIN_CLOSED' } };
      }
      // Not going: sick, injured or other (with an optional comment).
      const why = status === 'absent' ? cleanRsvpReason(b.reason, b.note) : { reason: null, note: null };
      await setAttendance(p, playerId, status, user.id, why);
      return { status: 200, jsonBody: { ok: true, status, reason: why.reason } };
    }

    if (action === 'mark') {
      const guard = await guardTeam(user, p.team_id, 'team.view');
      if (!guard.ok) return guard.response;
      if (guard.team.archived) return TEAM_ARCHIVED;
      const staff =
        canOnTeam(guard.ctx, guard.team, 'attendance.edit').allowed || guard.role === 'team_parent';
      if (!staff) return FORBIDDEN;
      const denied = await enforceFeature(user.id, 'manualAttendance');
      if (denied) return { status: denied.status, jsonBody: denied.body };
      const status = ['present', 'absent', 'excused', 'late'].includes(String(b.status)) ? String(b.status) : null;
      if (!status) return { status: 400, jsonBody: { error: 'Choose present, absent, excused or late.' } };
      await setAttendance(p, playerId, status, user.id);
      return { status: 200, jsonBody: { ok: true, status } };
    }

    return { status: 400, jsonBody: { error: 'Unknown action.' } };
  } catch (err) {
    ctx.error('practices failed', err);
    return { status: 500, jsonBody: { error: 'Internal error' } };
  }
}

app.http('practices', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'practices',
  handler: practicesHandler,
});
