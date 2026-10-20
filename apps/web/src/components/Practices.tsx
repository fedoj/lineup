import { useCallback, useEffect, useState } from 'react';
import { api, type Practice, type Practices as Data } from '../lib/api';
import { nameWithReason } from '@lineup/shared';
import { PaidLock } from '../lib/features';
import MapLink from './MapLink';
import LocationInput from './LocationInput';
import { AddToCalendar, RsvpButton } from './Rsvp';
import RsvpTally, { TallyNamesPanel } from './RsvpTally';
import { DateTile } from './DateTile';

/** Minutes between two HH:MM times, for the calendar entry; 90 by default. */
function durationOf(start: string | null, end: string | null): number {
  if (!start || !end) return 90;
  const [a, b] = start.split(':').map(Number);
  const [c, d] = end.split(':').map(Number);
  const m = c * 60 + d - (a * 60 + b);
  return m > 0 ? m : 90;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function prettyTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const GOING = new Set(['present', 'late']);
const NOT_GOING = new Set(['absent', 'excused']);

/** Colour of each attendance mark, matching the going / not going counts. */
const MARK_TONE = { present: 'going', absent: 'out', late: 'late', excused: 'none' } as const;

/**
 * Practices on a team's calendar: the schedule (coaches), RSVP (parents, as
 * soon as a practice is scheduled until it starts), cancellations for weather
 * or an emergency, and attendance. The Calendar passes its own copy of the
 * practices (data, onChanged) so both stay in step; on its own it loads them.
 */
export default function Practices({
  teamId,
  data: given,
  onChanged,
}: {
  teamId: string;
  data?: Data | null;
  onChanged?: () => void;
}) {
  const [own, setData] = useState<Data | null>(null);
  const data = given !== undefined ? given : own;
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    if (onChanged) {
      onChanged();
      return;
    }
    api
      .practices(teamId)
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load practices.'));
  }, [teamId, onChanged]);
  useEffect(() => {
    if (given === undefined) load();
    // Loaded once on its own; the Calendar reloads its copy itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <section className="card err">{error}</section> : null;
  const hasChildren = data.practices.some((p) => p.children.length > 0);
  if (!data.canSchedule && !data.canSeeSummary && !hasChildren && data.practices.length === 0) return null;

  const today = localIso(new Date());
  const upcoming = data.practices.filter((p) => p.date >= today);
  const recent = data.practices.filter((p) => p.date < today).reverse();
  const shown = showAll ? upcoming : upcoming.slice(0, 6);

  return (
    <section className="card practices" id="cal-practices">
      <div className="card-head">
        <h2>Practices</h2>
        {data.canSchedule && !scheduling && (
          <button type="button" className="btn btn-sm" onClick={() => setScheduling(true)}>
            ＋ Practice schedule
          </button>
        )}
      </div>
      {msg && <p className="note" role="status">{msg}</p>}
      {error && <p className="danger-text">{error}</p>}

      {scheduling && (
        <ScheduleForm
          data={data}
          busy={busy}
          onCancel={() => setScheduling(false)}
          onSave={(b) =>
            act(async () => {
              const r = await api.practiceAction({ action: 'schedule', teamId, ...b });
              setScheduling(false);
              setMsg(`${r.practices ?? 0} practices added. The team has been notified.`);
            })
          }
        />
      )}

      {hasChildren && (
        <p className="note">
          Let the coach know if your child is coming. Check-in is open as soon as a practice is on the schedule, until
          it starts.
        </p>
      )}

      {upcoming.length === 0 ? (
        <p className="note">
          No upcoming practices.{data.canSchedule ? ' Set a practice schedule and they show here and on the calendar.' : ''}
        </p>
      ) : (
        <ul className="checkin-list">
          {shown.map((p) => (
            <PracticeRow
              key={p.id}
              p={p}
              data={data}
              busy={busy}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
              cancelling={cancelFor === p.id}
              setCancelling={(v) => setCancelFor(v ? p.id : null)}
              act={act}
              teamId={teamId}
              onSaved={load}
            />
          ))}
        </ul>
      )}
      {upcoming.length > 6 && (
        <button type="button" className="linkish" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${upcoming.length} upcoming practices`}
        </button>
      )}

      {data.canSeeSummary && recent.length > 0 && (
        <details className="practice-recent">
          <summary>Last week's practices ({recent.length})</summary>
          <ul className="checkin-list">
            {recent.map((p) => (
              <PracticeRow
                key={p.id}
                p={p}
                data={data}
                busy={busy}
                open={openId === p.id}
                onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                cancelling={false}
                setCancelling={() => undefined}
                act={act}
                teamId={teamId}
                onSaved={load}
                past
              />
            ))}
          </ul>
        </details>
      )}

      {data.canSchedule && data.series.length > 0 && (
        <div className="practice-series">
          <h3 className="group-title">Practice schedules</h3>
          {data.series.map((s) => (
            <div key={s.id} className="checkin-child">
              <span>
                {s.days.map((d) => DAY_NAMES[d]).join(', ')} · {prettyTime(s.startTime)}
                {s.endTime ? `–${prettyTime(s.endTime)}` : ''} · {prettyDate(s.startsOn)} to {prettyDate(s.endsOn)}
                {s.location && (
                  <>
                    {' · '}
                    <MapLink place={s.location} />
                  </>
                )}
              </span>
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Remove the ${s.upcoming} upcoming practices in this schedule? Past practices keep their attendance.`)) {
                    void act(() => api.practiceAction({ action: 'removeSchedule', seriesId: s.id }), 'Upcoming practices removed.');
                  }
                }}
              >
                Remove upcoming
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One practice as a calendar card: when and where, RSVP and "add to my
 * calendar", who is coming (staff see names and can mark attendance on a
 * paid plan), and for coaches cancel, undo or delete.
 */
export function PracticeRow({
  p,
  data,
  busy,
  open,
  onToggle,
  cancelling,
  setCancelling,
  act,
  teamId,
  onSaved,
  past = false,
}: {
  p: Practice;
  data: Data;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  cancelling: boolean;
  setCancelling: (v: boolean) => void;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
  teamId: string;
  onSaved: () => void;
  past?: boolean;
}) {
  const [reason, setReason] = useState('weather');
  const [note, setNote] = useState('');
  const going = p.attendance.filter((a) => a.status && GOING.has(a.status));
  const notGoing = p.attendance.filter((a) => a.status && NOT_GOING.has(a.status));
  const noAnswer = p.attendance.filter((a) => !a.status);

  return (
    <li className={`fixture practice-item${p.canceled ? ' canceled' : ''}`} id={`item-practice-${p.id}`}>
      <div className="fixture-when">
        <DateTile date={p.date} />
        <strong>{prettyDate(p.date)}</strong>
        {p.startTime && (
          <span>
            {prettyTime(p.startTime)}
            {p.endTime ? `–${prettyTime(p.endTime)}` : ''}
          </span>
        )}
      </div>
      <div className="fixture-what">
      <div className="fixture-teams">
        <span aria-hidden="true">🏃</span>
        <span>Practice</span>
        {p.canceled && <span className="pill bad small">Cancelled: {p.cancelLabel}</span>}
      </div>
      {p.location && (
        <div className="sub">
          <MapLink place={p.location} />
        </div>
      )}
      {p.canceled && p.cancelNote && <p className="note">{p.cancelNote}</p>}

      {/* One RSVP button and "add to my calendar", nothing else. */}
      {!p.canceled && !past && p.open && (
        <div className="row item-actions">
          <RsvpButton kind="practice" itemId={p.id} teamId={teamId} kids={p.children} onSaved={onSaved} />
          <AddToCalendar
            uid={`practice-${p.id}`}
            title="Practice"
            date={p.date}
            time={p.startTime}
            durationMinutes={durationOf(p.startTime, p.endTime)}
            location={p.location}
          />
        </div>
      )}
      {!p.canceled && (past || !p.open) && p.children.some((c) => c.status) && (
        <div className="sub">
          {p.children
            .map((c) => `${c.name}: ${c.status ? (GOING.has(c.status) ? 'going' : 'not going') : 'no answer'}`)
            .join(' · ')}
        </div>
      )}

      {!data.canSeeSummary && !p.canceled && p.counts && <RsvpTally counts={p.counts} />}

      {data.canSeeSummary && !p.canceled && (
        <RsvpTally
          counts={{ going: going.length, notGoing: notGoing.length, noAnswer: noAnswer.length }}
          open={open}
          onToggle={onToggle}
        >
          <div className="practice-attendance">
            {data.canMarkAttendance ? (
              p.attendance.map((a) => (
                <div className="checkin-child" key={a.playerId}>
                  <span className="person-name">{a.name}</span>
                  <span className="rsvp-choice" role="group" aria-label={`${a.name}: attendance`}>
                    {(['present', 'absent', 'late', 'excused'] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`rsvp-opt ${MARK_TONE[s]}${a.status === s ? ' on' : ''}`}
                        aria-pressed={a.status === s}
                        disabled={busy}
                        onClick={() => act(() => api.practiceAction({ action: 'mark', practiceId: p.id, playerId: a.playerId, status: s }))}
                      >
                        {s === 'present' ? 'Here' : s === 'absent' ? 'Absent' : s === 'late' ? 'Late' : 'Excused'}
                      </button>
                    ))}
                  </span>
                </div>
              ))
            ) : (
              <>
                <TallyNamesPanel
                  names={{
                    going: going.map((a) => a.name),
                    notGoing: notGoing.map((a) => nameWithReason(a.name, a.reason, a.note)),
                    noAnswer: noAnswer.map((a) => a.name),
                  }}
                />
                {!data.manualAttendancePaid && <PaidLock feature="manualAttendance" what="Manual attendance" />}
              </>
            )}
          </div>
        </RsvpTally>
      )}

      {data.canSchedule && !past && (
        <div className="row fixture-actions">
          {p.canceled ? (
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() => act(() => api.practiceAction({ action: 'restore', practiceId: p.id }), 'Practice is back on. The team has been told.')}
            >
              Undo cancel
            </button>
          ) : cancelling ? (
            <div className="row">
              <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
                {data.reasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <input
                value={note}
                maxLength={300}
                placeholder="Note for the team (optional)"
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm danger"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api.practiceAction({ action: 'cancel', practiceId: p.id, reason, note: note.trim() || undefined });
                    setCancelling(false);
                    setNote('');
                  }, 'Practice cancelled. The team has been told.')
                }
              >
                Cancel practice
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => setCancelling(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <>
              <button type="button" className="btn ghost btn-sm" onClick={() => setCancelling(true)}>
                Cancel…
              </button>
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Delete this practice from the calendar?')) {
                    void act(() => api.practiceAction({ action: 'delete', practiceId: p.id }), 'Practice deleted.');
                  }
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
      </div>
    </li>
  );
}

export function ScheduleForm({
  data,
  busy,
  onCancel,
  onSave,
}: {
  data: Data;
  busy: boolean;
  onCancel: () => void;
  onSave: (b: {
    days: number[];
    startTime: string;
    endTime?: string;
    location?: string;
    startsOn: string;
    endsOn: string;
    timezone: string;
  }) => void;
}) {
  const now = new Date();
  const [days, setDays] = useState<number[]>([2, 4]);
  const [startTime, setStartTime] = useState('17:30');
  const [endTime, setEndTime] = useState('19:00');
  const [location, setLocation] = useState('');
  const [startsOn, setStartsOn] = useState(localIso(now));
  const [endsOn, setEndsOn] = useState(localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 90)));
  const length =
    startsOn && endsOn
      ? Math.round((new Date(`${endsOn}T00:00:00`).getTime() - new Date(`${startsOn}T00:00:00`).getTime()) / 86_400_000) + 1
      : 0;
  const tooLong = length > data.freeDays && !data.extendedPractice;

  return (
    <div className="practice-form">
      <div className="day-picks" role="group" aria-label="Practice days">
        {DAY_NAMES.map((name, i) => (
          <label key={name} className={`chip${days.includes(i) ? ' on' : ''}`}>
            <input
              type="checkbox"
              checked={days.includes(i)}
              onChange={(e) => setDays((d) => (e.target.checked ? [...d, i].sort() : d.filter((x) => x !== i)))}
            />
            {name}
          </label>
        ))}
      </div>
      <div className="field-grid">
        <label>
          Starts
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>
        <label>
          Ends (optional)
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </label>
        <label>
          From
          <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
        <label>
          Location (optional)
          <LocationInput value={location} onChange={setLocation} label="Location" placeholder="e.g. Central Park field 2" />
        </label>
      </div>
      <p className={tooLong ? 'note warn' : 'note'}>
        {length > 0 ? `${length} days. ` : ''}
        The free plan schedules up to {data.freeDays} days of practices at a time
        {data.extendedPractice ? '; your plan allows longer.' : '. Longer seasons are a paid feature.'}
      </p>
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy || days.length === 0 || !startTime || !startsOn || !endsOn || tooLong}
          onClick={() =>
            onSave({
              days,
              startTime,
              endTime: endTime || undefined,
              location: location.trim() || undefined,
              startsOn,
              endsOn,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            })
          }
        >
          Add practices
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
