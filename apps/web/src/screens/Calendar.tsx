import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CANCEL_REASONS, buildIcsCalendar, type Game, type IcsEvent } from '@lineup/shared';
import GameDetails from './GameDetails';
import {
  api,
  type Calendar as Cal,
  type CalendarEntry,
  type FriendlyOpponent,
  type RefereePerson,
  type RefereeSlot,
  type Practice,
  type SnackSlot,
  type StandingsScope,
  type TeamEvent,
  type TeamLife,
} from '../lib/api';
import { PaidLock, useFeature } from '../lib/features';
import { fileSlug, shareFile } from '../lib/shareFile';
import { EventRow, SnackSchedule, TeamEvents, eventIcon } from '../components/TeamLife';
import GameCheckins from '../components/GameCheckins';
import Practices from '../components/Practices';
import MapLink from '../components/MapLink';
import LocationInput from '../components/LocationInput';
import { useRegionFields } from '../components/RegionFields';
import { DateTile } from '../components/DateTile';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A game is upcoming when its date is today or later. An undated game counts
 * as upcoming only until it has a score, so a played friendly with no date
 * does not sit at the top of the list forever.
 */
export function isUpcoming(e: { date: string | null; score: unknown }, today: string): boolean {
  return e.date ? e.date >= today : !e.score;
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function prettyDate(iso: string | null): string {
  if (!iso) return 'Date TBD';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function prettyTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Games for an organization, a region or one team. What appears follows the
 * scope picked in the menu: an org shows every region's games, a region its
 * teams' games, a team only its own. List view is the default.
 */
export default function Calendar({
  scope,
  id,
  onOpenGame,
}: {
  scope: StandingsScope;
  id: string;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  const [data, setData] = useState<Cal | null>(null);
  const [life, setLife] = useState<TeamLife | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'month'>('list');
  const [busy, setBusy] = useState(false);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cal, teamLife] = await Promise.all([
        api.calendar(scope, id),
        // Events (and a team's snacks) must not hide the game calendar if
        // they fail to load.
        scope === 'team'
          ? api.teamLife(id).catch(() => null)
          : api.scopeLife(scope, id).catch(() => null),
      ]);
      setData(cal);
      setLife(teamLife);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the calendar');
    }
  }, [scope, id]);

  useEffect(() => {
    setData(null);
    setLife(null);
    setError(null);
    setMsg(null);
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <section className={error ? 'card err' : 'card'}>{error ?? 'Loading…'}</section>;
  }

  const today = localToday();
  const upcoming = data.entries.filter((e) => isUpcoming(e, today));
  const past = data.entries.filter((e) => !isUpcoming(e, today)).reverse();

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {error && <section className="card err">{error}</section>}

      {scope === 'team' && <GameCheckins key={id} teamId={id} />}
      {scope === 'team' && <Practices key={`p-${id}`} teamId={id} />}

      <section className="card">
        <div className="card-head">
          <h2>
            {data.title} · Calendar
          </h2>
          <div className="seg" role="tablist" aria-label="Calendar view">
            <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
              List
            </button>
            <button type="button" className={view === 'month' ? 'on' : ''} onClick={() => setView('month')}>
              Calendar
            </button>
          </div>
        </div>

        {view === 'list' ? (
          <>
            {upcoming.length === 0 ? (
              <p className="note">No upcoming games.</p>
            ) : (
              <ul className="fixtures">
                {upcoming.map((e) => (
                  <FixtureRow key={e.id} e={e} busy={busy} run={run} onOpenGame={onOpenGame} refPool={e.orgId ? data.refereePools?.[e.orgId] : undefined} />
                ))}
              </ul>
            )}
            {past.length > 0 && (
              <>
                <button type="button" className="linkish" onClick={() => setShowPast((v) => !v)}>
                  {showPast ? 'Hide' : 'Show'} past games ({past.length})
                </button>
                {showPast && (
                  <ul className="fixtures past">
                    {past.map((e) => (
                      <FixtureRow key={e.id} e={e} busy={busy} run={run} onOpenGame={onOpenGame} refPool={e.orgId ? data.refereePools?.[e.orgId] : undefined} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        ) : (
          <MonthView
            entries={data.entries}
            events={life?.events ?? []}
            life={life}
            teamId={scope === 'team' ? id : undefined}
            busy={busy}
            run={run}
            onOpenGame={onOpenGame}
          />
        )}
      </section>

      {scope !== 'team' && data.canSchedule && (
        <section className="card">
          <p className="note">To schedule a game, open the Games &amp; matches tab and the league or tournament it belongs to.</p>
        </section>
      )}

      {life && scope === 'team' && <TeamEvents teamId={id} life={life} busy={busy} run={run} />}
      {life && scope !== 'team' && (
        <TeamEvents scope={{ kind: scope, id }} life={life} busy={busy} run={run} />
      )}
      {life && scope === 'team' && <SnackSchedule teamId={id} life={life} busy={busy} run={run} />}

      {data.canAddFriendly && scope === 'team' && (
        <FriendlyForm
          teamId={id}
          allowGame={false}
          canSetAssistantFree={Boolean(data.canApproveLineups)}
          busy={busy}
          run={run}
        />
      )}

      {data.canShare && (
        <SharePanel
          title={data.title}
          items={[
            ...upcoming
              .filter((e) => e.date && !e.canceled)
              .map((e) => ({
                uid: `game-${e.id}`,
                title: `${e.home.name} v ${e.away.name}`,
                date: e.date!,
                time: e.kickoff,
                durationMinutes: 90,
                location: [e.location, e.field ? `Field ${e.field}` : null].filter(Boolean).join(', ') || null,
              })),
            ...(life?.events ?? [])
              .filter((ev) => ev.date >= today && !ev.restricted)
              .map((ev) => ({
                uid: `event-${ev.id}`,
                title: ev.title,
                date: ev.date,
                time: ev.startTime,
                durationMinutes: 120,
                location: ev.location,
              })),
          ]}
        />
      )}
    </>
  );
}

/**
 * Share this calendar as a calendar file (Fady, 10/19): the upcoming games
 * (and a team's events) in one .ics file that people add to Google, Apple or
 * Outlook calendar. Made on the phone and handed to the share sheet or
 * downloaded; there is no link and nothing is kept on Lineup. Players are
 * never in it. A premium feature (sharing).
 */
export function SharePanel({ title, items }: { title: string; items: IcsEvent[] }) {
  const allowed = useFeature('longShareLinks');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function share(download: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const blob = new Blob([buildIcsCalendar(items)], { type: 'text/calendar' });
      const out = await shareFile(blob, `${fileSlug(title)}-calendar.ics`, `${title} calendar`, download);
      setMsg(out === 'downloaded' ? 'Saved the calendar file. Send it, or open it to add the games to a calendar.' : out === 'shared' ? 'Shared.' : null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not make the calendar file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Share this calendar</h2>
      {!allowed ? (
        <PaidLock feature="longShareLinks" what="Sharing the calendar" />
      ) : (
        <>
          <p className="note">
            Sends the {items.length} upcoming {items.length === 1 ? 'item' : 'games and events'} as a calendar file that
            anyone can add to Google, Apple or Outlook calendar. Players are never included, and nothing is kept on
            Lineup. Share again after changes.
          </p>
          <div className="row">
            <button type="button" className="btn" disabled={busy || items.length === 0} onClick={() => void share(false)}>
              Share calendar file…
            </button>
            <button type="button" className="btn ghost" disabled={busy || items.length === 0} onClick={() => void share(true)}>
              Download
            </button>
          </div>
          {items.length === 0 && <p className="note">Nothing upcoming to share yet.</p>}
          {msg && (
            <p className="note" role="status">
              {msg}
            </p>
          )}
        </>
      )}
    </section>
  );
}
export function FixtureRow({
  e,
  busy,
  run,
  onOpenGame,
  domId,
  extra,
  refPool,
}: {
  e: CalendarEntry;
  busy: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  onOpenGame: (teamId: string, gameId: string) => void;
  /** Element id, so a notification can scroll straight to this game. */
  domId?: string;
  /** RSVP, add to calendar and who is coming, on a team's own calendar. */
  extra?: ReactNode;
  /** The organization's referees, for staff who fill this game's spots. */
  refPool?: RefereePerson[];
}) {
  const [editing, setEditing] = useState(false);
  const [gameEdit, setGameEdit] = useState<Game | null>(null);
  const [date, setDate] = useState(e.date ?? '');
  const [kickoff, setKickoff] = useState(e.kickoff ?? '');
  const [location, setLocation] = useState(e.location ?? '');
  const [field, setField] = useState(e.field ?? '');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('weather');
  const [note, setNote] = useState('');
  // A league game is cancelled as a whole; a team's own game by its id.
  const cancelTarget = e.fixtureId ? { fixtureId: e.fixtureId } : e.links[0] ? { gameId: e.links[0].gameId } : null;
  const upcoming = !e.date || e.date >= localToday();

  return (
    <li className={`fixture${e.canceled ? ' canceled' : ''}`} id={domId}>
      <div className="fixture-when">
        <DateTile date={e.date} />
        <strong>{prettyDate(e.date)}</strong>
        {e.kickoff && <span>{prettyTime(e.kickoff)}</span>}
      </div>
      <div className="fixture-what">
        <div className="fixture-teams">
          <span>{e.home.name}</span>
          {e.score ? (
            <span className="fixture-score">
              {e.score.home} – {e.score.away}
            </span>
          ) : (
            <span className="fixture-vs">vs</span>
          )}
          <span>{e.away.name}</span>
          {e.league ? (
            <span className="pill-league">League</span>
          ) : e.friendly === false ? (
            <span className="pill-league">Game</span>
          ) : (
            <span className="pill-friendly">Friendly</span>
          )}
          {e.canceled && <span className="pill bad small">Cancelled: {e.cancelLabel ?? 'Cancelled'}</span>}
          {e.competition && (
            <span className="pill-comp" title={e.competition.kind === 'tournament' ? 'Tournament' : 'League'}>
              {e.competition.kind === 'tournament' ? '🏆' : '📅'} {e.competition.name}
            </span>
          )}
          {e.official && e.score && (
            <span className="pill-league" title="The referee submitted this score. It counts in the standings.">
              Official
            </span>
          )}
        </div>
        {e.canceled && e.cancelNote && <p className="note">{e.cancelNote}</p>}
        {(e.location || e.field) && (
          <div className="sub">
            {e.location && <MapLink place={e.location} />}
            {e.location && e.field ? ' · ' : ''}
            {e.field ? `Field ${e.field}` : ''}
            {e.fieldMapId && (
              <>
                {' · '}
                <a href={`/api/region-fields/map?id=${encodeURIComponent(e.fieldMapId)}`} target="_blank" rel="noopener noreferrer">
                  🗺️ Field map
                </a>
              </>
            )}
          </div>
        )}
        {e.referees && <FixtureRefs e={e} pool={refPool} busy={busy} run={run} />}
        {!e.canceled && extra}
        <div className="row fixture-actions">
          {e.canCancel && cancelTarget && upcoming && !e.canceled && !cancelling && (
            <button type="button" className="btn ghost btn-sm" onClick={() => setCancelling(true)}>
              Cancel game
            </button>
          )}
          {e.canCancel && cancelTarget && e.canceled && (
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() => void run(() => api.cancelGame({ ...cancelTarget, action: 'restore' }), 'Game is back on. The team has been told.')}
            >
              Undo cancel
            </button>
          )}
          {e.links.map((l) => (
            <button
              key={l.gameId}
              type="button"
              className="btn ghost btn-sm"
              onClick={() => onOpenGame(l.teamId, l.gameId)}
            >
              Match day{e.links.length > 1 ? ` · ${l.teamName}` : ''}
            </button>
          ))}
          {e.canOpenRefMatch && e.fixtureId && !e.canceled && (
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={() => window.dispatchEvent(new CustomEvent('lineup:open', { detail: `/referee?match=${e.fixtureId}` }))}
            >
              🟨 Referee report
            </button>
          )}
          {e.canEdit && !e.fixtureId && e.links[0] && !gameEdit && (
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={async () => {
                const l = e.links[0];
                const all = await api.listGames(l.teamId);
                setGameEdit(all.find((g) => g.id === l.gameId) ?? null);
              }}
            >
              Edit
            </button>
          )}
          {e.canManage && e.fixtureId && !editing && (
            <>
              <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Remove ${e.home.name} vs ${e.away.name} from both teams?`)) {
                    void run(() => api.deleteFixture(e.fixtureId!), 'Game removed from both teams.');
                  }
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
        {cancelling && cancelTarget && (
          <div className="field-grid fixture-edit">
            <label>
              Reason
              <select value={reason} onChange={(x) => setReason(x.target.value)}>
                {CANCEL_REASONS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Note (optional)
              <input value={note} maxLength={300} placeholder="e.g. Fields closed after the storm" onChange={(x) => setNote(x.target.value)} />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.cancelGame({ ...cancelTarget, action: 'cancel', reason, note: note.trim() || undefined }),
                    e.fixtureId ? 'Game cancelled for both teams. Everyone has been told.' : 'Game cancelled. The team has been told.',
                  ).then(() => setCancelling(false))
                }
              >
                Cancel this game
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => setCancelling(false)}>
                Keep it
              </button>
            </div>
          </div>
        )}
        {editing && e.fixtureId && (
          <div className="field-grid fixture-edit">
            <label>
              Date
              <input type="date" value={date} onChange={(x) => setDate(x.target.value)} />
            </label>
            <label>
              Kick-off
              <input type="time" value={kickoff} onChange={(x) => setKickoff(x.target.value)} />
            </label>
            <label>
              Location
              <LocationInput value={location} onChange={setLocation} label="Location" />
            </label>
            <label>
              Field
              <input value={field} maxLength={40} onChange={(x) => setField(x.target.value)} />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !date}
                onClick={() =>
                  run(
                    () =>
                      api.updateFixture({ id: e.fixtureId!, date, kickoff, location, field }),
                    'Game updated for both teams.',
                  ).then(() => setEditing(false))
                }
              >
                Save
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {gameEdit && (
          <GameDetails
            game={gameEdit}
            canEdit
            onSaved={() => void run(async () => undefined, 'Game updated.')}
            onClose={() => setGameEdit(null)}
          />
        )}
      </div>
    </li>
  );
}

const REF_SLOTS: Array<[RefereeSlot, string]> = [
  ['main', 'Main referee'],
  ['ar1', 'Assistant referee 1'],
  ['ar2', 'Assistant referee 2'],
];

/**
 * Who referees a league game. The staff who schedule it can change any spot,
 * picking from the organization's referees; the referee is told.
 */
function FixtureRefs({
  e,
  pool,
  busy,
  run,
}: {
  e: CalendarEntry;
  pool?: RefereePerson[];
  busy: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const r = e.referees!;
  const who = (s: RefereeSlot) => r[s]?.name ?? <em>open</em>;
  const canChange = e.canManage && Boolean(e.fixtureId) && pool !== undefined;
  return (
    <div className="ref-line">
      <div className="sub">
        🟨 Ref: {who('main')} · Assistants: {who('ar1')}, {who('ar2')}
        {canChange && (
          <>
            {' '}
            <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>
              {open ? 'Done' : 'Change'}
            </button>
          </>
        )}
      </div>
      {open && canChange && (
        <div className="field-grid fixture-edit">
          {REF_SLOTS.map(([s, label]) => {
            const current = r[s];
            return (
              <label key={s}>
                {label}
                <select
                  value={current?.userId ?? ''}
                  disabled={busy}
                  onChange={(x) => {
                    const userId = x.target.value;
                    void run(
                      () =>
                        userId
                          ? api.refereeStaffAction({ action: 'assign', fixtureId: e.fixtureId!, slot: s, userId })
                          : api.refereeStaffAction({ action: 'unassign', fixtureId: e.fixtureId!, slot: s }),
                      userId ? 'Referee saved. They have been told.' : 'That spot is open again.',
                    );
                  }}
                >
                  <option value="">Open</option>
                  {current?.userId && !pool!.some((p) => p.userId === current.userId) && (
                    <option value={current.userId}>{current.name}</option>
                  )}
                  {pool!.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {pool!.length === 0 && (
            <p className="note">No referees yet. Turn on referee sign-up in Settings and share the code.</p>
          )}
        </div>
      )}
    </div>
  );
}

export function MonthView({
  entries,
  events,
  life,
  teamId,
  busy,
  run,
  onOpenGame,
  practices = [],
  snacks = [],
  renderEntry,
  renderPractice,
  renderSnack,
}: {
  entries: CalendarEntry[];
  events: TeamEvent[];
  life: TeamLife | null;
  /** The team whose calendar this is, for event check-ins. */
  teamId?: string;
  busy: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  onOpenGame: (teamId: string, gameId: string) => void;
  /** A team's practices and snack schedule, when those boxes are ticked. */
  practices?: Practice[];
  snacks?: SnackSlot[];
  renderEntry?: (e: CalendarEntry) => ReactNode;
  renderPractice?: (p: Practice) => ReactNode;
  renderSnack?: (s: SnackSlot) => ReactNode;
}) {
  const today = localToday();
  const [cursor, setCursor] = useState(() => {
    const [y, m] = today.split('-').map(Number);
    return { y, m: m - 1 };
  });
  const [picked, setPicked] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      if (!e.date) continue;
      map.set(e.date, [...(map.get(e.date) ?? []), e]);
    }
    return map;
  }, [entries]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, TeamEvent[]>();
    for (const e of events) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [events]);

  const practicesByDay = useMemo(() => {
    const map = new Map<string, Practice[]>();
    for (const p of practices) map.set(p.date, [...(map.get(p.date) ?? []), p]);
    return map;
  }, [practices]);

  const snacksByDay = useMemo(() => {
    const map = new Map<string, SnackSlot[]>();
    for (const s of snacks) if (s.date) map.set(s.date, [...(map.get(s.date) ?? []), s]);
    return map;
  }, [snacks]);

  const first = new Date(cursor.y, cursor.m, 1);
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: Array<string | null> = [
    ...Array.from({ length: first.getDay() }, () => null),
    ...Array.from(
      { length: daysInMonth },
      (_, i) => `${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
    ),
  ];

  const shift = (delta: number) => {
    setPicked(null);
    setCursor((c) => {
      const d = new Date(c.y, c.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  };

  const pickedEntries = picked ? byDay.get(picked) ?? [] : [];
  const pickedEvents = picked ? eventsByDay.get(picked) ?? [] : [];
  const pickedPractices = picked ? practicesByDay.get(picked) ?? [] : [];
  const pickedSnacks = picked ? snacksByDay.get(picked) ?? [] : [];

  return (
    <>
      <div className="month-head">
        <button type="button" className="btn ghost btn-sm" onClick={() => shift(-1)} aria-label="Previous month">
          ‹
        </button>
        <strong>{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button type="button" className="btn ghost btn-sm" onClick={() => shift(1)} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="month-grid">
        {WEEKDAYS.map((d) => (
          <div key={d} className="month-dow">
            {d}
          </div>
        ))}
        {cells.map((iso, i) => {
          if (!iso) return <div key={`blank-${i}`} className="month-cell blank" />;
          const games = byDay.get(iso) ?? [];
          const dayEvents = eventsByDay.get(iso) ?? [];
          const dayPractices = (practicesByDay.get(iso) ?? []).filter((p) => !p.canceled);
          const daySnacks = snacksByDay.get(iso) ?? [];
          // Up to two lines per day, events first, then games, practices, snacks.
          const lines: ReactNode[] = [
            ...dayEvents.map((ev) => (
              <span key={`e-${ev.id}`} className="month-game month-event">
                {eventIcon(ev.kind)} {ev.title}
              </span>
            )),
            ...games.map((g) => (
              <span key={`g-${g.id}`} className={`month-game${g.canceled ? ' month-canceled' : ''}`}>
                {g.canceled ? 'Cancelled · ' : g.kickoff ? `${prettyTime(g.kickoff)} ` : ''}
                {g.home.name} v {g.away.name}
              </span>
            )),
            ...dayPractices.map((p) => (
              <span key={`p-${p.id}`} className="month-game month-practice">
                🏃 {p.startTime ? `${prettyTime(p.startTime)} ` : ''}Practice
              </span>
            )),
            ...daySnacks.map((s) => (
              <span key={`s-${s.gameId}`} className="month-game month-snack">
                🍊 {s.playerName ? `${s.playerName}'s family` : s.family || 'Snacks needed'}
              </span>
            )),
          ];
          return (
            <button
              key={iso}
              type="button"
              className={`month-cell ${iso === today ? 'today' : ''} ${iso === picked ? 'on' : ''} ${lines.length ? 'has' : ''}`}
              onClick={() => setPicked(iso === picked ? null : iso)}
            >
              <span className="month-day">{Number(iso.slice(8))}</span>
              {lines.slice(0, 2)}
              {lines.length > 2 && <span className="month-more">+{lines.length - 2} more</span>}
            </button>
          );
        })}
      </div>
      {picked && (
        <>
          <h3 className="month-picked">{prettyDate(picked)}</h3>
          {pickedEntries.length + pickedEvents.length + pickedPractices.length + pickedSnacks.length === 0 ? (
            <p className="note">Nothing on this day.</p>
          ) : (
            <ul className="fixtures">
              {life &&
                pickedEvents.map((ev) => <EventRow key={ev.id} e={ev} life={life} teamId={teamId} busy={busy} run={run} />)}
              {pickedEntries.map((e) =>
                renderEntry ? (
                  renderEntry(e)
                ) : (
                  <FixtureRow key={e.id} e={e} busy={busy} run={run} onOpenGame={onOpenGame} />
                ),
              )}
              {renderPractice && pickedPractices.map((p) => renderPractice(p))}
              {renderSnack && pickedSnacks.map((s) => renderSnack(s))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

/**
 * A coach adds their own game. On a team inside an organization or region
 * that is always a friendly (league games come from the top); a standalone
 * team can add regular games too.
 */
export function FriendlyForm({
  teamId,
  allowGame,
  busy,
  run,
  open: openProp,
  onClose,
  canSetAssistantFree = false,
}: {
  teamId: string;
  allowGame: boolean;
  busy: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  /** Opened from a "＋ Game" button elsewhere; closing hands back to it. */
  open?: boolean;
  onClose?: () => void;
  /** A coach decides whether the assistant changes this game's lineup without approval. */
  canSetAssistantFree?: boolean;
}) {
  const [kind, setKind] = useState<'friendly' | 'game'>(allowGame ? 'game' : 'friendly');
  const [opponent, setOpponent] = useState('');
  // Another Lineup team picked as the opponent ('' = type a name).
  const [opponentTeam, setOpponentTeam] = useState('');
  const [opponents, setOpponents] = useState<FriendlyOpponent[] | null>(null);
  const [date, setDate] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [isHome, setIsHome] = useState(true);
  const [location, setLocation] = useState('');
  const [field, setField] = useState('');
  const [assistantFree, setAssistantFree] = useState(false);
  const [openOwn, setOpenOwn] = useState(false);
  // The team's region fields, as quick picks for the location.
  const fields = useRegionFields(teamId ? { teamId } : null);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openOwn;
  const setOpen = (v: boolean) => (controlled ? !v && onClose?.() : setOpenOwn(v));
  const isGame = allowGame && kind === 'game';
  // Lineup teams this one can play a friendly against, once the form is open.
  useEffect(() => {
    if (!open || !teamId || opponents !== null) return;
    api
      .friendlyOpponents(teamId)
      .then((r) => setOpponents(r.opponents))
      .catch(() => setOpponents([]));
  }, [open, teamId, opponents]);
  const pickedTeam = !isGame && opponentTeam ? opponents?.find((o) => o.id === opponentTeam) ?? null : null;
  const groups = (() => {
    const out = new Map<string, FriendlyOpponent[]>();
    for (const o of opponents ?? []) {
      const g = o.mine ? 'Your teams' : o.regionName ? `${o.regionName}${o.orgName ? ` · ${o.orgName}` : ''}` : o.orgName ?? 'Other teams';
      out.set(g, [...(out.get(g) ?? []), o]);
    }
    return [...out.entries()];
  })();

  if (!open) {
    if (controlled) return null;
    return (
      <section className="card">
        <div className="card-head">
          <h2>{allowGame ? 'Games and friendlies' : 'Friendlies'}</h2>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            ＋ {allowGame ? 'Add a game' : 'Add a friendly'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{allowGame ? 'Add a game' : 'Add a friendly'}</h2>
        <button type="button" className="btn ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="note">
        {allowGame
          ? 'Your team is not part of an organization or region, so you schedule your own games and friendlies.'
          : 'Games for a league or tournament are scheduled inside it. Friendlies you add show on this team\u2019s calendar, match day and stats, but never count toward standings.'}
      </p>
      <div className="field-grid">
        {allowGame && (
          <label>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="game">Game</option>
              <option value="friendly">Friendly</option>
            </select>
          </label>
        )}
        {!isGame && (opponents?.length ?? 0) > 0 && (
          <label>
            Opponent team on Lineup
            <select value={opponentTeam} onChange={(e) => setOpponentTeam(e.target.value)}>
              <option value="">Not on Lineup: type the name</option>
              {groups.map(([g, list]) => (
                <optgroup key={g} label={g}>
                  {list.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        {!pickedTeam && (
          <label>
            Opponent
            <input value={opponent} maxLength={80} placeholder="e.g. Westside FC" onChange={(e) => setOpponent(e.target.value)} />
          </label>
        )}
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Kick-off
          <input type="time" value={kickoff} onChange={(e) => setKickoff(e.target.value)} />
        </label>
        <label>
          Venue
          <select value={isHome ? 'home' : 'away'} onChange={(e) => setIsHome(e.target.value === 'home')}>
            <option value="home">Home</option>
            <option value="away">Away</option>
          </select>
        </label>
        <label>
          Location
          <LocationInput value={location} onChange={setLocation} label="Location" placeholder="e.g. Central Park" presets={fields} />
        </label>
        <label>
          Field number (optional)
          <input value={field} maxLength={40} onChange={(e) => setField(e.target.value)} />
        </label>
      </div>
      {pickedTeam && (
        <p className="note">
          The friendly goes on {pickedTeam.name}’s calendar too. Their coach and families are told, and both teams can
          say who’s going. A change of date, time or place, the score, or calling it off, shows on both calendars.
        </p>
      )}
      {canSetAssistantFree && (
        <label className="check">
          <input type="checkbox" checked={assistantFree} onChange={(e) => setAssistantFree(e.target.checked)} /> Assistant
          coach can change the lineup without my approval
        </label>
      )}
      <button
        type="button"
        className="btn"
        disabled={busy || !(pickedTeam || opponent.trim()) || !date || !kickoff || !location.trim()}
        onClick={() =>
          run(async () => {
            await api.createFriendly({
              teamId,
              opponent: pickedTeam ? pickedTeam.name : opponent.trim(),
              opponentTeamId: pickedTeam?.id,
              date,
              kickoff: kickoff || undefined,
              isHome,
              location: location.trim() || undefined,
              field: field.trim() || undefined,
              kind: isGame ? 'game' : 'friendly',
              assistantFree: canSetAssistantFree && assistantFree ? true : undefined,
            });
            setOpponent('');
            setOpponentTeam('');
            setKickoff('');
            setField('');
            setAssistantFree(false);
            setOpen(false);
          }, isGame ? 'Game added.' : pickedTeam ? `Friendly added to both calendars. ${pickedTeam.name} has been told.` : 'Friendly added.')
        }
      >
        {isGame ? 'Add game' : 'Add friendly'}
      </button>
    </section>
  );
}

export function ScheduleForm({
  cal,
  busy,
  run,
  open: openProp,
  onClose,
}: {
  cal: Cal;
  busy: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  open?: boolean;
  onClose?: () => void;
}) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [date, setDate] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [location, setLocation] = useState('');
  const [field, setField] = useState('');
  const [openOwn, setOpenOwn] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : openOwn;
  const setOpen = (v: boolean) => (controlled ? !v && onClose?.() : setOpenOwn(v));

  const label = (t: Cal['schedulable'][number]) => (t.regionName ? `${t.name} · ${t.regionName}` : t.name);
  const ready = home && away && home !== away && date;

  if (!open) {
    if (controlled) return null;
    return (
      <section className="card">
        <div className="card-head">
          <h2>League games</h2>
          <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
            ＋ Schedule a game
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Schedule a game</h2>
        <button type="button" className="btn ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <p className="note">
        The game is added to both teams' calendars and match day. Coaches pick the lineup; the
        date, teams and venue stay as scheduled here.
      </p>
      <div className="field-grid">
        <label>
          Home team
          <select value={home} onChange={(e) => setHome(e.target.value)}>
            <option value="">Choose…</option>
            {cal.schedulable.map((t) => (
              <option key={t.id} value={t.id} disabled={t.id === away}>
                {label(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Away team
          <select value={away} onChange={(e) => setAway(e.target.value)}>
            <option value="">Choose…</option>
            {cal.schedulable.map((t) => (
              <option key={t.id} value={t.id} disabled={t.id === home}>
                {label(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Kick-off
          <input type="time" value={kickoff} onChange={(e) => setKickoff(e.target.value)} />
        </label>
        <label>
          Location
          <LocationInput value={location} onChange={setLocation} label="Location" placeholder="e.g. Central Park" />
        </label>
        <label>
          Field number (optional)
          <input value={field} maxLength={40} placeholder="e.g. 3" onChange={(e) => setField(e.target.value)} />
        </label>
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy || !ready}
        onClick={() =>
          run(async () => {
            await api.createFixture({
              homeTeamId: home,
              awayTeamId: away,
              date,
              kickoff: kickoff || undefined,
              location: location.trim() || undefined,
              field: field.trim() || undefined,
            });
            setHome('');
            setAway('');
            setKickoff('');
            setField('');
            setOpen(false);
          }, 'Game added to both teams.')
        }
      >
        Add to calendar
      </button>
    </section>
  );
}
