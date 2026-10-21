import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  formationNames,
  periodCount,
  periodLabels,
  type Assignments,
  type Format,
  type Game,
  type Periods,
  type Player,
} from '@lineup/shared';
import Pitch from '../components/Pitch';
import PeriodClock from '../components/PeriodClock';
import MatchEvents from '../components/MatchEvents';
import { CustomStatsTracker } from '../components/CustomStats';
import { PlannedSubs, SubsDue } from '../components/PlannedSubs';
import { useLiveClock } from '../lib/clock';
import { PaidLock, useFeature } from '../lib/features';
import { renderLineupImage } from '../lib/exportImages';
import { canvasBlob, fileSlug, shareFile } from '../lib/shareFile';
import {
  api,
  type Availability,
  type GameEvent,
  type GamePeriod,
  type LineupProposalState,
  type PlannedSub,
} from '../lib/api';

/** Match day is stepped rather than scrolled: one job on screen at a time. */
type Section = 'lineup' | 'events';

interface Props {
  game: Game;
  games: Game[];
  players: Player[];
  /** For the exported lineup picture. */
  teamName?: string;
  canEdit: boolean;
  onGameChange: (g: Game) => void;
}

export default function MatchDay({ game, games, players: roster, teamName = '', canEdit, onGameChange }: Props) {
  // Approved guests borrowed from other teams play here too (Fady, 10/18).
  const [guestPlayers, setGuestPlayers] = useState<Player[]>([]);
  useEffect(() => {
    let live = true;
    setGuestPlayers([]);
    api
      .gameGuests(game.teamId)
      .then((g) => {
        if (!live) return;
        setGuestPlayers(
          g.outgoing
            .filter((x) => x.gameId === game.id && x.status === 'approved')
            .map((x) => ({
              id: x.playerId,
              teamId: game.teamId,
              number: x.number ?? '',
              name: `${x.playerName} (guest)`,
              active: true,
              gender: null,
              primaryPos: null,
              secondaryPos: null,
              neverKeeper: false,
            })),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [game.id, game.teamId]);
  const players = useMemo(
    () => [...roster, ...guestPlayers.filter((g) => !roster.some((p) => p.id === g.id))],
    [roster, guestPlayers],
  );
  const [periods, setPeriods] = useState<GamePeriod[]>([]);
  const [availability, setAvailability] = useState<Availability[]>([]);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [subs, setSubs] = useState<PlannedSub[]>([]);
  const [assignments, setAssignments] = useState<Assignments>(game.assignments ?? {});
  const [current, setCurrent] = useState(0);
  const [section, setSection] = useState<Section>('lineup');
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Assistant coach proposals: what is waiting, and what the caller may do.
  const [approval, setApproval] = useState<LineupProposalState | null>(null);
  const [showProposal, setShowProposal] = useState(false);
  const clockUnlocked = useFeature('matchClock');

  const labels = periodLabels(game.periods as Periods);
  const count = periodCount(game.periods as Periods);

  const absentIds = useMemo(
    () =>
      new Set(
        availability.filter((a) => a.status === 'absent' || a.status === 'injured')
          .map((a) => a.player_id),
      ),
    [availability],
  );

  const refreshApproval = useCallback(async () => {
    setApproval(await api.lineupProposal(game.id).catch(() => null));
  }, [game.id]);

  const load = useCallback(async () => {
    const [p, a, e, ap, s] = await Promise.all([
      api.periods(game.id),
      api.availability(game.id),
      api.events(game.id),
      api.lineupProposal(game.id).catch(() => null),
      api.subs(game.id).catch(() => ({ subs: [] as PlannedSub[] })),
    ]);
    setPeriods(p);
    setAvailability(a);
    setEvents(e);
    setApproval(ap);
    setSubs(s.subs);
  }, [game.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setAssignments(game.assignments ?? {});
  }, [game.id, game.assignments]);

  /**
   * Persisting a lineup is not enough — the parent holds the authoritative
   * game list, and remounting this screen re-seeds state from it. Without
   * pushing the new assignments up, switching tabs looked like the lineup
   * had never saved.
   */
  const applyAssignments = useCallback(
    (next: Assignments) => {
      setAssignments(next);
      onGameChange({ ...game, assignments: next });
    },
    [game, onGameChange],
  );

  /** Re-read the game after the server recalculates the score from events. */
  const refreshGame = useCallback(async () => {
    const fresh = await api.listGames(game.teamId);
    const g = fresh.find((x) => x.id === game.id);
    if (g) onGameChange(g);
  }, [game.id, game.teamId, onGameChange]);

  /**
   * A lineup change came back: saved on the game, or (an assistant before the
   * game) saved as the proposal the coach approves.
   */
  async function applyResult(res: { assignments: Assignments; proposal?: boolean }) {
    if (res.proposal) {
      // Show the change at once; the refresh below brings who proposed it and when.
      setApproval((a) =>
        a && {
          ...a,
          proposal: {
            formations: {},
            proposedBy: null,
            proposedByName: null,
            updatedAt: new Date().toISOString(),
            ...(a.proposal ?? {}),
            assignments: res.assignments,
          },
        },
      );
      await refreshApproval();
    } else {
      applyAssignments(res.assignments);
    }
  }

  const proposal = approval?.proposal ?? null;
  // An assistant works on their proposal; a coach can look at it before deciding.
  const viewingProposal = Boolean(proposal && (approval?.needsApproval || (approval?.canApprove && showProposal)));
  const shown = viewingProposal ? proposal!.assignments : assignments;
  const editable = canEdit && !(approval?.canApprove && showProposal);

  const period = periods.find((p) => p.periodIndex === current);
  const formation = (viewingProposal ? proposal!.formations[String(current)] : undefined) ?? period?.formation ?? game.formation;
  const assignment = shown[String(current)] ?? {};
  const onPitchIds = new Set(Object.values(assignment));

  /** Tap a slot: place the selected player, or pick up whoever is there. */
  async function handleSlot(slotId: string, occupiedBy: string | null) {
    if (!editable) return;

    if (selected) {
      const res = await api.placePlayer(game.id, current, slotId, selected);
      await applyResult(res);
      setSelected(null);
      return;
    }
    if (occupiedBy) {
      // Tapping a filled slot lifts that player back to the bench.
      const res = await api.placePlayer(game.id, current, slotId, null);
      await applyResult(res);
      setSelected(occupiedBy);
    }
  }

  async function auto() {
    setBusy(true);
    try {
      const res = await api.autoLineup(game.id);
      await applyResult(res);
      const r = res.report;
      setNote(
        r
          ? r.warnings.length
            ? r.warnings.join(' ')
            : `Filled all ${count} periods. Playing time spread: ${r.spread}.`
          : null,
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyFrom(sourceId: string) {
    setBusy(true);
    try {
      const res = await api.copyLineup(game.id, sourceId);
      await applyResult(res);
      const dropped = res.report?.dropped?.length ?? 0;
      setNote(dropped ? `Copied. ${dropped} player(s) no longer eligible were left out.` : 'Copied.');
    } finally {
      setBusy(false);
    }
  }

  async function clearLineup() {
    setBusy(true);
    try {
      const res = await api.clearLineup(game.id);
      await applyResult(res);
      setNote('Lineup cleared.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleAbsent(playerId: string) {
    const isAbsent = absentIds.has(playerId);
    const next = await api.setAvailability(
      game.id,
      playerId,
      isAbsent ? 'available' : 'absent',
    );
    setAvailability(next);
    // Marking absent strips them from the lineup (and any proposal) server-side; re-read it.
    if (!isAbsent) {
      const fresh = await api.listGames(game.teamId);
      const g = fresh.find((x) => x.id === game.id);
      if (g) {
        setAssignments(g.assignments ?? {});
        onGameChange(g);
      }
      if (proposal) await refreshApproval();
    }
  }

  async function setFormation(f: string) {
    const next = await api.clock(game.id, current, 'setFormation', { formation: f });
    setPeriods(next);
    if (approval?.needsApproval) await refreshApproval();
  }

  /** A coach approves or rejects the assistant's proposal. */
  async function decide(action: 'approve' | 'reject') {
    setBusy(true);
    try {
      const state = await api.lineupProposalAction({ gameId: game.id, action });
      setApproval(state);
      setShowProposal(false);
      if (action === 'approve') {
        const fresh = await api.listGames(game.teamId);
        const g = fresh.find((x) => x.id === game.id);
        if (g) {
          setAssignments(g.assignments ?? {});
          onGameChange(g);
        }
        setPeriods(await api.periods(game.id));
      }
      setNote(action === 'approve' ? 'Approved. The lineup is updated.' : 'Not approved. The lineup stays as it was.');
    } finally {
      setBusy(false);
    }
  }

  async function setAssistantFree(value: boolean) {
    setApproval(await api.lineupProposalAction({ gameId: game.id, action: 'assistantFree', value }));
  }

  async function clock(action: 'start' | 'pause' | 'reset' | 'end') {
    const next = await api.clock(game.id, current, action);
    setPeriods(next);
  }

  const bench = players.filter((p) => p.active && !onPitchIds.has(p.id));

  // Match time is read from the same live clock the display uses, so an event
  // is stamped with exactly the minute that was on screen when it was tapped.
  const { elapsed, started } = useLiveClock(period);

  const SECTIONS: Array<[Section, string, string]> = [
    ['lineup', 'Lineup', '👥'],
    ['events', 'Stats', '⚽'],
  ];

  return (
    <div className="matchday">
      {game.lineupHidden && (
        <section className="card" role="status">
          <p className="note">
            The lineup for this game is shared on game day, at the same time for every family.
          </p>
        </section>
      )}
      <nav className="period-tabs" aria-label="Periods">
        {Array.from({ length: count }, (_, i) => (
          <button
            key={i}
            type="button"
            className={i === current ? 'on' : ''}
            onClick={() => {
              setCurrent(i);
              setSelected(null);
            }}
          >
            {labels[i]}
          </button>
        ))}
      </nav>

      {/* The clock stays out of the tabs: it has to be readable and
          controllable no matter which section you are working in. */}
      {period && clockUnlocked && (
        <PeriodClock
          period={period}
          label={labels[current]}
          readOnly={!canEdit}
          onStart={() => clock('start')}
          onPause={() => clock('pause')}
          onReset={() => clock('reset')}
          onEnd={() => clock('end')}
        />
      )}
      {period && !clockUnlocked && <PaidLock feature="matchClock" what="Match clock" className="card" />}

      {/* Planned subs pop up here once the period clock reaches them. */}
      {started && (
        <SubsDue
          subs={subs}
          periodIndex={current}
          elapsed={elapsed}
          players={players}
          canEdit={canEdit}
          onChange={(next) => {
            setSubs(next);
            void api.events(game.id).then(setEvents).catch(() => undefined);
          }}
        />
      )}

      <nav className="step-tabs" aria-label="Match day sections">
        {SECTIONS.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={section === id ? 'on' : ''}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setSection(id)}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
            {id === 'events' && events.length > 0 && (
              <span className="step-badge">{events.length}</span>
            )}
          </button>
        ))}
      </nav>

      {note && (
        <p className="note" role="status">
          {note}
        </p>
      )}

      {/* Assistant coach proposals: the assistant sees that changes wait for
          the coach; the coach sees what is waiting, and decides. */}
      {approval?.needsApproval && canEdit && (
        <section className="card approval-card" role="status">
          <p className="note">
            {proposal
              ? `Your lineup changes are waiting for the coach's approval (since ${new Date(proposal.updatedAt).toLocaleString()}). Keep editing; the coach sees the latest.`
              : 'Before the game, your formation and lineup changes go to the coach for approval. Marking players absent applies straight away, and during the game your changes apply at once.'}
          </p>
        </section>
      )}
      {approval?.canApprove && proposal && (
        <section className="card approval-card" role="status">
          <p>
            <strong>{proposal.proposedByName ?? 'Your assistant coach'}</strong> proposed lineup changes.
          </p>
          <div className="row">
            <button type="button" className="btn ghost btn-sm" onClick={() => setShowProposal((v) => !v)}>
              {showProposal ? 'Show current lineup' : 'Show proposal'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decide('approve')}>
              Approve
            </button>
            <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void decide('reject')}>
              Reject
            </button>
          </div>
          {showProposal && <p className="note">You are looking at the proposal. Approve it to make it the lineup.</p>}
        </section>
      )}

      {/* One panel at a time. `key` on the wrapper restarts the slide-in so
          moving between sections reads as a step rather than a redraw. */}
      <div className="step-panel" key={`${current}-${section}`}>
        {section === 'lineup' && (
          <>
            {editable && (
              <p className="note tagline">
                Setting formations and lineups has never been easier ⚡ Drag players into place, and every game you
                save builds a history of what worked.
              </p>
            )}
            {editable && (
              <div className="matchday-tools">
                <div className="matchday-tools-row">
                  <label>
                    Formation
                    <select value={formation} onChange={(e) => setFormation(e.target.value)}>
                      {formationNames(game.format as Format).map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>

                  {games.length > 1 && (
                    <label>
                      Copy from
                      <select
                        defaultValue=""
                        onChange={(e) => e.target.value && copyFrom(e.target.value)}
                      >
                        <option value="">Previous game…</option>
                        {games
                          .filter((g) => g.id !== game.id)
                          .map((g) => (
                            <option key={g.id} value={g.id}>
                              #{g.gameNo} {g.opponent || 'TBD'}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </div>

                <div className="matchday-tools-row buttons">
                  <button type="button" className="btn" onClick={auto} disabled={busy}>
                    Auto formation
                  </button>
                  <button type="button" className="btn ghost" onClick={clearLineup} disabled={busy}>
                    Clear
                  </button>
                </div>
                {approval?.canApprove && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={approval.assistantFree}
                      onChange={(e) => void setAssistantFree(e.target.checked)}
                    />{' '}
                    Assistant coach can change this lineup without my approval
                  </label>
                )}
              </div>
            )}

            {canEdit && (
              <ExportLineup
                teamName={teamName}
                game={game}
                count={count}
                labels={labels}
                formationOf={(i) =>
                  (viewingProposal ? proposal!.formations[String(i)] : undefined) ??
                  periods.find((p) => p.periodIndex === i)?.formation ??
                  game.formation
                }
                assignmentOf={(i) => shown[String(i)] ?? {}}
                players={players}
                absentIds={absentIds}
              />
            )}

            <Pitch
              format={game.format as Format}
              formation={formation}
              assignment={assignment}
              players={players}
              absentIds={absentIds}
              selectedPlayerId={selected}
              onSlotClick={handleSlot}
              readOnly={!editable}
            />

            <section className="bench">
              <h3>
                Bench <span className="count">{bench.length}</span>
                {selected && <span className="hint">Tap an empty spot to place</span>}
              </h3>
              <ul className="chips">
                {bench.map((p) => {
                  const absent = absentIds.has(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`chip ${selected === p.id ? 'on' : ''} ${absent ? 'absent' : ''}`}
                        disabled={!editable || absent}
                        onClick={() => setSelected(selected === p.id ? null : p.id)}
                      >
                        <span className="chip-num">{p.number || '—'}</span>
                        {p.name}
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          className="chip-x"
                          title={absent ? 'Mark available' : 'Mark absent'}
                          onClick={() => toggleAbsent(p.id)}
                        >
                          {absent ? '↩' : '✕'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <PlannedSubs
              gameId={game.id}
              periodIndex={current}
              periodLabel={labels[current]}
              lengthSec={period?.lengthSec ?? game.periodLengthSec ?? 720}
              players={players}
              onPitchIds={onPitchIds}
              absentIds={absentIds}
              subs={subs}
              canEdit={canEdit}
              onChange={(next) => {
                setSubs(next);
                void api.events(game.id).then(setEvents).catch(() => undefined);
              }}
            />
          </>
        )}

        {section === 'events' && (
          <>
            <MatchEvents
              gameId={game.id}
              players={players}
              events={events}
              periodIndex={current}
              periodLabel={labels[current]}
              clockSec={elapsed}
              clockStarted={started}
              canEdit={canEdit}
              onChange={setEvents}
              onScoreChange={refreshGame}
            />
            <CustomStatsTracker gameId={game.id} teamId={game.teamId} players={players} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Export the lineup as one picture (Fady, 10/19): every quarter (four pitches)
 * or half (two) on one page, on white so it prints. Made on the phone and
 * shared or downloaded; nothing is kept on Lineup. A premium feature (sharing).
 */
function ExportLineup({
  teamName,
  game,
  count,
  labels,
  formationOf,
  assignmentOf,
  players,
  absentIds,
}: {
  teamName: string;
  game: Game;
  count: number;
  labels: string[];
  formationOf: (i: number) => string;
  assignmentOf: (i: number) => Record<string, string>;
  players: Player[];
  absentIds: Set<string>;
}) {
  const allowed = useFeature('longShareLinks');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(download: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const canvas = renderLineupImage({
        teamName: teamName || 'Our team',
        opponent: game.opponent,
        date: game.date || null,
        kickoff: game.kickoff ?? null,
        format: game.format as Format,
        periods: Array.from({ length: count }, (_, i) => ({ label: labels[i], formation: formationOf(i), assignment: assignmentOf(i) })),
        players: players.map((p) => ({ id: p.id, name: p.name, number: p.number, active: p.active })),
        absentIds,
      });
      const out = await shareFile(
        await canvasBlob(canvas),
        `${fileSlug(`${teamName}-${game.opponent || 'game'}`)}-lineup.png`,
        `${teamName} lineup`,
        download,
      );
      setMsg(out === 'downloaded' ? 'Saved the lineup picture. You can print it or send it.' : out === 'shared' ? 'Shared.' : null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not make the picture');
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="lineup-export">
        <PaidLock feature="longShareLinks" what="Exporting the lineup as a picture" />
      </div>
    );
  }
  return (
    <div className="lineup-export row">
      <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void run(false)}>
        🖼️ Share lineup picture
      </button>
      <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void run(true)}>
        🖨️ Download to print
      </button>
      <span className="sub">All {count === 2 ? 'both halves' : `${count} quarters`} on one page</span>
      {msg && (
        <span className="note" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}
