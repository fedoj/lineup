import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type RefereeGame, type RefereeSlot, type RefereeView } from '../lib/api';
import { prettyDate, prettyTime } from './Calendar';
import { DateTile } from '../components/DateTile';
import MapLink from '../components/MapLink';
import RefMatch from './RefMatch';
import { PENDING_REF_KEY } from '../lib/pendingKeys';

export { PENDING_REF_KEY };

const SLOTS: Array<[RefereeSlot, string, string]> = [
  ['main', 'Main referee', 'Main ref'],
  ['ar1', 'Assistant referee 1', 'Assistant 1'],
  ['ar2', 'Assistant referee 2', 'Assistant 2'],
];

const slotLabel = (s: RefereeSlot) => SLOTS.find(([id]) => id === s)![1];

/**
 * The referee's screen: join an organization or region with its referee code,
 * pick a favorite region, see the games you are signed up for, and take an
 * open spot (main referee or one of two assistants) on any league game.
 * First come, first served.
 */
export default function Referee({
  onChanged,
  initialMatch = null,
  onCloseMatch,
}: {
  onChanged?: () => void;
  /** A league game to open the match screen for (from a link or the calendar). */
  initialMatch?: string | null;
  /** Back from a match screen opened elsewhere (the calendar): return there. */
  onCloseMatch?: () => void;
}) {
  const [view, setView] = useState<RefereeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(() => localStorage.getItem(PENDING_REF_KEY) ?? '');
  const [joining, setJoining] = useState(false);
  const [filter, setFilter] = useState<string>('favorite');
  const [matchId, setMatchId] = useState<string | null>(initialMatch);

  useEffect(() => {
    if (initialMatch) setMatchId(initialMatch);
  }, [initialMatch]);

  function openMatch(id: string | null) {
    setMatchId(id);
    history.replaceState(null, '', id ? `/referee?match=${id}` : '/referee');
    window.scrollTo({ top: 0 });
  }

  const load = useCallback(async () => {
    try {
      setView(await api.referee());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your referee games');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<RefereeView>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      setView(await fn());
      setMsg(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      // Someone may have taken the spot first: show what is open now.
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    const ok = await act(() => api.refereeAction({ action: 'join', code }), "You're in. Pick the games you want to referee below.");
    if (ok) {
      localStorage.removeItem(PENDING_REF_KEY);
      setCode('');
      setJoining(false);
      onChanged?.();
    }
  }

  const favorites = useMemo(
    () => new Set((view?.orgs ?? []).map((o) => o.favoriteRegionId).filter((x): x is string => Boolean(x))),
    [view],
  );
  const regions = useMemo(() => (view?.orgs ?? []).flatMap((o) => o.regions.map((r) => ({ ...r, orgName: o.name }))), [view]);
  const manyOrgs = (view?.orgs.length ?? 0) > 1;

  if (matchId) {
    return (
      <RefMatch
        fixtureId={matchId}
        onBack={() => {
          if (onCloseMatch) {
            setMatchId(null);
            onCloseMatch();
            return;
          }
          openMatch(null);
          void load();
        }}
      />
    );
  }

  if (!view) {
    return <section className={error ? 'card err' : 'card'}>{error ?? 'Loading…'}</section>;
  }

  const open = view.open.filter((g) => {
    if (filter === 'all') return true;
    if (filter === 'favorite') return favorites.size === 0 || g.regionIds.some((r) => favorites.has(r));
    return g.regionIds.includes(filter);
  });
  const showJoin = view.orgs.length === 0 || joining;

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {error && <section className="card err">{error}</section>}

      <section className="card">
        <div className="card-head">
          <h2>🟨 Referee</h2>
        </div>
        <p className="note">
          Sign up to referee league games as the main referee or one of two assistants. Spots are first come, first
          served, and the organizers can change who refs a game.
        </p>

        {view.orgs.length > 0 && (
          <ul className="ref-orgs">
            {view.orgs.map((o) => (
              <li key={o.orgId} className="ref-org">
                <strong>{o.name}</strong>
                {o.regions.length > 1 && (
                  <label className="ref-fav">
                    Favorite region
                    <select
                      value={o.favoriteRegionId ?? ''}
                      disabled={busy}
                      onChange={(x) =>
                        void act(
                          () => api.refereeAction({ action: 'favorite', orgId: o.orgId, regionId: x.target.value || null }),
                          x.target.value ? 'Favorite region saved. Its games show first.' : 'Showing games from every region.',
                        ).then(() => setFilter('favorite'))
                      }
                    >
                      <option value="">No favorite (all regions)</option>
                      {o.regions.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Stop refereeing for ${o.name}? Your upcoming games there are given up.`)) {
                      void act(() => api.refereeAction({ action: 'leave', orgId: o.orgId }), `You no longer referee for ${o.name}.`).then(
                        () => onChanged?.(),
                      );
                    }
                  }}
                >
                  Leave
                </button>
              </li>
            ))}
          </ul>
        )}

        {showJoin ? (
          <div className="ref-join">
            <label>
              Referee code
              <input
                value={code}
                maxLength={20}
                autoCapitalize="characters"
                placeholder="e.g. 7KX2QPMA"
                onChange={(x) => setCode(x.target.value)}
                onKeyDown={(x) => {
                  if (x.key === 'Enter' && code.trim()) void join();
                }}
              />
            </label>
            <div className="row">
              <button type="button" className="btn" disabled={busy || !code.trim()} onClick={() => void join()}>
                Join as a referee
              </button>
              {view.orgs.length > 0 && (
                <button type="button" className="btn ghost" onClick={() => setJoining(false)}>
                  Cancel
                </button>
              )}
            </div>
            <p className="note">Ask your organization or region for its referee code or link.</p>
          </div>
        ) : (
          <button type="button" className="linkish" onClick={() => setJoining(true)}>
            ＋ Referee for another organization or region
          </button>
        )}
      </section>

      {view.orgs.length > 0 && (
        <>
          <section className="card">
            <h2>My games</h2>
            {view.mine.length === 0 ? (
              <p className="note">You haven't signed up for a game yet. Pick one below.</p>
            ) : (
              <ul className="fixtures cal-cards">
                {view.mine.map((g) => (
                  <RefGameCard key={g.fixtureId} g={g} busy={busy} manyOrgs={manyOrgs}>
                    {g.mySlot && <span className="pill-league">You: {slotLabel(g.mySlot)}</span>}
                    {!g.canceled && (
                      <button type="button" className="btn btn-sm" onClick={() => openMatch(g.fixtureId)}>
                        {g.mySlot === 'main' ? '📝 Match screen' : '👀 Match screen'}
                      </button>
                    )}
                    {!g.canceled && !g.official && g.date >= todayIso() && (
                      <button
                        type="button"
                        className="btn ghost btn-sm"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Give up your spot on ${g.home} vs ${g.away}?`)) {
                            void act(() => api.refereeAction({ action: 'drop', fixtureId: g.fixtureId }), 'Spot given up. Someone else can take it now.');
                          }
                        }}
                      >
                        Give up my spot
                      </button>
                    )}
                  </RefGameCard>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Open games</h2>
              {regions.length > 1 && (
                <select value={filter} aria-label="Which games to show" onChange={(x) => setFilter(x.target.value)}>
                  {favorites.size > 0 && <option value="favorite">My favorite region</option>}
                  <option value={favorites.size > 0 ? 'all' : 'favorite'}>All regions</option>
                  {regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {manyOrgs ? `${r.orgName} · ${r.name}` : r.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {open.length === 0 ? (
              <p className="note">No open spots right now. New league games show up here as they are scheduled.</p>
            ) : (
              <ul className="fixtures cal-cards">
                {open.map((g) => (
                  <RefGameCard key={g.fixtureId} g={g} busy={busy} manyOrgs={manyOrgs}>
                    {SLOTS.filter(([s]) => !g.slots[s]).map(([s, label, short]) => (
                      <button
                        key={s}
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () => api.refereeAction({ action: 'take', fixtureId: g.fixtureId, slot: s }),
                            `You're the ${label.toLowerCase()} for ${g.home} vs ${g.away}.`,
                          )
                        }
                      >
                        ＋ {short}
                      </button>
                    ))}
                  </RefGameCard>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function RefGameCard({
  g,
  manyOrgs,
  children,
}: {
  g: RefereeGame;
  busy: boolean;
  manyOrgs: boolean;
  children?: ReactNode;
}) {
  const where = [g.regionName, manyOrgs ? g.orgName : null].filter(Boolean).join(' · ');
  return (
    <li className={`fixture ref-game${g.canceled ? ' canceled' : ''}`}>
      <div className="fixture-when">
        <DateTile date={g.date} />
        <strong>{prettyDate(g.date)}</strong>
        {g.kickoff && <span>{prettyTime(g.kickoff)}</span>}
      </div>
      <div className="fixture-what">
        <div className="fixture-teams">
          <span>{g.home}</span>
          <span className="fixture-vs">vs</span>
          <span>{g.away}</span>
          {g.canceled && <span className="pill bad small">Cancelled</span>}
          {g.official && <span className="pill-league">Official result in</span>}
        </div>
        {where && <div className="sub">{where}</div>}
        {(g.location || g.field) && (
          <div className="sub">
            {g.location && <MapLink place={g.location} />}
            {g.location && g.field ? ' · ' : ''}
            {g.field ? `Field ${g.field}` : ''}
          </div>
        )}
        <div className="ref-slots sub">
          {SLOTS.map(([s, label]) => (
            <span key={s}>
              {label}: {g.slots[s] ? (g.slots[s]!.mine ? 'you' : g.slots[s]!.name) : <em>open</em>}
            </span>
          ))}
        </div>
        <div className="row item-actions">{children}</div>
      </div>
    </li>
  );
}
