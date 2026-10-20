import { useState } from 'react';
import { dueSubs, type Player } from '@lineup/shared';
import { api, type PlannedSub } from '../lib/api';
import { mmss } from '../lib/clock';

const who = (players: Player[], id: string) => {
  const p = players.find((x) => x.id === id);
  return p ? `${p.number ? `#${p.number} ` : ''}${p.name}` : 'Player';
};

/**
 * "Sub now" while the period clock runs (Fady, 10/17): every planned sub the
 * clock has reached, with Done (recorded, minutes move to the player coming
 * on) and Skip.
 */
export function SubsDue({
  subs,
  periodIndex,
  elapsed,
  players,
  canEdit,
  onChange,
}: {
  subs: PlannedSub[];
  periodIndex: number;
  elapsed: number;
  players: Player[];
  canEdit: boolean;
  onChange: (s: PlannedSub[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const due = dueSubs(subs, periodIndex, elapsed);
  if (!canEdit || due.length === 0) return null;
  const act = async (action: 'done' | 'skip', id: string) => {
    setBusy(true);
    try {
      onChange((await api.subAction({ action, id })).subs);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card sub-due" role="alert">
      {due.map((s) => (
        <div key={s.id} className="sub-due-row">
          <span>
            🔁 <strong>Sub now</strong> ({mmss(s.atSec)}): {who(players, s.onPlayerId)} on for {who(players, s.offPlayerId)}
          </span>
          <span className="row">
            <button type="button" className="btn btn-sm btn-good" disabled={busy} onClick={() => void act('done', s.id)}>
              Done
            </button>
            <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void act('skip', s.id)}>
              Skip
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}

/** Plan this period's subs: when, who comes off, who comes on. */
export function PlannedSubs({
  gameId,
  periodIndex,
  periodLabel,
  lengthSec,
  players,
  onPitchIds,
  absentIds,
  subs,
  canEdit,
  onChange,
}: {
  gameId: string;
  periodIndex: number;
  periodLabel: string;
  lengthSec: number;
  players: Player[];
  onPitchIds: Set<string>;
  absentIds: Set<string>;
  subs: PlannedSub[];
  canEdit: boolean;
  onChange: (s: PlannedSub[]) => void;
}) {
  const mine = subs.filter((s) => s.periodIndex === periodIndex);
  const [adding, setAdding] = useState(false);
  const [minute, setMinute] = useState(String(Math.round(lengthSec / 120)));
  const [second, setSecond] = useState('00');
  const [off, setOff] = useState('');
  const [on, setOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPitch = players.filter((p) => onPitchIds.has(p.id));
  const bench = players.filter((p) => p.active && !onPitchIds.has(p.id) && !absentIds.has(p.id));
  const atSec = Number(minute) * 60 + Number(second);
  const valid = Boolean(off && on && off !== on) && Number.isFinite(atSec) && atSec >= 0 && atSec <= lengthSec;

  async function act(fn: () => Promise<{ subs: PlannedSub[] }>) {
    setBusy(true);
    setError(null);
    try {
      onChange((await fn()).subs);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit && mine.length === 0) return null;

  return (
    <section className="card planned-subs">
      <div className="card-head">
        <h3>
          Planned subs · {periodLabel} <span className="count">{mine.length}</span>
        </h3>
        {canEdit && !adding && (
          <button type="button" className="btn btn-sm ghost" onClick={() => setAdding(true)}>
            ＋ Plan a sub
          </button>
        )}
      </div>
      {mine.length === 0 ? (
        <p className="note">No subs planned for this period. Plan them ahead and match day reminds you when the clock gets there.</p>
      ) : (
        <ul className="sub-list">
          {mine.map((s) => (
            <li key={s.id} className={s.done || s.skipped ? 'sub-done' : ''}>
              <span className="sub-time">{mmss(s.atSec)}</span>
              <span className="sub-what">
                {who(players, s.onPlayerId)} <span className="sub">on for</span> {who(players, s.offPlayerId)}
              </span>
              <span className="sub-state">
                {s.done ? '✓ Done' : s.skipped ? 'Skipped' : ''}
                {canEdit && (s.done || s.skipped) && (
                  <button type="button" className="linkish" disabled={busy} onClick={() => void act(() => api.subAction({ action: 'undo', id: s.id }))}>
                    Undo
                  </button>
                )}
                {canEdit && !s.done && (
                  <button type="button" className="linkish" disabled={busy} onClick={() => void act(() => api.subAction({ action: 'remove', id: s.id }))}>
                    Remove
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="comp-form">
          <div className="field-grid">
            <label>
              At (period clock)
              <span className="row sub-at">
                <input type="number" inputMode="numeric" min={0} max={Math.floor(lengthSec / 60)} value={minute} onChange={(e) => setMinute(e.target.value)} aria-label="Minutes" />
                :
                <select value={second} onChange={(e) => setSecond(e.target.value)} aria-label="Seconds">
                  {['00', '15', '30', '45'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <label>
              Comes off
              <select value={off} onChange={(e) => setOff(e.target.value)}>
                <option value="">Pick a player…</option>
                {onPitch.map((p) => (
                  <option key={p.id} value={p.id}>
                    {who(players, p.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Comes on
              <select value={on} onChange={(e) => setOn(e.target.value)}>
                <option value="">Pick a player…</option>
                {bench.map((p) => (
                  <option key={p.id} value={p.id}>
                    {who(players, p.id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {onPitch.length === 0 && <p className="note">Set this period’s lineup first: subs replace someone on the pitch.</p>}
          {error && <p className="danger-text">{error}</p>}
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !valid}
              onClick={async () => {
                const ok = await act(() =>
                  api.subAction({ action: 'add', gameId, periodIndex, atSec, offPlayerId: off, onPlayerId: on }),
                );
                if (ok) {
                  setOff('');
                  setOn('');
                  setAdding(false);
                }
              }}
            >
              Add sub
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
