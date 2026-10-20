import { useEffect, useState } from 'react';
import { api, ApiError, apiPath, peek, type Standings as S, type StandingsScope } from '../lib/api';
import { PaidLock } from '../lib/features';

/**
 * Standings for whatever is selected in the menu: an organization, a region
 * or one team. Breadcrumbs go up the hierarchy and team rows go down into a
 * team, when the viewer has access to it.
 */
export default function Standings({
  scope,
  id,
  highlight,
  onPick,
}: {
  scope: StandingsScope;
  id: string;
  /** A team to mark in a region or org table, usually the one selected. */
  highlight?: string | null;
  onPick: (scope: StandingsScope, id: string) => void;
}) {
  const [data, setData] = useState<S | null>(() => peek<S>(apiPath.standings(scope, id)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A table seen earlier in this visit shows at once while it refreshes.
    setData(peek<S>(apiPath.standings(scope, id)) ?? null);
    setError(null);
    setLocked(false);
    api
      .standings(scope, id)
      .then((d) => !cancelled && setData(d))
      .catch((e) => {
        if (cancelled) return;
        // Organization and region tables need a plan below staff level. Fall
        // back to the selected team's own results rather than an empty page.
        if (e instanceof ApiError && e.status === 402) {
          setLocked(true);
          if (highlight && scope !== 'team') {
            api
              .standings('team', highlight)
              .then((d) => !cancelled && setData(d))
              .catch(() => undefined);
          }
          return;
        }
        setError(e instanceof Error ? e.message : 'Failed to load');
      });
    return () => {
      cancelled = true;
    };
  }, [scope, id, highlight]);

  const lockNote = locked ? (
    <PaidLock feature="scopeStandings" what="Region and organization standings" className="card" />
  ) : null;

  if (error) return <section className="card err">{error}</section>;
  if (locked && !data) return lockNote;
  if (!data) return <section className="card">Loading…</section>;

  const showRegion = scope === 'org' && data.table.some((r) => r.regionName);

  return (
    <>
      {lockNote}
      <section className="card">
        {data.crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Hierarchy">
            {data.crumbs.map((c) => (
              <button
                key={c.id}
                type="button"
                className="crumb"
                onClick={() => onPick(c.kind as StandingsScope, c.id)}
              >
                {c.name}
              </button>
            ))}
            <span className="crumb here">{data.title}</span>
          </nav>
        )}
        <h2>
          {data.title} · Standings
        </h2>
        {data.table.length === 0 ? (
          <p className="note">No teams here yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="tiers standings">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  {showRegion && <th>Region</th>}
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
                {data.table.map((r, i) => (
                  <tr
                    key={r.teamId}
                    className={scope === 'team' || r.teamId === highlight ? 'current' : undefined}
                  >
                    <td>{i + 1}</td>
                    <td>
                      {r.reachable && scope !== 'team' ? (
                        <button type="button" className="linkish" onClick={() => onPick('team', r.teamId)}>
                          {r.name}
                        </button>
                      ) : (
                        r.name
                      )}
                    </td>
                    {showRegion && (
                      <td>
                        {r.regionId ? (
                          <button
                            type="button"
                            className="linkish"
                            onClick={() => onPick('region', r.regionId!)}
                          >
                            {r.regionName}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td>{r.played}</td>
                    <td>{r.won}</td>
                    <td>{r.drawn}</td>
                    <td>{r.lost}</td>
                    <td>{r.gf}</td>
                    <td>{r.ga}</td>
                    <td>{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                    <td>
                      <strong>{r.pts}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          3 points for a win, 1 for a draw. A game counts once it has a score or its date has passed.
          {data.leagueOnly && ' Only league games count here; friendlies stay on each team’s own stats.'}
        </p>
      </section>

      {data.scorers.length > 0 && (
        <section className="card">
          <h2>Top scorers</h2>
          <div className="table-scroll">
            <table className="tiers">
              <thead>
                <tr>
                  <th>Player</th>
                  {scope !== 'team' && <th>Team</th>}
                  <th>Goals</th>
                  <th>Assists</th>
                </tr>
              </thead>
              <tbody>
                {data.scorers.map((p, i) => (
                  <tr key={`${p.name}-${p.teamName}-${i}`}>
                    <td>{p.name}</td>
                    {scope !== 'team' && <td>{p.teamName}</td>}
                    <td>{p.goals}</td>
                    <td>{p.assists}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
