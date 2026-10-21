import { useCallback, useEffect, useState } from 'react';
import FriendlyRequests from '../components/FriendlyRequests';
import { COMPETITION_KINDS } from '@lineup/shared';
import {
  api,
  type CompetitionDetail,
  type CompetitionKind,
  type CompetitionList,
  type CompetitionSummary,
  type FriendlyItem,
  type StandingsScope,
} from '../lib/api';
import { prettyDate, prettyTime } from './Calendar';
import BracketCard from './Bracket';
import LocationInput from '../components/LocationInput';
import { useRegionFields } from '../components/RegionFields';
import { CoachSignupsPanel } from '../components/RegionJoin';

const STATUS_LABEL: Record<CompetitionSummary['status'], string> = {
  upcoming: 'Upcoming',
  active: 'Active',
  archived: 'Ended · read-only',
};

const kindIcon = (k: CompetitionKind) => (k === 'tournament' ? '🏆' : '📅');

/** A team the caller can add a friendly to, for "＋ Friendly" on the Games page. */
export interface FriendlyTeam {
  id: string;
  name: string;
}

/** Open a team's calendar with the friendly form showing. */
function openFriendly(teamId: string) {
  window.dispatchEvent(
    new CustomEvent('lineup:open', { detail: `/calendar?team=${encodeURIComponent(teamId)}&focus=new:friendly` }),
  );
}

/**
 * Games (Fady, 10/19; was "Leagues & tournaments"). Leagues and tournaments
 * stand on their own, apart from teams: the app's own page lists every one
 * the caller runs or takes part in ("mine"), and an organization or region
 * lists its own. One opened shows its teams, standings and games; games
 * scheduled in it land on each team's calendar. ＋ League or season,
 * ＋ Tournament and ＋ Friendly start each kind of game; a friendly belongs to
 * one team, so it opens that team's calendar.
 */
export default function Competitions({
  scope,
  id,
  initialOpenId = null,
  onOpenGame,
  friendlyTeams = [],
}: {
  scope: StandingsScope | 'mine';
  id: string;
  initialOpenId?: string | null;
  onOpenGame: (teamId: string, gameId: string) => void;
  /** Teams the caller coaches; only on the app's own Games page. */
  friendlyTeams?: FriendlyTeam[];
}) {
  const [list, setList] = useState<CompetitionList | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [creating, setCreating] = useState<CompetitionKind | 'friendly' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .competitions(scope, id)
      .then((l) => {
        setList(l);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load leagues and tournaments'));
  }, [scope, id]);
  useEffect(() => {
    setOpenId(initialOpenId);
    setCreating(null);
    load();
  }, [load, initialOpenId]);

  if (openId) {
    return (
      <CompetitionView
        id={openId}
        onBack={() => {
          setOpenId(null);
          load();
        }}
        onOpenGame={onOpenGame}
      />
    );
  }
  if (error) return <section className="card err">{error}</section>;
  if (!list) return <section className="card">Loading…</section>;

  const current = list.competitions.filter((c) => c.status !== 'archived');
  const past = list.competitions.filter((c) => c.status === 'archived');
  const options = list.createOptions ?? (list.createAs ? [{ ...list.createAs, label: '' }] : []);
  const canCreateCompetition = list.canCreate && options.length > 0;
  // Org and region staff add a friendly between two of its teams here; coaches
  // request one from their team's calendar, and staff approve it (Shadi, 10/20).
  const scopeTeams = scope === 'region' || scope === 'org' ? list.friendlyTeams ?? [] : [];
  const canFriendly = ((scope === 'mine' || scope === 'team') && friendlyTeams.length > 0) || scopeTeams.length > 1;
  // League or season first, then tournament, then friendly (Fady, 10/19).
  const addButtons: Array<[CompetitionKind | 'friendly', string]> = [
    ...(canCreateCompetition
      ? ([
          ['season', 'League or season'],
          ['tournament', 'Tournament'],
        ] as Array<[CompetitionKind, string]>)
      : []),
    ...(canFriendly ? ([['friendly', 'Friendly']] as Array<['friendly', string]>) : []),
  ];

  return (
    <>
      <section className="card" data-tour="competition-list">
        <div className="card-head">
          <h2>Games</h2>
        </div>
        {addButtons.length > 0 && (
          <div className="row cal-create" role="group" aria-label="Add games" data-tour="new-competition">
            {addButtons.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`btn btn-sm${creating === k ? '' : ' ghost'}`}
                aria-pressed={creating === k}
                onClick={() => {
                  if (k === 'friendly' && scopeTeams.length === 0 && friendlyTeams.length === 1) {
                    openFriendly(friendlyTeams[0].id);
                    return;
                  }
                  setCreating(creating === k ? null : k);
                }}
              >
                ＋ {label}
              </button>
            ))}
          </div>
        )}
        {(scope === 'mine' || scope === 'team') && (
          <p className="note">
            Create a league, season or tournament, tick the teams taking part, and schedule its games here: they show
            on each team’s calendar. A friendly is added to one of your teams’ calendars.
          </p>
        )}
        {creating === 'friendly' && scopeTeams.length > 1 && (
          <ScopeFriendlyForm
            teams={scopeTeams}
            onCancel={() => setCreating(null)}
            onDone={(m) => {
              setCreating(null);
              setNotice(m);
              load();
            }}
          />
        )}
        {notice && (
          <p className="note" role="status">
            {notice}
          </p>
        )}
        {creating === 'friendly' && scopeTeams.length === 0 && (
          <div className="comp-form">
            <p className="sub">Which team is the friendly for?</p>
            <div className="row">
              {friendlyTeams.map((t) => (
                <button key={t.id} type="button" className="btn btn-sm" onClick={() => openFriendly(t.id)}>
                  {t.name}
                </button>
              ))}
              <button type="button" className="btn ghost btn-sm" onClick={() => setCreating(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {creating && creating !== 'friendly' && canCreateCompetition && (
          <CompetitionForm
            key={creating}
            busyLabel="Create"
            defaultKind={creating}
            owners={options.length > 1 ? options : undefined}
            onCancel={() => setCreating(null)}
            onSave={async ({ owner, ...v }) => {
              const o = options[owner ?? 0] ?? options[0];
              const r = await api.competitionAction({
                action: 'create',
                scope: o.scope,
                scopeId: o.id,
                ...v,
              });
              setCreating(null);
              load();
              if (r.id) setOpenId(r.id);
            }}
          />
        )}
        <h3 className="group-title">Leagues &amp; tournaments</h3>
        {current.length === 0 ? (
          <p className="note">
            {list.canCreate
              ? 'No league or tournament yet. Create one, add the teams taking part, and schedule its games: they show on each team’s calendar.'
              : 'Not part of a league or tournament yet.'}
          </p>
        ) : (
          <ul className="comp-list">
            {current.map((c) => (
              <CompetitionCard key={c.id} c={c} onOpen={() => setOpenId(c.id)} />
            ))}
          </ul>
        )}
      </section>
      {list.approvesFriendlies && (scope === 'region' || scope === 'org') && (
        <FriendlyRequests query={{ scope, id }} onChanged={load} />
      )}
      {list.friendlies && (
        <FriendliesCard
          friendlies={list.friendlies}
          onOpenGame={onOpenGame}
          emptyNote={
            canFriendly
              ? 'No friendlies coming up. Tap “＋ Friendly” to add one to a team’s calendar.'
              : 'No friendlies coming up. A team asks for one from its calendar (＋ Game).'
          }
        />
      )}
      {past.length > 0 && (
        <section className="card">
          <h2>Past leagues &amp; tournaments</h2>
          <p className="note">Ended leagues and tournaments are archived: everything in them is kept, read-only.</p>
          <ul className="comp-list">
            {past.map((c) => (
              <CompetitionCard key={c.id} c={c} onOpen={() => setOpenId(c.id)} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Friendlies get their own section on the Games page (Fady, 10/19). */
function FriendliesCard({
  friendlies,
  onOpenGame,
  emptyNote,
}: {
  friendlies: FriendlyItem[];
  onOpenGame: (teamId: string, gameId: string) => void;
  emptyNote: string;
}) {
  const [showPast, setShowPast] = useState(false);
  const ahead = friendlies.filter((f) => !f.past);
  const recent = friendlies.filter((f) => f.past).reverse();
  const row = (f: FriendlyItem) => {
    const us = f.teamName;
    const title = f.home ? `${us} v ${f.opponent}` : `${f.opponent} v ${us}`;
    const when = [prettyDate(f.date), f.kickoff ? prettyTime(f.kickoff) : null, f.location].filter(Boolean).join(' · ');
    const status = f.canceled ? 'Cancelled' : f.score ? `${f.score.us}–${f.score.them}` : 'Upcoming';
    return (
      <li key={f.gameId}>
        <button type="button" className={`comp-card ${f.past ? 'archived' : 'upcoming'}`} onClick={() => onOpenGame(f.teamId, f.gameId)}>
          <span className="comp-icon" aria-hidden="true">
            🤝
          </span>
          <span className="comp-main">
            <strong>{title}</strong>
            <span className="sub">{when}</span>
          </span>
          <span className={`comp-status ${f.canceled ? 'archived' : f.score ? 'active' : 'upcoming'}`}>{status}</span>
        </button>
      </li>
    );
  };
  return (
    <section className="card">
      <h2>Friendlies</h2>
      {ahead.length === 0 ? (
        <p className="note">{emptyNote}</p>
      ) : (
        <ul className="comp-list">{ahead.map(row)}</ul>
      )}
      {recent.length > 0 && (
        <>
          <button type="button" className="linkish" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>
            {showPast ? 'Hide recent friendlies' : `Recent friendlies (${recent.length})`}
          </button>
          {showPast && <ul className="comp-list">{recent.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

function CompetitionCard({ c, onOpen }: { c: CompetitionSummary; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className={`comp-card ${c.status}`} onClick={onOpen}>
        <span className="comp-icon" aria-hidden="true">
          {kindIcon(c.kind)}
        </span>
        <span className="comp-main">
          <strong>{c.name}</strong>
          <span className="sub">
            {prettyDate(c.startsOn)} – {prettyDate(c.endsOn)} · {c.teams} {c.teams === 1 ? 'team' : 'teams'} · {c.games}{' '}
            {c.games === 1 ? 'game' : 'games'}
            {c.owner ? ` · ${c.owner}` : ''}
          </span>
        </span>
        <span className={`comp-status ${c.status}`}>{STATUS_LABEL[c.status]}</span>
      </button>
    </li>
  );
}

function CompetitionForm({
  initial,
  defaultKind = 'season',
  owners,
  busyLabel,
  onSave,
  onCancel,
}: {
  initial?: { kind: CompetitionKind; name: string; startsOn: string; endsOn: string };
  /** The kind picked with ＋ League or season or ＋ Tournament. */
  defaultKind?: CompetitionKind;
  /** Where it can belong, when there is a choice. */
  owners?: CompetitionList['createOptions'];
  busyLabel: string;
  onSave: (v: { kind: CompetitionKind; name: string; startsOn: string; endsOn: string; owner?: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<CompetitionKind>(initial?.kind ?? defaultKind);
  const [name, setName] = useState(initial?.name ?? '');
  const [startsOn, setStartsOn] = useState(initial?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(initial?.endsOn ?? '');
  const [owner, setOwner] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="comp-form">
      <div className="field-grid">
        {owners && (
          <label>
            Run by
            <select value={owner} onChange={(e) => setOwner(Number(e.target.value))}>
              {owners.map((o, i) => (
                <option key={`${o.scope}-${o.id}`} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value as CompetitionKind)}>
            {COMPETITION_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            value={name}
            maxLength={80}
            placeholder={kind === 'tournament' ? 'e.g. Thanksgiving Cup' : 'e.g. Fall 2026 or 2026–2027'}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Starts
          <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          Ends
          <input type="date" value={endsOn} min={startsOn || undefined} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
      </div>
      {error && <p className="danger-text">{error}</p>}
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !name.trim() || !startsOn || !endsOn}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ kind, name: name.trim(), startsOn, endsOn, owner: owners ? owner : undefined });
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not save');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : busyLabel}
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One league or tournament: its teams, standings and games. */
function CompetitionView({
  id,
  onBack,
  onOpenGame,
}: {
  id: string;
  onBack: () => void;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  const [c, setC] = useState<CompetitionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<Set<string> | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .competition(id)
      .then((d) => {
        setC(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load it'));
  }, [id]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!c) {
    return error ? <section className="card err">{error}</section> : <section className="card">Loading…</section>;
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <button type="button" className="btn ghost btn-sm" onClick={onBack}>
            ‹ All games
          </button>
          {c.canEdit && !editing && (
            <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
        <h2>
          {kindIcon(c.kind)} {c.name}
        </h2>
        <p className="sub">
          {c.kind === 'tournament' ? 'Tournament' : 'League'} · {prettyDate(c.startsOn)} – {prettyDate(c.endsOn)}
          {c.owner ? ` · ${c.owner}` : ''} · <span className={`comp-status ${c.status}`}>{STATUS_LABEL[c.status]}</span>
        </p>
        {c.status === 'archived' && (
          <p className="note">This has ended, so it is archived and read-only.</p>
        )}
        {editing && (
          <CompetitionForm
            initial={{ kind: c.kind, name: c.name, startsOn: c.startsOn, endsOn: c.endsOn }}
            busyLabel="Save"
            onCancel={() => setEditing(false)}
            onSave={async (v) => {
              await api.competitionAction({ action: 'update', id: c.id, ...v });
              setEditing(false);
              setMsg('Saved.');
              load();
            }}
          />
        )}
        {msg && (
          <p className="note" role="status">
            {msg}
          </p>
        )}
        {error && <p className="danger-text">{error}</p>}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            Teams <span className="count">{c.teams.length}</span>
          </h2>
          {c.canEdit && adding === null && c.eligibleTeams.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => setAdding(new Set())}>
              ＋ Add teams
            </button>
          )}
        </div>
        {adding !== null && (
          <div className="comp-add">
            <p className="note">Pick the teams taking part. Its games will show on their calendars.</p>
            <ul className="check-list">
              {c.eligibleTeams.map((t) => (
                <li key={t.id}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={adding.has(t.id)}
                      onChange={(e) =>
                        setAdding((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(t.id);
                          else next.delete(t.id);
                          return next;
                        })
                      }
                    />{' '}
                    {t.name}
                    {t.regionName ? <span className="sub"> · {t.regionName}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || adding.size === 0}
                onClick={() =>
                  void act(async () => {
                    await api.competitionAction({ action: 'addTeams', id: c.id, teamIds: [...adding] });
                    setAdding(null);
                  }, `${adding.size} ${adding.size === 1 ? 'team' : 'teams'} added.`)
                }
              >
                Add {adding.size || ''} {adding.size === 1 ? 'team' : 'teams'}
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => setAdding(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {c.teams.length === 0 ? (
          <p className="note">No teams yet.</p>
        ) : (
          <ul className="comp-teams">
            {c.teams.map((t) => (
              <li key={t.id}>
                <span>
                  {t.name}
                  {t.regionName ? <span className="sub"> · {t.regionName}</span> : null}
                </span>
                {c.canEdit && (
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Take ${t.name} out of ${c.name}?`)) {
                        void act(() => api.competitionAction({ action: 'removeTeam', id: c.id, teamId: t.id }), `${t.name} removed.`);
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Every league and tournament has its sign-up link on its page (Fady, 10/19); coaches of
          its teams see the link to share too (10/20), the panel stays hidden for everyone else. */}
      <CoachSignupsPanel competitionId={c.id} />

      <section className="card">
        <h2>Standings</h2>
        <StandingsTable standings={c.standings} />
      </section>

      {c.kind === 'tournament' && <BracketCard c={c} onChanged={load} onOpenGame={onOpenGame} />}

      <section className="card">
        <div className="card-head">
          <h2>
            Games <span className="count">{c.games.length}</span>
          </h2>
          {(c.canEdit || c.canSchedule) && c.teams.length > 0 && !scheduling && (
            <button type="button" className="btn btn-sm" onClick={() => setScheduling(true)}>
              ＋ Schedule a game
            </button>
          )}
        </div>
        {scheduling && (
          <ScheduleInCompetition
            c={c}
            onCancel={() => setScheduling(false)}
            onDone={() => {
              setScheduling(false);
              setMsg('Game added. It shows on the teams’ calendars.');
              load();
            }}
          />
        )}
        {c.games.length === 0 ? (
          <p className="note">No games yet.</p>
        ) : (
          <ul className="fixtures">
            {c.games.map((g) => (
              <li key={g.id} className={`fixture${g.canceled ? ' canceled' : ''}`}>
                <div className="fixture-when">
                  {g.date ? prettyDate(g.date) : 'Date TBD'}
                  {g.kickoff ? ` · ${prettyTime(g.kickoff)}` : ''}
                </div>
                <div className="fixture-teams">
                  <span>{g.home}</span>
                  {g.score ? (
                    <span className="fixture-score">
                      {g.score.home} – {g.score.away}
                    </span>
                  ) : (
                    <span className="fixture-vs">vs</span>
                  )}
                  <span>{g.away}</span>
                  {g.canceled && <span className="pill bad small">Cancelled</span>}
                </div>
                {g.location && <div className="sub">{g.location}</div>}
                {g.links.length > 0 && (
                  <div className="row">
                    {g.links.map((l) => (
                      <button key={l.gameId} type="button" className="linkish" onClick={() => onOpenGame(l.teamId, l.gameId)}>
                        Open match day{g.links.length > 1 ? ` (${l.teamName})` : ''}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Schedule a game in this league or tournament. An organization's or region's
 * one: two of its teams, from its list. A coach's own one: one of its teams
 * against another of them, or against a team typed in by name (Fady, 10/16).
 * Kick-off and location are required for every game.
 */
function ScheduleInCompetition({ c, onCancel, onDone }: { c: CompetitionDetail; onCancel: () => void; onDone: () => void }) {
  const league = c.ownerKind !== 'coach';
  const OTHER = '__other__';
  const [home, setHome] = useState(c.teams[0]?.id ?? '');
  const [away, setAway] = useState(c.teams[1]?.id ?? (league ? '' : OTHER));
  const [opponent, setOpponent] = useState('');
  const [isHome, setIsHome] = useState(true);
  const [date, setDate] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const min = c.startsOn > today ? c.startsOn : today < c.endsOn ? today : c.startsOn;
  const typed = !league && away === OTHER;
  const nameOf = (id: string) => c.teams.find((t) => t.id === id)?.name ?? '';
  // The region's fields, as quick picks for the location.
  const fields = useRegionFields({ competitionId: c.id });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const when = { date, kickoff, location: location.trim(), competitionId: c.id };
      if (league) {
        await api.createFixture({ homeTeamId: home, awayTeamId: away, ...when });
      } else if (typed) {
        await api.createFriendly({ teamId: home, opponent: opponent.trim(), isHome, kind: 'game', ...when });
      } else {
        // Two of the coach's own teams: the game goes on both calendars.
        await api.createFriendly({ teamId: home, opponent: nameOf(away), isHome: true, kind: 'game', ...when });
        await api.createFriendly({ teamId: away, opponent: nameOf(home), isHome: false, kind: 'game', ...when });
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the game');
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(
    date && kickoff && location.trim() && home && (typed ? opponent.trim() : away && away !== OTHER && away !== home),
  );

  return (
    <div className="comp-form">
      <div className="field-grid">
        <label>
          {typed ? 'Team' : 'Home'}
          <select value={home} onChange={(e) => setHome(e.target.value)}>
            {c.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {typed ? 'Opponent' : 'Away'}
          <select value={away} onChange={(e) => setAway(e.target.value)}>
            <option value="">Pick a team…</option>
            {c.teams
              .filter((t) => t.id !== home)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            {!league && <option value={OTHER}>Another team (type its name)</option>}
          </select>
        </label>
        {typed && (
          <>
            <label>
              Opponent’s name
              <input value={opponent} maxLength={80} placeholder="e.g. Westside FC" onChange={(e) => setOpponent(e.target.value)} />
            </label>
            <label>
              Venue
              <select value={isHome ? 'home' : 'away'} onChange={(e) => setIsHome(e.target.value === 'home')}>
                <option value="home">Home</option>
                <option value="away">Away</option>
              </select>
            </label>
          </>
        )}
        <label>
          Date
          <input type="date" value={date} min={min} max={c.endsOn} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Kick-off
          <input type="time" value={kickoff} required onChange={(e) => setKickoff(e.target.value)} />
        </label>
        <label>
          Location
          <LocationInput value={location} onChange={setLocation} label="Location" placeholder="e.g. Central Park, field 2" presets={fields} />
        </label>
      </div>
      {league && c.teams.length < 2 && <p className="note">Add at least two teams to schedule a game.</p>}
      {error && <p className="danger-text">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={busy || !ready} onClick={() => void save()}>
          {busy ? 'Adding…' : 'Add game'}
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
function StandingsTable({ standings }: { standings: CompetitionDetail['standings'] }) {
  return (
    <>
      {standings.table.length === 0 ? (
        <p className="note">Add teams to see the table.</p>
      ) : (
        <div className="table-scroll">
          <table className="tiers standings">
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>P</th>
                <th>W</th>
                <th>D</th>
                <th>L</th>
                <th>GF</th>
                <th>GA</th>
                <th>GD</th>
                <th>Pts</th>
              </tr>
            </thead>
            <tbody>
              {standings.table.map((r, i) => (
                <tr key={r.teamId}>
                  <td>{i + 1}</td>
                  <td>{r.name}</td>
                  <td>{r.played}</td>
                  <td>{r.won}</td>
                  <td>{r.drawn}</td>
                  <td>{r.lost}</td>
                  <td>{r.gf}</td>
                  <td>{r.ga}</td>
                  <td>{r.gd}</td>
                  <td>
                    <strong>{r.pts}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {standings.scorers.length > 0 && (
        <>
          <h3 className="group-title">Top scorers</h3>
          <ul className="comp-scorers">
            {standings.scorers.map((s, i) => (
              <li key={`${s.name}-${s.teamName}-${i}`}>
                {s.name} <span className="sub">· {s.teamName}</span> — {s.goals} {s.goals === 1 ? 'goal' : 'goals'}
                {s.assists ? `, ${s.assists} ${s.assists === 1 ? 'assist' : 'assists'}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * An organization's or region's Standings tab: standings live in each season
 * and tournament, so pick one of the running ones from the list.
 */
export function CompetitionStandings({
  scope,
  id,
  onOpen,
  onAll,
}: {
  scope: StandingsScope;
  id: string;
  /** Open the league or tournament itself. */
  onOpen: (competitionId: string) => void;
  /** Go to the Games tab. */
  onAll: () => void;
}) {
  const [list, setList] = useState<CompetitionSummary[] | null>(null);
  const [pick, setPick] = useState<string>('');
  const [detail, setDetail] = useState<CompetitionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    setDetail(null);
    api
      .competitions(scope, id)
      .then((l) => {
        const running = l.competitions.filter((c) => c.status === 'active');
        setList(running);
        setPick(running[0]?.id ?? '');
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load standings'));
  }, [scope, id]);

  useEffect(() => {
    if (!pick) return;
    let live = true;
    api
      .competition(pick)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not load standings');
      });
    return () => {
      live = false;
    };
  }, [pick]);

  if (error) return <section className="card err">{error}</section>;
  if (!list) return <section className="card">Loading…</section>;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Standings</h2>
        {list.length > 0 && (
          <select className="comp-pick" aria-label="League or tournament" value={pick} onChange={(e) => setPick(e.target.value)}>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {kindIcon(c.kind)} {c.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {list.length === 0 ? (
        <>
          <p className="note">No league or tournament is running right now. Standings show here while one is on.</p>
          <button type="button" className="btn ghost btn-sm" onClick={onAll}>
            Games
          </button>
        </>
      ) : !detail || detail.id !== pick ? (
        <p className="note">Loading…</p>
      ) : (
        <>
          <p className="sub">
            {prettyDate(detail.startsOn)} – {prettyDate(detail.endsOn)} · {detail.teams.length}{' '}
            {detail.teams.length === 1 ? 'team' : 'teams'}
          </p>
          <StandingsTable standings={detail.standings} />
          <button type="button" className="btn ghost btn-sm" onClick={() => onOpen(detail.id)}>
            Open {detail.name}
          </button>
        </>
      )}
    </section>
  );
}

/**
 * ＋ Friendly on an organization's or region's Games tab (Shadi, 10/20): its
 * staff pick the two teams. It goes straight on both calendars when the
 * caller approves for both sides; across regions a region's staff approve
 * their side and the other region (or the organization) is asked.
 */
function ScopeFriendlyForm({
  teams,
  onCancel,
  onDone,
}: {
  teams: Array<{ id: string; name: string; regionName: string | null }>;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [opponents, setOpponents] = useState<Array<{ id: string; name: string; regionName: string | null }> | null>(null);
  const [date, setDate] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [location, setLocation] = useState('');
  const [field, setField] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = useRegionFields(home ? { teamId: home } : null);

  // The away team comes from the home team's organization, any region.
  useEffect(() => {
    setAway('');
    setOpponents(null);
    if (!home) return;
    api
      .friendlyOpponents(home)
      .then((r) => setOpponents(r.opponents))
      .catch(() => setOpponents([]));
  }, [home]);

  const label = (t: { name: string; regionName: string | null }) => (t.regionName ? `${t.name} · ${t.regionName}` : t.name);
  const awayTeam = opponents?.find((o) => o.id === away) ?? null;

  async function save() {
    if (!awayTeam) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createFriendly({
        teamId: home,
        opponent: awayTeam.name,
        opponentTeamId: awayTeam.id,
        date,
        kickoff,
        isHome: true,
        location: location.trim(),
        field: field.trim() || undefined,
      });
      onDone(
        r.status === 'pending'
          ? `Saved. It goes on both calendars once ${r.waitingFor ?? 'the other region'} approves it.`
          : 'Friendly added to both teams’ calendars. Both teams have been told.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the friendly');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="comp-form">
      <p className="sub">A friendly between two of your teams. It never counts toward standings.</p>
      {error && <p className="danger-text">{error}</p>}
      <div className="field-grid">
        <label>
          Home team
          <select value={home} onChange={(e) => setHome(e.target.value)}>
            <option value="">Pick a team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {label(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Away team
          <select value={away} disabled={!home || !opponents} onChange={(e) => setAway(e.target.value)}>
            <option value="">{home && !opponents ? 'Loading…' : 'Pick a team'}</option>
            {(opponents ?? []).map((t) => (
              <option key={t.id} value={t.id}>
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
          <LocationInput value={location} onChange={setLocation} label="Location" placeholder="e.g. Central Park" presets={fields} />
        </label>
        <label>
          Field number (optional)
          <input value={field} maxLength={40} onChange={(e) => setField(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !home || !awayTeam || !date || !kickoff || !location.trim()}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Add friendly'}
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}