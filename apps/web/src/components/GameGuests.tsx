import { useEffect, useState } from 'react';
import { api, type BorrowTeam, type GameGuests } from '../lib/api';

/**
 * Borrowing a player for a game (Fady, 10/18). On a team's calendar the coach
 * or assistant coach asks another team for a player; that team's coach
 * approves or declines.
 */

const STATUS: Record<string, string> = {
  pending: 'waiting for their coach',
  approved: 'approved',
  declined: 'declined',
};

function prettyDay(iso: string | null): string {
  if (!iso) return 'Date TBD';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Guests on one game, and "Borrow a player". */
export function GameGuestList({
  teamId,
  gameId,
  data,
  onChanged,
}: {
  teamId: string;
  gameId: string;
  data: GameGuests;
  onChanged: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guests = data.outgoing.filter((g) => g.gameId === gameId);
  if (!data.canBorrow && guests.length === 0) return null;

  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.gameGuestAction({ action: 'cancel', id });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="game-guests">
      {guests.length > 0 && (
        <ul className="guest-list">
          {guests.map((g) => (
            <li key={g.id} className={`guest ${g.status}`}>
              <span>
                👟 Guest: <strong>{g.playerName}</strong>
                {g.number ? ` #${g.number}` : ''} <span className="sub">from {g.fromTeam}</span>
              </span>
              <span className={`pill small guest-${g.status}`}>{STATUS[g.status] ?? g.status}</span>
              {data.canBorrow && g.status !== 'declined' && (
                <button type="button" className="linkish" disabled={busy} onClick={() => void cancel(g.id)}>
                  {g.status === 'approved' ? 'Remove' : 'Cancel request'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="danger-text">{error}</p>}
      {data.canBorrow &&
        (picking ? (
          <BorrowPicker
            teamId={teamId}
            gameId={gameId}
            taken={new Set(guests.filter((g) => g.status !== 'declined').map((g) => g.playerId))}
            onDone={(sent) => {
              setPicking(false);
              if (sent) onChanged();
            }}
          />
        ) : (
          <button type="button" className="btn ghost btn-sm" onClick={() => setPicking(true)}>
            ＋ Borrow a player
          </button>
        ))}
    </div>
  );
}

/** Pick a team, then one of its players, and send the request. */
function BorrowPicker({
  teamId,
  gameId,
  taken,
  onDone,
}: {
  teamId: string;
  gameId: string;
  taken: Set<string>;
  onDone: (sent: boolean) => void;
}) {
  const [teams, setTeams] = useState<BorrowTeam[] | null>(null);
  const [fromTeam, setFromTeam] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .borrowOptions(teamId)
      .then((r) => live && setTeams(r.teams))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the teams'));
    return () => {
      live = false;
    };
  }, [teamId]);

  const team = teams?.find((t) => t.id === fromTeam);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.gameGuestAction({ action: 'request', gameId, playerId, note: note.trim() || undefined });
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="borrow-picker">
      {!teams && !error && <p className="note">Loading teams…</p>}
      {teams && teams.length === 0 && <p className="note">There are no other teams to borrow from.</p>}
      {teams && teams.length > 0 && (
        <div className="field-grid">
          <label>
            From team
            <select
              value={fromTeam}
              onChange={(e) => {
                setFromTeam(e.target.value);
                setPlayerId('');
              }}
            >
              <option value="">Choose a team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.division ? ` · ${t.division}` : ''}
                  {t.regionName ? ` · ${t.regionName}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Player
            <select value={playerId} disabled={!team} onChange={(e) => setPlayerId(e.target.value)}>
              <option value="">Choose a player…</option>
              {team?.players.map((p) => (
                <option key={p.id} value={p.id} disabled={taken.has(p.id)}>
                  {p.number ? `#${p.number} ` : ''}
                  {p.name}
                  {taken.has(p.id) ? ' (already asked)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Note to their coach (optional)
            <input value={note} maxLength={300} placeholder="e.g. We're short a keeper" onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="danger-text">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={busy || !playerId} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Ask their coach'}
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Requests to borrow this team's players: the coach approves or declines; the
 * assistant coach sees them too.
 */
export function BorrowRequests({ data, onChanged }: { data: GameGuests; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (data.incoming.length === 0) return null;
  const pending = data.incoming.filter((r) => r.status === 'pending');
  const lent = data.incoming.filter((r) => r.status === 'approved');

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError(null);
    try {
      await api.gameGuestAction({ action: 'decide', id, approve });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the answer');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card borrow-requests" id="borrow">
      <h2>Requests to borrow your players</h2>
      {error && <p className="danger-text">{error}</p>}
      {pending.length > 0 && (
        <ul className="guest-list">
          {pending.map((r) => (
            <li key={r.id} className="guest pending">
              <span>
                <strong>{r.borrower}</strong> wants <strong>{r.playerName}</strong> for {prettyDay(r.date)}
                {r.kickoff ? ` at ${r.kickoff}` : ''}
                {r.opponent ? ` vs ${r.opponent}` : ''}
                {r.requestedBy ? <span className="sub"> · asked by {r.requestedBy}</span> : null}
                {r.note ? <span className="sub"> · “{r.note}”</span> : null}
              </span>
              {data.canDecide ? (
                <span className="row">
                  <button type="button" className="btn btn-sm" disabled={busy === r.id} onClick={() => void decide(r.id, true)}>
                    Approve
                  </button>
                  <button type="button" className="btn ghost btn-sm" disabled={busy === r.id} onClick={() => void decide(r.id, false)}>
                    Decline
                  </button>
                </span>
              ) : (
                <span className="pill small">Waiting for the coach</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {lent.length > 0 && (
        <>
          <h3 className="group-title">Lent out</h3>
          <ul className="guest-list">
            {lent.map((r) => (
              <li key={r.id} className="guest approved">
                <span>
                  <strong>{r.playerName}</strong> plays for <strong>{r.borrower}</strong> on {prettyDay(r.date)}
                  {r.opponent ? ` vs ${r.opponent}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
