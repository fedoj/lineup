import { useEffect, useState } from 'react';
import { api, type CompetitionSummary, type FamilyStats as FS } from '../lib/api';
import { PaidLock } from '../lib/features';
import { standingText } from './ShareStats';

/**
 * Parents and team parents, on the team's Stats tab (Shadi, 10/21): where the
 * team stands in its leagues and tournaments, free for everyone; the season
 * record (friendlies included), results and their own child's numbers on the
 * Parent plan, shown greyed out with what they unlock until then.
 */
export default function FamilyStats({ teamId }: { teamId: string }) {
  const [comps, setComps] = useState<CompetitionSummary[] | null>(null);
  const [data, setData] = useState<FS | null>(null);

  useEffect(() => {
    let cancelled = false;
    setComps(null);
    setData(null);
    api
      .competitions('team', teamId)
      .then((l) => !cancelled && setComps(l.competitions.filter((c) => c.standing)))
      .catch(() => !cancelled && setComps([]));
    api
      .familyStats(teamId)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData({ locked: true }));
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  return (
    <>
      <section className="card">
        <h2>Standings</h2>
        {comps === null ? (
          <p className="note">Loading…</p>
        ) : comps.length === 0 ? (
          <p className="note">This team isn’t in a league or tournament with a table yet.</p>
        ) : (
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
        )}
      </section>

      {data && (data.locked || !data.record ? <LockedTeaser /> : <Unlocked data={data} />)}
    </>
  );
}

/** What the Parent plan adds, greyed out with sample numbers. */
function LockedTeaser() {
  return (
    <section className="card family-locked">
      <h2>Season, results and your child’s stats</h2>
      <div className="locked-preview" aria-hidden="true">
        <div className="stat-row locked-stat">
          {['played', 'won', 'drawn', 'lost', 'goals'].map((l, i) => (
            <div className="stat" key={l}>
              <span className="stat-n">{l === 'goals' ? '18–9' : [8, 5, 1, 2][i]}</span>
              <span className="stat-l">{l}</span>
            </div>
          ))}
        </div>
        <div className="stat-row locked-stat">
          {['goals', 'assists', 'minutes', 'attendance'].map((l, i) => (
            <div className="stat" key={l}>
              <span className="stat-n">{['4', '3', '310', '92%'][i]}</span>
              <span className="stat-l">{l}</span>
            </div>
          ))}
        </div>
      </div>
      <ul className="family-unlocks">
        <li>Season record, friendlies included: wins, draws, losses, goals for and against</li>
        <li>Every result</li>
        <li>Your child’s goals, assists, minutes played and attendance</li>
      </ul>
      <PaidLock feature="ownPlayerStats" what="Season, results and your child’s stats" />
    </section>
  );
}

function Unlocked({ data }: { data: FS }) {
  const record = data.record!;
  const kids = data.children ?? [];
  return (
    <>
      <section className="card">
        <h2>Season</h2>
        <p className="note">All games, friendlies included.</p>
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

      {kids.length > 0 && (
        <section className="card">
          <h2>{kids.length > 1 ? 'Your children’s stats' : 'Your child’s stats'}</h2>
          <div className="table-scroll">
            <table className="tiers">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Games</th>
                  <th>Mins</th>
                  <th>Goals</th>
                  <th>Assists</th>
                  <th>Attendance</th>
                </tr>
              </thead>
              <tbody>
                {kids.map((p) => (
                  <tr key={p.playerId}>
                    <td>{p.name}</td>
                    <td>{p.gamesPlayed}</td>
                    <td>{p.minutes}</td>
                    <td>{p.goals}</td>
                    <td>{p.assists}</td>
                    <td>{p.present + p.absent ? `${p.attendanceRate}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Results</h2>
        {(data.games ?? []).length === 0 ? (
          <p className="note">No results yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="tiers">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Opponent</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {(data.games ?? []).map((g) => (
                  <tr key={g.id}>
                    <td>{g.date ?? '—'}</td>
                    <td>{g.opponent || '—'}</td>
                    <td>
                      {g.us}–{g.them}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
