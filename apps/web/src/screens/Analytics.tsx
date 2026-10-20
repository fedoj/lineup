import { useEffect, useState } from 'react';
import type { Player } from '@lineup/shared';
import { api, apiPath, peek, type Analytics as A, type CompetitionSummary } from '../lib/api';
import ShareStats, { standingText } from '../components/ShareStats';
import { CustomStatsManager } from '../components/CustomStats';

export default function Analytics({
  teamId,
  teamName,
  roster,
  locked = false,
}: {
  teamId: string;
  teamName: string;
  roster: Player[];
  /** Simulate the free plan: only the top 3 rows are fully visible. */
  locked?: boolean;
}) {
  const [data, setData] = useState<A | null>(() => peek<A>(apiPath.analytics(teamId)) ?? null);
  const [error, setError] = useState<string | null>(null);
  // The leagues and tournaments the team is in, with its place in each (Fady, 10/17).
  const [comps, setComps] = useState<CompetitionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    setData(peek<A>(apiPath.analytics(teamId)) ?? null);
    setComps([]);
    api
      .analytics(teamId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message));
    api
      .competitions('team', teamId)
      .then((l) => !cancelled && setComps(l.competitions.filter((c) => c.standing)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  if (error) return <section className="card err">{error}</section>;
  if (!data) return <section className="card">Loading…</section>;

  const { record, team, fairness, players } = data;

  return (
    <>
      <section className="card">
        <h2>Season</h2>
        <div className="stat-row">
          <div className="stat">
            <span className="stat-n">{record.played}</span>
            <span className="stat-l">played</span>
          </div>
          <div className="stat">
            <span className="stat-n good">{record.won}</span>
            <span className="stat-l">won</span>
          </div>
          <div className="stat">
            <span className="stat-n">{record.drawn}</span>
            <span className="stat-l">drawn</span>
          </div>
          <div className="stat">
            <span className="stat-n bad">{record.lost}</span>
            <span className="stat-l">lost</span>
          </div>
          <div className="stat">
            <span className="stat-n">
              {record.goalsFor}–{record.goalsAgainst}
            </span>
            <span className="stat-l">goals</span>
          </div>
        </div>
      </section>

      {comps.length > 0 && (
        <section className="card">
          <h2>Leagues &amp; tournaments</h2>
          <ul className="team-comps">
            {comps.map((c) => {
              const s = c.standing!;
              return (
                <li key={c.id}>
                  <div className="team-comp-head">
                    <span>
                      <span aria-hidden="true">{c.kind === 'tournament' ? '🏆' : '📅'}</span> <strong>{c.name}</strong>
                    </span>
                    {s.positionLabel ? (
                      <span className={`team-comp-place${s.position === 1 ? ' first' : s.position && s.position <= 3 ? ' podium' : ''}`}>
                        {s.positionLabel} <span className="sub">of {s.of}</span>
                      </span>
                    ) : (
                      <span className="sub">No games yet</span>
                    )}
                  </div>
                  <span className="sub">{standingText(c)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {team && (
        <section className="card">
          <h2>Match events</h2>
          <div className="stat-row">
            <div className="stat">
              <span className="stat-n">{team.corners}</span>
              <span className="stat-l">corners</span>
            </div>
            <div className="stat">
              <span className="stat-n">{team.fouls}</span>
              <span className="stat-l">fouls</span>
            </div>
            <div className="stat">
              <span className="stat-n">{team.yellow}</span>
              <span className="stat-l">yellow</span>
            </div>
            <div className="stat">
              <span className="stat-n bad">{team.red}</span>
              <span className="stat-l">red</span>
            </div>
          </div>
          <p className="note">
            Against us: {team.cornersAgainst} corners · {team.foulsAgainst} fouls ·{' '}
            {team.yellowAgainst} yellow · {team.redAgainst} red.
          </p>
        </section>
      )}

      {fairness && (
        <section className="card">
          <h2>Playing time fairness</h2>
          <p className="note">
            {fairness.spread === 0
              ? 'Everyone has played the same number of minutes.'
              : `${fairness.spread} minute spread between the most and least played.`}{' '}
            Average {fairness.average} minutes.
          </p>
          <div className="bars">
            {[...players]
              .sort((a, b) => b.minutes - a.minutes)
              .map((p, i) => (
                <div className={`bar-row ${locked && i >= 3 ? 'locked-stat' : ''}`} key={p.playerId}>
                  <span className="bar-name">{p.name}</span>
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{
                        width: `${fairness.max ? (p.minutes / fairness.max) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <span className="bar-val">{p.minutes}m</span>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className="card">
        <h2>Players</h2>
        <div className="table-scroll"><table className="tiers">
          <thead>
            <tr>
              <th>Player</th>
              <th>Games</th>
              <th>Mins</th>
              <th>Goals</th>
              <th>Assists</th>
              <th>Clear.</th>
              <th>🟨</th>
              <th>🟥</th>
              <th>Attendance</th>
            </tr>
          </thead>
          <tbody>
            {[...players]
              .sort((a, b) => b.goals + b.assists - (a.goals + a.assists))
              .map((p, i) => (
                <tr key={p.playerId} className={locked && i >= 3 ? 'locked-stat' : undefined}>
                  <td>
                    <span className="chip-num">{p.number || '—'}</span> {p.name}
                  </td>
                  <td>{p.gamesPlayed}</td>
                  <td>{p.minutes}</td>
                  <td>{p.goals}</td>
                  <td>{p.assists}</td>
                  <td>{p.clearances || '—'}</td>
                  <td>{p.yellow || '—'}</td>
                  <td>{p.red || '—'}</td>
                  <td>{p.present + p.absent ? `${p.attendanceRate}%` : '—'}</td>
                </tr>
              ))}
          </tbody>
        </table></div>
        {locked && players.length > 3 && (
          <p className="note warn">Free preview: upgrade to unlock the full stats table.</p>
        )}
      </section>

      <section className="card">
        <h2>Results</h2>
        <div className="table-scroll"><table className="tiers">
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Opponent</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {data.games.map((g) => (
              <tr key={g.id}>
                <td>{g.gameNo}</td>
                <td>{g.date ?? '—'}</td>
                <td>{g.opponent || '—'}</td>
                <td>
                  {g.us}–{g.them}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <CustomStatsManager teamId={teamId} players={roster} />

      <ShareStats teamName={teamName} data={data} comps={comps} teamId={teamId} locked={locked} />
    </>
  );
}
