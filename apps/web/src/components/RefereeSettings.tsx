import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type RefereeStaffView } from '../lib/api';

/**
 * Referees, in an organization's or region's Settings: turn referee sign-up
 * on (a code and a link to share), see who referees, and remove someone.
 * Shown only to the staff who schedule its games.
 */
export default function RefereeSettings({ scope, id }: { scope: 'org' | 'region'; id: string }) {
  const [view, setView] = useState<RefereeStaffView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.refereeStaff(scope, id));
      setHidden(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setHidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load referees');
    }
  }, [scope, id]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  async function act(b: Parameters<typeof api.refereeStaffAction>[0], done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      setView(await api.refereeStaffAction({ ...b, scope, id }));
      setMsg(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!view) return error ? <section className="card err">{error}</section> : null;

  return (
    <section className="card" id="referees">
      <div className="card-head">
        <h2>🟨 Referees</h2>
      </div>
      {msg && <p className="note" role="status">{msg}</p>}
      {error && <p className="error">{error}</p>}

      {view.enabled && view.code ? (
        <div className="ref-code">
          <p>
            Referee sign-up is on. Share this code or link. Referees can then sign up for any league game
            {scope === 'region' ? ' here' : ' in any region'}, first come, first served.
          </p>
          <div className="row">
            <code className="join-code">{view.code}</code>
            {view.link && (
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(view.link!).then(() => setMsg('Link copied.'));
                }}
              >
                Copy link
              </button>
            )}
          </div>
          {view.link && <p className="sub ref-link">{view.link}</p>}
          {view.canManageCode && (
            <div className="row">
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (confirm('Make a new code? The old code and link stop working. Referees who already joined stay.')) {
                    void act({ action: 'code', on: true, rotate: true }, 'New code made. The old one no longer works.');
                  }
                }}
              >
                New code
              </button>
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (confirm('Turn referee sign-up off? New referees cannot join. Referees who already joined stay.')) {
                    void act({ action: 'code', on: false }, 'Referee sign-up is off.');
                  }
                }}
              >
                Turn off
              </button>
            </div>
          )}
        </div>
      ) : view.canManageCode ? (
        <div className="ref-code">
          <p className="note">
            Turn on referee sign-up to get a code and a link to share with your referees. They sign up for games
            themselves, and you can change who refs a game from its card on the Calendar.
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => void act({ action: 'code', on: true }, 'Referee sign-up is on.')}>
            Turn on referee sign-up
          </button>
        </div>
      ) : (
        <p className="note">Referee sign-up is off. The organization's admins and directors can turn it on.</p>
      )}

      <h3 className="group-title">
        {view.referees.length === 0 ? 'No referees yet' : `${view.referees.length} ${view.referees.length === 1 ? 'referee' : 'referees'}`}
      </h3>
      {view.referees.length > 0 && (
        <ul className="people-list">
          {view.referees.map((r) => (
            <li key={r.userId} className="checkin-child">
              <span className="person-name">
                {r.name}
                {r.email && r.email !== r.name && <span className="sub"> · {r.email}</span>}
              </span>
              <span className="sub">
                {r.upcoming} upcoming {r.upcoming === 1 ? 'game' : 'games'}
                {r.favoriteRegion ? ` · Favorite: ${r.favoriteRegion}` : ''}
              </span>
              {view.canManageCode && (
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove ${r.name} as a referee? Their upcoming games are freed up.`)) {
                      void act({ action: 'remove', userId: r.userId }, `${r.name} is no longer a referee.`);
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
  );
}
