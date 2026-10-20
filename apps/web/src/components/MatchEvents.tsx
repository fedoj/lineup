import { useMemo, useState } from 'react';
import type { GameEventKind, Player } from '@lineup/shared';
import { api, type GameEvent } from '../lib/api';
import { PaidLock, useFeature } from '../lib/features';

/** What a free plan may log: the score, assists and cards. Mirrors the API. */
const FREE_KINDS = new Set<string>(['goal', 'own_goal', 'assist', 'yellow', 'red']);

interface Props {
  gameId: string;
  players: Player[];
  events: GameEvent[];
  periodIndex: number;
  periodLabel: string;
  clockSec: number;
  /** False when the period clock has never been run, so time is left blank. */
  clockStarted: boolean;
  canEdit: boolean;
  onChange: (events: GameEvent[]) => void;
  /** Goals move the scoreline server-side, so the game must be re-read. */
  onScoreChange: () => void;
}

/** Quick-log buttons. `needsPlayer` ones open the player picker first. */
const ACTIONS: Array<{
  kind: GameEventKind;
  label: string;
  icon: string;
  needsPlayer: boolean;
}> = [
  { kind: 'goal', label: 'Goal', icon: '⚽', needsPlayer: true },
  { kind: 'own_goal', label: 'Own goal', icon: '🙈', needsPlayer: true },
  { kind: 'save', label: 'Save', icon: '🧤', needsPlayer: true },
  { kind: 'near_goal_clearance', label: 'Goal-line clearance', icon: '🧱', needsPlayer: true },
  { kind: 'corner', label: 'Corner', icon: '🚩', needsPlayer: false },
  { kind: 'foul', label: 'Foul', icon: '✋', needsPlayer: false },
  { kind: 'yellow', label: 'Yellow', icon: '🟨', needsPlayer: true },
  { kind: 'red', label: 'Red', icon: '🟥', needsPlayer: true },
];

const KIND_LABEL: Record<string, string> = {
  goal: 'Goal',
  own_goal: 'Own goal',
  assist: 'Assist',
  save: 'Save',
  near_goal_clearance: 'Goal-line clearance',
  corner: 'Corner',
  foul: 'Foul',
  yellow: 'Yellow card',
  red: 'Red card',
  shot: 'Shot',
  penalty: 'Penalty',
  sub: 'Substitution',
};

const KIND_ICON: Record<string, string> = {
  goal: '⚽',
  own_goal: '🙈',
  assist: '🅰️',
  save: '🧤',
  near_goal_clearance: '🧱',
  corner: '🚩',
  foul: '✋',
  yellow: '🟨',
  red: '🟥',
  shot: '🎯',
  penalty: '⚪',
  sub: '🔁',
};

function mmss(sec: number | null): string {
  if (sec === null) return '';
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function MatchEvents({
  gameId,
  players,
  events,
  periodIndex,
  periodLabel,
  clockSec,
  clockStarted,
  canEdit,
  onChange,
  onScoreChange,
}: Props) {
  const [side, setSide] = useState<'us' | 'them'>('us');
  const [pending, setPending] = useState<GameEventKind | null>(null);
  const [scorer, setScorer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fullStats = useFeature('fullStats');

  const nameOf = useMemo(() => {
    const m = new Map(players.map((p) => [p.id, p]));
    return (id: string | null) => {
      if (!id) return null;
      const p = m.get(id);
      return p ? `${p.number ? `#${p.number} ` : ''}${p.name}` : 'Unknown';
    };
  }, [players]);

  const tally = useMemo(() => {
    const t = { goals: 0, against: 0, corners: 0, fouls: 0, yellow: 0, red: 0 };
    for (const e of events) {
      if (e.kind === 'goal') (e.against ? (t.against += 1) : (t.goals += 1));
      else if (e.kind === 'own_goal') (e.against ? (t.goals += 1) : (t.against += 1));
      else if (!e.against) {
        if (e.kind === 'corner') t.corners += 1;
        else if (e.kind === 'foul') t.fouls += 1;
        else if (e.kind === 'yellow') t.yellow += 1;
        else if (e.kind === 'red') t.red += 1;
      }
    }
    return t;
  }, [events]);

  async function log(kind: GameEventKind, playerId: string | null, assistId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.addEvent(gameId, {
        kind,
        playerId,
        assistId,
        periodIndex,
        // Only stamp a match minute when the clock has actually been run —
        // otherwise every event would claim to have happened at 0:00.
        clockSec: clockStarted ? Math.floor(clockSec) : null,
        against: side === 'them',
      });
      onChange([...events, created]);
      if (kind === 'goal' || kind === 'own_goal') onScoreChange();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      setPending(null);
      setScorer(null);
    }
  }

  function start(kind: GameEventKind, needsPlayer: boolean) {
    setError(null);
    // Opposition events are never attributed to one of our players.
    if (!needsPlayer || side === 'them') {
      void log(kind, null, null);
      return;
    }
    setPending(kind);
    setScorer(null);
  }

  async function remove(e: GameEvent) {
    setBusy(true);
    try {
      await api.deleteEvent(gameId, e.id);
      onChange(events.filter((x) => x.id !== e.id));
      if (e.kind === 'goal' || e.kind === 'own_goal') onScoreChange();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const squad = players.filter((p) => p.active);
  const pickingAssist = pending === 'goal' && scorer !== null;

  return (
    <section className="card events">
      <div className="card-head">
        <h2>Match events</h2>
        <div className="side-toggle" role="group" aria-label="Which team">
          <button
            type="button"
            className={side === 'us' ? 'on' : ''}
            onClick={() => setSide('us')}
            aria-pressed={side === 'us'}
          >
            Us
          </button>
          <button
            type="button"
            className={side === 'them' ? 'on' : ''}
            onClick={() => setSide('them')}
            aria-pressed={side === 'them'}
          >
            Them
          </button>
        </div>
      </div>

      <div className="tally">
        <span className="tally-score">
          {tally.goals}–{tally.against}
        </span>
        <span className="tally-item" title="Corners">
          🚩 {tally.corners}
        </span>
        <span className="tally-item" title="Fouls">
          ✋ {tally.fouls}
        </span>
        <span className="tally-item" title="Yellow cards">
          🟨 {tally.yellow}
        </span>
        <span className="tally-item" title="Red cards">
          🟥 {tally.red}
        </span>
      </div>

      {error && <p className="danger-text">{error}</p>}

      {canEdit && !pending && (
        <>
          <p className="note">
            Logging for <strong>{side === 'us' ? 'our team' : 'the opposition'}</strong> ·{' '}
            {periodLabel}{' '}
            {clockStarted ? (
              <span className="live-min">{mmss(clockSec)}</span>
            ) : (
              <span className="muted-inline">clock not started — no match time recorded</span>
            )}
          </p>
          <div className="event-actions">
            {ACTIONS.map((a) => {
              const locked = !fullStats && !FREE_KINDS.has(a.kind);
              return (
                <button
                  key={a.kind}
                  type="button"
                  className={`btn ghost event-btn${locked ? ' locked' : ''}`}
                  disabled={busy || locked}
                  title={locked ? `${a.label}: premium feature` : undefined}
                  onClick={() => start(a.kind, a.needsPlayer)}
                >
                  <span aria-hidden="true">{locked ? '🔒' : a.icon}</span>
                  {a.label}
                </button>
              );
            })}
          </div>
          {!fullStats && (
            <PaidLock feature="fullStats" what="Saves, clearances, corners and fouls" />
          )}
        </>
      )}

      {canEdit && pending && (
        <div className="picker">
          <p className="note">
            {pickingAssist
              ? `Assisted by? (${KIND_LABEL[pending]} — ${nameOf(scorer)})`
              : `Who? (${KIND_LABEL[pending]})`}
          </p>
          <ul className="chips">
            {squad.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="chip"
                  disabled={busy || p.id === scorer}
                  onClick={() => {
                    if (pending === 'goal' && scorer === null) setScorer(p.id);
                    else if (pickingAssist) void log(pending, scorer, p.id);
                    else void log(pending, p.id, null);
                  }}
                >
                  <span className="chip-num">{p.number || '—'}</span>
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            {pickingAssist && (
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => void log(pending, scorer, null)}
              >
                No assist
              </button>
            )}
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setPending(null);
                setScorer(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <ul className="timeline">
          {[...events]
            .sort(
              (a, b) =>
                (a.periodIndex ?? 0) - (b.periodIndex ?? 0) ||
                (a.clockSec ?? 0) - (b.clockSec ?? 0),
            )
            .map((e) => (
              <li key={e.id} className={e.against ? 'them' : 'us'}>
                <span className="t-icon" aria-hidden="true">
                  {KIND_ICON[e.kind] ?? '•'}
                </span>
                <span className="t-main">
                  <strong>{KIND_LABEL[e.kind] ?? e.kind}</strong>
                  {e.against ? (
                    <span className="t-sub">Opposition</span>
                  ) : (
                    e.playerId && <span className="t-sub">{nameOf(e.playerId)}</span>
                  )}
                  {e.assistId && <span className="t-sub">assist {nameOf(e.assistId)}</span>}
                </span>
                <span className="t-time">
                  {e.periodIndex !== null ? `P${e.periodIndex + 1}` : ''}
                  {e.clockSec !== null ? ` ${mmss(e.clockSec)}` : ''}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="chip-x"
                    title="Remove"
                    disabled={busy}
                    onClick={() => void remove(e)}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
