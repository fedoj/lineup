import { useEffect, useState } from 'react';
import { api, type FairPlayTeam, type ScopeStats as Stats, type StatLeader } from '../lib/api';

const BOARDS: Array<[keyof Stats['leaders'], string, string]> = [
  ['goals', '⚽ Top scorers', 'goals'],
  ['assists', '🎯 Top assists', 'assists'],
  ['topRated', '⭐ Top rated', 'coach rating'],
  ['defenders', '🛡️ Top defenders', 'defending'],
  ['saves', '🧤 Most saves', 'saves'],
  ['shots', '🥅 Most shots', 'shots'],
];

/**
 * Stats for an organization or region (Shadi, 10/21): this season's leaders
 * across its teams from what coaches record in matches (goals, assists,
 * saves, clearances) and their player ratings, plus each team's record.
 * Narrow it to a region or a team.
 */
export default function ScopeStats({ scope, id }: { scope: 'org' | 'region'; id: string }) {
  const [regionId, setRegionId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamType, setTeamType] = useState('');
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api
      .scopeStats(scope, id, { regionId: regionId || undefined, teamId: teamId || undefined, teamType: teamType || undefined })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the stats'));
  }, [scope, id, regionId, teamId, teamType]);

  if (error) return <section className="card err">{error}</section>;

  return (
    <>
      <section className="card">
        <h2>📊 Season stats</h2>
        <p className="note">
          This season&apos;s leaders across your teams, from what coaches record during matches and their player ratings.
          {data?.computedAt ? ` Updated `+ new Date(data.computedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '; refreshed every night.' : ''}
        </p>
        <div className="row">
          {scope === 'org' && (data?.regions.length ?? 0) > 0 && (
            <label>
              Region
              <select
                value={regionId}
                onChange={(e) => {
                  setRegionId(e.target.value);
                  setTeamId('');
                }}
              >
                <option value="">All regions</option>
                {data?.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(data?.teamTypes?.length ?? 0) > 0 && (
            <label>
              Team type
              <select
                value={teamType}
                onChange={(e) => {
                  setTeamType(e.target.value);
                  setTeamId('');
                }}
              >
                <option value="">All types</option>
                {data?.teamTypes?.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Team
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">All teams</option>
              {data?.teams.filter((t) => !teamType || t.teamType === teamType).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.teamType ? ` (${t.teamType})` : ''}
                  {t.regionName && scope === 'org' && !regionId ? ` · ${t.regionName}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {!data ? (
        <section className="card">Loading…</section>
      ) : (
        <>
          <div className="stat-boards">
            {BOARDS.map(([key, label, unit]) => (
              <Board key={key} title={label} unit={unit} rows={data.leaders[key] ?? []} rating={key === 'topRated' || key === 'defenders'} />
            ))}
          </div>
          {data.fairPlay && (data.fairPlay.fairest.length > 0 || data.fairPlay.leastFair.length > 0) && (
            <div className="stat-boards">
              <FairBoard title="🤝 Fairest playing time" rows={data.fairPlay.fairest} />
              <FairBoard title="⚠️ Least even playing time" rows={data.fairPlay.leastFair} />
            </div>
          )}
          <section className="card">
            <h2>🩹 Injured in the last 2 months</h2>
            {(data.injuries ?? []).length === 0 ? (
              <p className="note">No injuries reported in the last two months.</p>
            ) : (
              <ul className="plain-list">
                {data.injuries!.map((i) => (
                  <li key={i.playerId}>
                    <strong>{i.name}</strong> <span className="sub">{i.team}</span>
                    <span className="stat-value">
                      {i.lastDate > new Date().toISOString().slice(0, 10) ? 'out for ' : 'last '}{new Date(`${i.lastDate}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      {i.times > 1 ? ` · ${i.times} times` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2>Team records</h2>
            {data.teamTable.length === 0 ? (
              <p className="note">No games played this season yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th>P</th>
                      <th>W</th>
                      <th>D</th>
                      <th>L</th>
                      <th>GF</th>
                      <th>GA</th>
                      <th>GD</th>
                      <th title="Games without a goal against">Clean sheets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.teamTable.map((t) => (
                      <tr key={t.teamId}>
                        <td>
                          {t.name}
                          {t.teamType ? <span className="sub"> ({t.teamType})</span> : null}
                          {t.regionName && scope === 'org' ? <span className="sub"> · {t.regionName}</span> : null}
                        </td>
                        <td>{t.played}</td>
                        <td>{t.won}</td>
                        <td>{t.drawn}</td>
                        <td>{t.lost}</td>
                        <td>{t.gf}</td>
                        <td>{t.ga}</td>
                        <td>{t.gf - t.ga > 0 ? `+${t.gf - t.ga}` : t.gf - t.ga}</td>
                        <td>{t.cleanSheets}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.players !== undefined && (
              <p className="sub">
                {data.rated ?? 0} of {data.players} players have been rated by their coach.
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Board({ title, unit, rows, rating }: { title: string; unit: string; rows: StatLeader[]; rating: boolean }) {
  return (
    <section className="card stat-board">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="note">Nothing recorded yet.</p>
      ) : (
        <ol>
          {rows.map((r) => (
            <li key={r.playerId}>
              <span>
                <strong>{r.name}</strong> <span className="sub">{r.team}</span>
              </span>
              <span className="stat-value" title={unit}>
                {rating ? (r.value !== null ? `${r.value}/10` : '—') : r.value}
                {r.clearances ? <span className="sub"> · {r.clearances} clr</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Teams by how evenly they share minutes per game players came to (Shadi, 10/21). */
function FairBoard({ title, rows }: { title: string; rows: FairPlayTeam[] }) {
  return (
    <section className="card stat-board">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="note">Not enough games yet.</p>
      ) : (
        <ol>
          {rows.map((t) => (
            <li key={t.teamId}>
              <span>
                <strong>{t.name}</strong> <span className="sub">{t.regionName ?? ''}</span>
              </span>
              <span className="stat-value" title="Gap in minutes per game between the most and least played">
                {t.spread} min gap
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="sub">Minutes per game each player came to; missed games (absent, sick, injured) don't count.</p>
    </section>
  );
}
