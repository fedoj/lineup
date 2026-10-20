import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IcsEvent, Player } from '@lineup/shared';
import {
  api,
  apiPath,
  peek,
  type Calendar as Cal,
  type CalendarEntry,
  type CheckinGame,
  type Checkins,
  type GameGuests,
  type Practice,
  type Practices as PracticeData,
  type SnackSlot,
  type TeamEvent,
  type TeamLife,
} from '../lib/api';
import {
  FixtureRow,
  FriendlyForm,
  MonthView,
  SharePanel,
  isUpcoming,
  localToday,
  prettyDate,
  prettyTime,
} from './Calendar';
import { EventForm, EventRow, SnackRow } from '../components/TeamLife';
import { PracticeRow, ScheduleForm as PracticeScheduleForm } from '../components/Practices';
import { AddCategoryToCalendar, AddToCalendar, RsvpButton, RsvpSummary } from '../components/Rsvp';
import { BorrowRequests, GameGuestList } from '../components/GameGuests';

type Category = 'games' | 'practices' | 'events' | 'snacks';
/** 'game' asks which kind of game; 'friendly' is the friendly form. */
type Creating = 'game' | 'friendly' | 'practice' | 'event' | null;

const CATEGORIES: Array<[Category, string]> = [
  ['games', 'Games'],
  ['practices', 'Practices'],
  ['events', 'Team events'],
  ['snacks', 'Snack schedule'],
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minutesBetween(start: string | null, end: string | null, fallback: number): number {
  if (!start || !end) return fallback;
  const [a, b] = start.split(':').map(Number);
  const [c, d] = end.split(':').map(Number);
  const m = c * 60 + d - (a * 60 + b);
  return m > 0 ? m : fallback;
}

function gameTitle(e: CalendarEntry, teamName: string): string {
  if (e.home.name === teamName) return `vs ${e.away.name}`;
  if (e.away.name === teamName) return `at ${e.home.name}`;
  return `${e.home.name} v ${e.away.name}`;
}

/**
 * A team's Calendar, all in one card:
 *
 * - "＋" buttons on top to create what the caller's role allows (a game or
 *   friendly, a league game, a practice schedule, a team event).
 * - Tick boxes for Games (on by default), Practices, Team events and the
 *   Snack schedule; only what is ticked shows, as a list or a month. Games
 *   (with their RSVPs) load first; the rest loads once they are on screen,
 *   or at once when its box is ticked.
 * - Each item carries its own RSVP, add to my calendar, edit and cancel.
 * - One "add to your own calendar" per ticked category (premium; a single
 *   lock per category on the free plan).
 * - Share, only when tapped.
 *
 * `focus` comes from a notification link (game:<id>, practice:<id>,
 * event:<id>, snacks, practices): its category is ticked and the item is
 * scrolled to.
 */
export default function TeamCalendar({
  teamId,
  onOpenGame,
  focus = null,
}: {
  teamId: string;
  onOpenGame: (teamId: string, gameId: string) => void;
  focus?: string | null;
}) {
  // What this visit already loaded shows at once; load() then refreshes it.
  const [cal, setCal] = useState<Cal | null>(() => peek<Cal>(apiPath.calendar('team', teamId)) ?? null);
  const [life, setLife] = useState<TeamLife | null>(() => peek<TeamLife>(apiPath.teamLife(teamId)) ?? null);
  const [practices, setPractices] = useState<PracticeData | null>(() => peek<PracticeData>(apiPath.practices(teamId)) ?? null);
  const [checkins, setCheckins] = useState<Checkins | null>(() => peek<Checkins>(apiPath.checkins(teamId)) ?? null);
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'month'>('list');
  const [shown, setShown] = useState<Set<Category>>(() => new Set(['games']));
  const [showPast, setShowPast] = useState(false);
  const [creating, setCreating] = useState<Creating>(null);
  const [sharing, setSharing] = useState(false);
  // Borrowed players for games, and requests for this team's players (Fady, 10/18).
  const [guests, setGuests] = useState<GameGuests | null>(null);
  const loadGuests = useCallback(() => {
    api
      .gameGuests(teamId)
      .then(setGuests)
      .catch(() => setGuests(null));
  }, [teamId]);
  useEffect(() => {
    setGuests(null);
    loadGuests();
  }, [loadGuests]);
  // Practices, team events and snacks load after the games are on screen.
  const [extrasAsked, setExtrasAsked] = useState(false);
  const [extrasLoaded, setExtrasLoaded] = useState(false);
  const visit = useRef(0);

  // Games and their RSVPs come first: Games is what is ticked when the tab opens.
  const loadGames = useCallback(async () => {
    const v = visit.current;
    const k = api.checkins(teamId).then(
      (r) => v === visit.current && setCheckins(r),
      () => v === visit.current && setCheckins(null),
    );
    try {
      const c = await api.calendar('team', teamId);
      if (v === visit.current) setCal(c);
    } catch (e) {
      if (v === visit.current) setError(e instanceof Error ? e.message : 'Failed to load the calendar');
    }
    await k;
  }, [teamId]);

  // Each part must not hide the rest if it fails to load.
  const loadExtras = useCallback(async () => {
    const v = visit.current;
    await Promise.all([
      api.practices(teamId).then(
        (r) => v === visit.current && setPractices(r),
        () => v === visit.current && setPractices(null),
      ),
      api.teamLife(teamId).then(
        (r) => v === visit.current && setLife(r),
        () => v === visit.current && setLife(null),
      ),
    ]);
    if (v === visit.current) setExtrasLoaded(true);
  }, [teamId]);

  const load = useCallback(async () => {
    await Promise.all([loadGames(), extrasAsked ? loadExtras() : null]);
  }, [loadGames, loadExtras, extrasAsked]);

  useEffect(() => {
    visit.current += 1;
    setCal(peek<Cal>(apiPath.calendar('team', teamId)) ?? null);
    setLife(peek<TeamLife>(apiPath.teamLife(teamId)) ?? null);
    setPractices(peek<PracticeData>(apiPath.practices(teamId)) ?? null);
    setCheckins(peek<Checkins>(apiPath.checkins(teamId)) ?? null);
    setError(null);
    setMsg(null);
    setExtrasAsked(false);
    setExtrasLoaded(false);
    void loadGames();
  }, [loadGames, teamId]);

  // Once the games are showing, the rest loads quietly; ticking a box (or a
  // notification link to one) asks for it straight away.
  const needsExtras = shown.has('practices') || shown.has('events') || shown.has('snacks');
  useEffect(() => {
    if (extrasAsked || !cal) return;
    if (needsExtras || (focus && !focus.startsWith('game'))) {
      setExtrasAsked(true);
      void loadExtras();
      return;
    }
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const go = () => {
      setExtrasAsked(true);
      void loadExtras();
    };
    if (idle) {
      const h = idle(go, { timeout: 1500 });
      return () => (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(h);
    }
    const t = window.setTimeout(go, 600);
    return () => window.clearTimeout(t);
  }, [cal, needsExtras, extrasAsked, focus, loadExtras]);

  // Families for the snack schedule, for the people who assign it.
  useEffect(() => {
    if (!life?.canEditSnacks) return;
    let cancelled = false;
    api
      .listPlayers(teamId)
      .then((p) => !cancelled && setPlayers(p.filter((x) => x.active !== false)))
      .catch(() => !cancelled && setPlayers([]));
    return () => {
      cancelled = true;
    };
  }, [teamId, life?.canEditSnacks]);

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

  const today = localToday();
  const gameIdOf = useCallback(
    (e: CalendarEntry) => e.links.find((l) => l.teamId === teamId)?.gameId ?? e.links[0]?.gameId ?? null,
    [teamId],
  );
  const checkinOf = useCallback(
    (gameId: string | null): CheckinGame | undefined => (gameId ? checkins?.games.find((g) => g.id === gameId) : undefined),
    [checkins],
  );

  // A notification link: tick its category, then scroll to the item.
  // "new:friendly" (＋ Friendly on the Games page) opens the friendly form once.
  const openedFriendly = useRef(false);
  useEffect(() => {
    if (!focus || !cal) return;
    if (focus === 'new:friendly' && cal.canAddFriendly && !openedFriendly.current) {
      openedFriendly.current = true;
      setCreating('friendly');
      setView('list');
    }
    const [kind, id] = focus.split(':');
    const category: Category | null =
      kind === 'game' ? 'games' : kind === 'practice' || kind === 'practices' ? 'practices' : kind === 'event' ? 'events' : kind === 'snacks' ? 'snacks' : null;
    if (category) {
      setView('list');
      setShown((prev) => new Set([...prev, category]));
    }
    const target =
      id && ['game', 'practice', 'event'].includes(kind) ? `item-${kind}-${id}` : kind === 'borrow' ? 'borrow' : 'cal-main';
    const t = window.setTimeout(() => {
      const el = document.getElementById(target);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash');
      window.setTimeout(() => el.classList.remove('flash'), 2500);
    }, 400);
    return () => window.clearTimeout(t);
  }, [focus, cal]);

  const upcomingPractices = useMemo(() => (practices?.practices ?? []).filter((p) => p.date >= today), [practices, today]);

  if (!cal) {
    return <section className={error ? 'card err' : 'card'}>{error ?? 'Loading…'}</section>;
  }

  const toggle = (c: Category) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const games = cal.entries;
  const upcomingGames = games.filter((e) => isUpcoming(e, today));
  const pastGames = games.filter((e) => !isUpcoming(e, today)).reverse();
  const pastPractices = (practices?.practices ?? []).filter((p) => p.date < today).reverse();
  const upcomingEvents = (life?.events ?? []).filter((e) => e.date >= today);
  const pastEvents = (life?.events ?? []).filter((e) => e.date < today).reverse();
  const snacks = life?.canSeeSnacks ? life.snacks : [];
  const upcomingSnacks = snacks.filter((s) => !s.date || s.date >= today);
  const hasPast =
    (shown.has('games') && pastGames.length > 0) ||
    (shown.has('practices') && pastPractices.length > 0) ||
    (shown.has('events') && pastEvents.length > 0);
  // A ticked box whose items are still on their way (nothing saved to show yet).
  const waiting =
    !extrasLoaded && ((shown.has('practices') && !practices) || ((shown.has('events') || shown.has('snacks')) && !life));

  /* ------------------------------------------------------------ item cards */

  const gameExtra = (e: CalendarEntry) => {
    const id = gameIdOf(e);
    if (!e.date || e.date < today || e.canceled) return null;
    const g = checkinOf(id);
    const borrow = guests && id ? <GameGuestList teamId={teamId} gameId={id} data={guests} onChanged={loadGuests} /> : null;
    if (!g) return borrow;
    return (
      <>
        <div className="row item-actions">
          <RsvpButton kind="game" itemId={g.id} teamId={teamId} kids={g.children} onSaved={() => void load()} />
          <AddToCalendar
            uid={`game-${g.id}`}
            title={`${cal.title} ${gameTitle(e, cal.title)}`}
            date={e.date}
            time={e.kickoff}
            durationMinutes={90}
            location={[e.location, e.field ? `Field ${e.field}` : null].filter(Boolean).join(', ') || null}
          />
        </div>
        <RsvpSummary counts={g.counts} summary={g.summary} />
        {borrow}
      </>
    );
  };

  const gameRow = (e: CalendarEntry) => (
    <FixtureRow
      key={`g-${e.id}`}
      e={e}
      busy={busy}
      run={run}
      onOpenGame={onOpenGame}
      domId={gameIdOf(e) ? `item-game-${gameIdOf(e)}` : undefined}
      extra={gameExtra(e)}
      refPool={e.orgId ? cal.refereePools?.[e.orgId] : undefined}
    />
  );

  const practiceRow = (p: Practice, past = false) =>
    practices ? (
      <PracticeCard key={`p-${p.id}`} p={p} data={practices} busy={busy} run={run} teamId={teamId} onSaved={() => void load()} past={past} />
    ) : null;

  const eventRow = (ev: TeamEvent) =>
    life ? <EventRow key={`e-${ev.id}`} e={ev} life={life} teamId={teamId} busy={busy} run={run} /> : null;

  const snackRow = (s: SnackSlot) =>
    life ? (
      <SnackRow key={`s-${s.gameId}`} s={s} players={players} canEdit={life.canEditSnacks} busy={busy} run={run} />
    ) : null;

  // What is ticked, in date order.
  const sortKey = (date: string | null, time: string | null) => `${date ?? '9999-99-99'}${time ?? '99:99'}`;
  const rows = (past: boolean): Array<{ sort: string; node: ReactNode }> => {
    const out: Array<{ sort: string; node: ReactNode }> = [];
    if (shown.has('games')) for (const e of past ? pastGames : upcomingGames) out.push({ sort: sortKey(e.date, e.kickoff), node: gameRow(e) });
    if (shown.has('practices')) for (const p of past ? pastPractices : upcomingPractices) out.push({ sort: sortKey(p.date, p.startTime), node: practiceRow(p, past) });
    if (shown.has('events')) for (const ev of past ? pastEvents : upcomingEvents) out.push({ sort: sortKey(ev.date, ev.startTime), node: eventRow(ev) });
    if (shown.has('snacks') && !past) for (const s of upcomingSnacks) out.push({ sort: sortKey(s.date, s.kickoff), node: snackRow(s) });
    out.sort((a, b) => a.sort.localeCompare(b.sort));
    return past ? out.reverse() : out;
  };
  const listRows = rows(false);

  /* ------------------------------------------ add to your own calendar, per category */

  const icsGames: IcsEvent[] = upcomingGames
    .filter((e) => e.date && !e.canceled)
    .map((e) => ({
      uid: `game-${gameIdOf(e) ?? e.id}`,
      title: `${cal.title} ${gameTitle(e, cal.title)}`,
      date: e.date!,
      time: e.kickoff,
      durationMinutes: 90,
      location: [e.location, e.field ? `Field ${e.field}` : null].filter(Boolean).join(', ') || null,
    }));
  const icsPractices: IcsEvent[] = upcomingPractices
    .filter((p) => !p.canceled)
    .map((p) => ({
      uid: `practice-${p.id}`,
      title: `${cal.title} practice`,
      date: p.date,
      time: p.startTime,
      durationMinutes: minutesBetween(p.startTime, p.endTime, 90),
      location: p.location,
    }));
  const icsEvents: IcsEvent[] = upcomingEvents.map((ev) => ({
    uid: `event-${ev.id}`,
    title: ev.title,
    date: ev.date,
    time: ev.startTime,
    durationMinutes: minutesBetween(ev.startTime, ev.endTime, 120),
    location: ev.location,
    description: ev.notes,
  }));

  /* ------------------------------------------------------- create, by role */

  // "＋ Game" asks: a friendly (added here), or a league or tournament game,
  // which is scheduled on the Games page (Fady, 10/19).
  const createButtons: Array<[Exclude<Creating, null>, string]> = [];
  if (cal.canAddFriendly) createButtons.push(['game', 'Match']);
  if (practices?.canSchedule) createButtons.push(['practice', 'Practice']);
  if (life?.canEditEvents) createButtons.push(['event', 'Team event']);
  const schedulesGames = Boolean(cal.canAddGame || cal.canSchedule);
  const openGames = () => window.dispatchEvent(new CustomEvent('lineup:open', { detail: '/competitions' }));

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {error && <section className="card err">{error}</section>}

      {guests && <BorrowRequests data={guests} onChanged={loadGuests} />}

      <section className="card" id="cal-main">
        <div className="card-head">
          <h2>{cal.title} · Calendar</h2>
          <div className="seg" role="tablist" aria-label="Calendar view">
            <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
              List
            </button>
            <button type="button" className={view === 'month' ? 'on' : ''} onClick={() => setView('month')}>
              Calendar
            </button>
          </div>
        </div>

        {createButtons.length > 0 && (
          <div className="row cal-create" role="group" aria-label="Add to the calendar">
            {createButtons.map(([id, label]) => {
              const on = creating === id || (id === 'game' && creating === 'friendly');
              return (
                <button
                  key={id}
                  type="button"
                  className={`btn btn-sm${on ? '' : ' ghost'}`}
                  aria-pressed={on}
                  onClick={() => setCreating(on ? null : id)}
                >
                  ＋ {label}
                </button>
              );
            })}
          </div>
        )}
        {schedulesGames && !cal.canAddFriendly && (
          <p className="note">
            Games are scheduled inside a league or tournament and show here automatically.{' '}
            <button type="button" className="linkish" onClick={openGames}>
              Games &amp; matches
            </button>
          </p>
        )}

        {creating && (
          <div className="cal-create-form">
            {creating === 'game' && (
              <div className="card">
                <div className="card-head">
                  <h2>Add a match</h2>
                  <button type="button" className="btn ghost btn-sm" onClick={() => setCreating(null)}>
                    Close
                  </button>
                </div>
                <p className="sub">What kind of match?</p>
                <div className="row">
                  <button type="button" className="btn btn-sm" onClick={() => setCreating('friendly')}>
                    Friendly
                  </button>
                  <button type="button" className="btn btn-sm" onClick={openGames}>
                    League or tournament match ›
                  </button>
                </div>
                <p className="note">
                  League and tournament matches are scheduled on the Games &amp; matches page, inside the league or tournament, and
                  show here automatically.
                </p>
              </div>
            )}
            {creating === 'friendly' && (
              <FriendlyForm
                teamId={teamId}
                allowGame={false}
                canSetAssistantFree={Boolean(cal.canApproveLineups)}
                busy={busy}
                run={async (fn, done) => {
                  await run(fn, done);
                  setShown((prev) => new Set([...prev, 'games']));
                }}
                open
                onClose={() => setCreating(null)}
              />
            )}
            {creating === 'practice' && practices && (
              <div className="card">
                <div className="card-head">
                  <h2>Practice schedule</h2>
                  <button type="button" className="btn ghost btn-sm" onClick={() => setCreating(null)}>
                    Close
                  </button>
                </div>
                <PracticeScheduleForm
                  data={practices}
                  busy={busy}
                  onCancel={() => setCreating(null)}
                  onSave={(b) =>
                    void run(async () => {
                      const r = await api.practiceAction({ action: 'schedule', teamId, ...b });
                      setCreating(null);
                      setShown((prev) => new Set([...prev, 'practices']));
                      return r;
                    }, 'Practices added. The team has been notified.')
                  }
                />
                {practices.series.length > 0 && (
                  <div className="practice-series">
                    <h3 className="group-title">Current practice schedules</h3>
                    {practices.series.map((s) => (
                      <div key={s.id} className="checkin-child">
                        <span>
                          {s.days.map((d) => DAY_NAMES[d]).join(', ')} · {prettyTime(s.startTime)}
                          {s.endTime ? `–${prettyTime(s.endTime)}` : ''} · {prettyDate(s.startsOn)} to {prettyDate(s.endsOn)}
                          {s.location ? ` · ${s.location}` : ''}
                        </span>
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Remove the ${s.upcoming} upcoming practices in this schedule? Past practices keep their attendance.`)) {
                              void run(() => api.practiceAction({ action: 'removeSchedule', seriesId: s.id }), 'Upcoming practices removed.');
                            }
                          }}
                        >
                          Remove upcoming
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {creating === 'event' && life && (
              <div className="card">
                <div className="card-head">
                  <h2>New team event</h2>
                  <button type="button" className="btn ghost btn-sm" onClick={() => setCreating(null)}>
                    Close
                  </button>
                </div>
                <EventForm
                  flyers={life.flyers}
                  busy={busy}
                  audienceFor={{ scope: 'team', id: teamId }}
                  onCancel={() => setCreating(null)}
                  onSave={(input) =>
                    run(async () => {
                      await api.createTeamEvent({ ...input, teamId });
                      setCreating(null);
                      setShown((prev) => new Set([...prev, 'events']));
                    }, 'Event added. The team has been notified.')
                  }
                />
              </div>
            )}
          </div>
        )}

        <div className="cal-filters" role="group" aria-label="Show on the calendar">
          {CATEGORIES.filter(([c]) => c !== 'snacks' || life?.canSeeSnacks).map(([c, label]) => (
            <label key={c} className="check">
              <input type="checkbox" checked={shown.has(c)} onChange={() => toggle(c)} /> {label}
            </label>
          ))}
        </div>

        {(shown.has('games') || shown.has('practices') || shown.has('events')) && (
          <div className="cal-add-cats">
            {shown.has('games') && <AddCategoryToCalendar label="Games" items={icsGames} />}
            {shown.has('practices') && <AddCategoryToCalendar label="Practices" items={icsPractices} />}
            {shown.has('events') && <AddCategoryToCalendar label="Team events" items={icsEvents} />}
          </div>
        )}

        {view === 'list' ? (
          <>
            {shown.size === 0 ? (
              <p className="note">Tick what to show.</p>
            ) : listRows.length === 0 ? (
              <p className="note">{waiting ? 'Loading…' : 'Nothing coming up here.'}</p>
            ) : (
              <>
                <ul className="fixtures cal-cards">{listRows.map((r) => r.node)}</ul>
                {waiting && <p className="note">Loading the rest…</p>}
              </>
            )}
            {hasPast && (
              <>
                <button type="button" className="linkish" onClick={() => setShowPast((v) => !v)}>
                  {showPast ? 'Hide past' : 'Show past'}
                </button>
                {showPast && <ul className="fixtures past cal-cards">{rows(true).map((r) => r.node)}</ul>}
              </>
            )}
          </>
        ) : (
          <MonthView
            entries={shown.has('games') ? games : []}
            events={shown.has('events') ? life?.events ?? [] : []}
            practices={shown.has('practices') ? practices?.practices ?? [] : []}
            snacks={shown.has('snacks') ? snacks : []}
            life={life}
            teamId={teamId}
            busy={busy}
            run={run}
            onOpenGame={onOpenGame}
            renderEntry={gameRow}
            renderPractice={(p) => practiceRow(p, p.date < today)}
            renderSnack={snackRow}
          />
        )}
      </section>

      {cal.canShare && (
        <section className="card">
          {sharing ? (
            <>
              <div className="card-head">
                <h2>Share</h2>
                <button type="button" className="btn ghost btn-sm" onClick={() => setSharing(false)}>
                  Close
                </button>
              </div>
              <SharePanel
                title={cal.title}
                items={[
                  ...icsGames,
                  // Invite-only events stay inside the app.
                  ...icsEvents.filter((ev) => !upcomingEvents.find((u) => `event-${u.id}` === ev.uid)?.restricted),
                ]}
              />
            </>
          ) : (
            <button type="button" className="btn ghost" onClick={() => setSharing(true)}>
              🔗 Share this calendar
            </button>
          )}
        </section>
      )}
    </>
  );
}

/** A practice card with its own open and cancelling state. */
function PracticeCard({
  p,
  data,
  busy,
  run,
  teamId,
  onSaved,
  past,
}: {
  p: Practice;
  data: PracticeData;
  busy: boolean;
  run: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  teamId: string;
  onSaved: () => void;
  past: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  return (
    <PracticeRow
      p={p}
      data={data}
      busy={busy}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      cancelling={cancelling}
      setCancelling={setCancelling}
      act={(fn, done) => run(fn, done ?? 'Saved.')}
      teamId={teamId}
      onSaved={onSaved}
      past={past}
    />
  );
}
