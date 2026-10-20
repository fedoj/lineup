import { useCallback, useEffect, useState } from 'react';
import { api, type Checkins } from '../lib/api';
import MapLink from './MapLink';
import RsvpTally, { RsvpIcon } from './RsvpTally';

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function prettyTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Game check-in. Parents answer "going" or "not going" for their own child
 * as soon as a game is on the schedule; coaches and staff see who is coming.
 * A child marked not going drops out of the lineup on match day.
 */
export default function GameCheckins({ teamId }: { teamId: string }) {
  const [data, setData] = useState<Checkins | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .checkins(teamId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(() => setData(null));
  }, [teamId]);
  useEffect(load, [load]);

  if (!data) return null;
  const hasChildren = data.games.some((g) => g.children.length > 0);
  if (data.games.length === 0 || (!hasChildren && !data.canSeeSummary)) return null;

  async function answer(gameId: string, playerId: string, status: 'available' | 'absent') {
    setBusy(`${gameId}:${playerId}`);
    setError(null);
    try {
      await api.checkIn({ gameId, playerId, status });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the check-in.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card checkins">
      <h2>Game check-in</h2>
      <p className="note">
        {hasChildren
          ? 'Let the coach know if your child is coming. Check-in is open as soon as a game is on the schedule.'
          : 'Parents check their child in as soon as a game is on the schedule. Not going takes the player out of the lineup.'}
      </p>
      {error && <p className="danger-text">{error}</p>}
      <ul className="checkin-list">
        {data.games.map((g) => (
          <li key={g.id}>
            <div className="checkin-game">
              <strong>{prettyDate(g.date)}</strong>
              {g.kickoff && <span className="sub"> · {prettyTime(g.kickoff)}</span>}
              <span> · {g.isHome ? 'vs' : 'at'} {g.opponent || 'TBD'}</span>
              {g.location && (
                <span className="sub">
                  {' · '}
                  <MapLink place={g.location} />
                </span>
              )}
            </div>
            {g.children.map((c) => (
              <div className="checkin-child" key={c.playerId}>
                <span className="person-name">{c.name}</span>
                <span className="rsvp-choice" role="group" aria-label={`${c.name}: going or not going`}>
                  <button
                    type="button"
                    className={`rsvp-opt going${c.status === 'available' ? ' on' : ''}`}
                    aria-pressed={c.status === 'available'}
                    disabled={busy !== null}
                    onClick={() => answer(g.id, c.playerId, 'available')}
                  >
                    <RsvpIcon kind="going" /> Going
                  </button>
                  <button
                    type="button"
                    className={`rsvp-opt out${c.status === 'absent' ? ' on' : ''}`}
                    aria-pressed={c.status === 'absent'}
                    disabled={busy !== null}
                    onClick={() => answer(g.id, c.playerId, 'absent')}
                  >
                    <RsvpIcon kind="out" /> Not going
                  </button>
                </span>
              </div>
            ))}
            <RsvpTally counts={g.counts} names={g.summary} />
          </li>
        ))}
      </ul>
    </section>
  );
}
