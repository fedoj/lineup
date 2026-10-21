import { useCallback, useEffect, useState } from 'react';
import { cardRating, cardStats, cardTier, defaultAvatarFor, EVALUATION_CATEGORIES, EVALUATION_MAX, overallRating } from '@lineup/shared';
import { api, apiPath, peek, type Evaluations, type PlayerEvaluation } from '../lib/api';
import { PaidLock } from '../lib/features';
import PlayerAvatar from './PlayerAvatar';
import { AvatarEditor, CardStack, PlayerCard } from './PlayerCard';

const FOOT_LABEL: Record<string, string> = { left: 'Left foot', right: 'Right foot', both: 'Both feet' };
const SCALE = Array.from({ length: EVALUATION_MAX }, (_, i) => i + 1);

/** The card number out of 99, coloured like the card. */
export function Rating({ ev }: { ev: PlayerEvaluation }) {
  const r = ev.card?.rating ?? null;
  if (r === null) return <span className="sub">Not rated yet</span>;
  return (
    <span className={`eval-overall pc-chip ${ev.card?.tier ?? 'bronze'}`} title={`Overall ${r} out of 99`}>
      {r}
    </span>
  );
}

/**
 * Team & roster, under a player (Fady, 10/18: evaluation merged into the
 * roster): "Evaluate" opens the player's card and the 1 to 10 ratings for
 * coaches and assistant coaches (read only for organization and region
 * staff), and "Design avatar" for a parent's own child.
 */
export function RosterEvaluation({
  ev,
  data,
  onChanged,
}: {
  ev: PlayerEvaluation | undefined;
  data: Evaluations | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [designing, setDesigning] = useState(false);
  if (!data || !ev) return null;
  if (data.locked) return <PaidLock feature="playerEvaluation" what="Player evaluation and the player card" />;
  const label =
    data.mode === 'edit' ? (open ? 'Close' : ev.overall === null ? 'Evaluate' : 'Evaluate · edit') : open ? 'Close card' : 'Player card';
  return (
    <div className="roster-eval">
      <div className="row">
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {label}
        </button>
        {ev.canEditAvatar && !data.avatarLocked && !designing && (
          <button type="button" className="btn ghost btn-sm" onClick={() => setDesigning(true)}>
            {ev.avatar ? 'Change avatar' : 'Design avatar'}
          </button>
        )}
        {ev.strongFoot && <span className="pill">{FOOT_LABEL[ev.strongFoot]}</span>}
      </div>
      {designing && (
        <AvatarEditor
          playerId={ev.playerId}
          playerName={ev.playerName ?? 'Player'}
          initial={ev.avatar ?? defaultAvatarFor(ev.gender)}
          initialHeritage={ev.heritage ?? null}
          gender={ev.gender ?? null}
          onCancel={() => setDesigning(false)}
          onSaved={() => {
            setDesigning(false);
            onChanged();
          }}
        />
      )}
      {open &&
        (data.mode === 'overall' ? (
          <PlayerCard ev={ev} />
        ) : (
          <EvaluationForm
            ev={ev}
            readOnly={data.mode !== 'edit'}
            onSaved={() => {
              setOpen(false);
              onChanged();
            }}
          />
        ))}
    </div>
  );
}

function EvaluationForm({ ev, readOnly, onSaved }: { ev: PlayerEvaluation; readOnly: boolean; onSaved: () => void }) {
  const [scores, setScores] = useState<Record<string, number>>(ev.scores ?? {});
  const [foot, setFoot] = useState<string>(ev.strongFoot ?? '');
  const [notes, setNotes] = useState(ev.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The card updates as the coach taps, before saving.
  const rating = cardRating(scores);
  const preview: PlayerEvaluation = {
    ...ev,
    strongFoot: (foot || null) as PlayerEvaluation['strongFoot'],
    overall: overallRating(scores),
    card: { rating, stats: cardStats(scores), tier: cardTier(rating) },
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveEvaluation({ playerId: ev.playerId, scores, strongFoot: foot || null, notes: notes.trim() || null });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="eval-form">
      {error && <p className="danger-text">{error}</p>}
      <PlayerCard ev={preview} />
      <div className="eval-grid">
        {EVALUATION_CATEGORIES.map(([id, label]) => (
          <div key={id} className="eval-cat">
            <span>{label}</span>
            <div className="seg seg-10" role="radiogroup" aria-label={label}>
              {SCALE.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={scores[id] === n}
                  className={scores[id] === n ? 'on' : ''}
                  disabled={readOnly}
                  onClick={() =>
                    setScores((s) => {
                      const next = { ...s };
                      if (next[id] === n) delete next[id];
                      else next[id] = n;
                      return next;
                    })
                  }
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="field-grid">
        <label>
          Strong foot
          <select value={foot} disabled={readOnly} onChange={(e) => setFoot(e.target.value)}>
            <option value="">Not set</option>
            <option value="right">Right</option>
            <option value="left">Left</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label>
          Notes
          <input value={notes} maxLength={1000} disabled={readOnly} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <span>
          Overall: <strong>{rating ?? '–'}</strong> / 99
        </span>
        {!readOnly && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={save}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Parents and team parents, on the team's Stats tab: their own child's
 * FIFA-style player card with the big avatar (paid plans), and designing the
 * avatar (paid plans too, Fady 10/17).
 */
export function MyPlayerRating({ teamId }: { teamId: string }) {
  const [data, setData] = useState<Evaluations | null>(null);
  const [designing, setDesigning] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .evaluations(teamId)
      .then(setData)
      .catch(() => setData(null));
  }, [teamId]);
  useEffect(load, [load]);

  if (!data || data.mode !== 'overall') return null;
  if (data.evaluations.length === 0) {
    return (
      <section className="card">
        <h2>Your player</h2>
        <p className="note">Your child’s player card shows here once they are on this team’s roster.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{data.evaluations.length > 1 ? 'Your players' : 'Your player'}</h2>
      {data.locked ? (
        <div className="my-players">
          {data.evaluations.map((ev) => (
            <div key={ev.playerId} className="my-player-free">
              <PlayerAvatar avatar={ev.avatar ?? defaultAvatarFor(ev.gender)} size={140} title={`${ev.playerName} avatar`} />
              <strong>{ev.playerName}</strong>
              <PaidLock feature="playerEvaluation" what="Your child's player card" />
            </div>
          ))}
        </div>
      ) : (
        <CardStack
          items={data.evaluations}
          below={(ev) => (
            <AvatarControls
              ev={ev}
              locked={Boolean(data.avatarLocked)}
              designing={designing === ev.playerId}
              onDesign={() => setDesigning(ev.playerId)}
              onDone={() => {
                setDesigning(null);
                load();
              }}
            />
          )}
        />
      )}
    </section>
  );
}

/** "Design avatar" (or the lock) and the editor, for a parent's own child. */
function AvatarControls({
  ev,
  locked,
  designing,
  onDesign,
  onDone,
}: {
  ev: PlayerEvaluation;
  locked: boolean;
  designing: boolean;
  onDesign: () => void;
  onDone: () => void;
}) {
  if (!ev.canEditAvatar) return null;
  if (locked) return <PaidLock feature="playerEvaluation" what="Designing the avatar" />;
  if (designing) {
    return (
      <AvatarEditor
        playerId={ev.playerId}
        playerName={ev.playerName ?? 'Player'}
        initial={ev.avatar ?? defaultAvatarFor(ev.gender)}
          initialHeritage={ev.heritage ?? null}
          gender={ev.gender ?? null}
        onCancel={onDone}
        onSaved={onDone}
      />
    );
  }
  return (
    <button type="button" className="btn ghost btn-sm" onClick={onDesign}>
      {ev.avatar ? 'Change avatar' : 'Design avatar'}
    </button>
  );
}

/** Own children first, then best rating first. */
function stackOrder(list: PlayerEvaluation[]): PlayerEvaluation[] {
  return [...list].sort(
    (a, b) => Number(Boolean(b.canEditAvatar)) - Number(Boolean(a.canEditAvatar)) || (b.card?.rating ?? -1) - (a.card?.rating ?? -1),
  );
}

/**
 * The team's Stats tab, for coaches and staff: every player's FIFA-style
 * card with the big avatar, as a stack to swipe through (a coach's own
 * children first, then best first; ratings are set on Team & roster).
 */
export function PlayerCardsGrid({ teamId }: { teamId: string }) {
  const [data, setData] = useState<Evaluations | null>(() => peek<Evaluations>(apiPath.evaluations(teamId)) ?? null);
  const [designing, setDesigning] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .evaluations(teamId)
      .then(setData)
      .catch(() => setData(null));
  }, [teamId]);
  useEffect(load, [load]);

  if (!data || data.mode === 'overall' || data.evaluations.length === 0) return null;

  return (
    <section className="card" data-fold-open>
      <h2>Player cards</h2>
      <p className="note">
        Swipe left or right to see every player: overall out of 99 and six stats, in bronze, silver or gold.
        {data.mode === 'edit' ? ' Rate players on Team & roster: tap a player, then Evaluate.' : ''}
      </p>
      <CardStack
        items={stackOrder(data.evaluations)}
        below={(ev) => (
          <AvatarControls
            ev={ev}
            locked={Boolean(data.avatarLocked)}
            designing={designing === ev.playerId}
            onDesign={() => setDesigning(ev.playerId)}
            onDone={() => {
              setDesigning(null);
              load();
            }}
          />
        )}
      />
    </section>
  );
}
