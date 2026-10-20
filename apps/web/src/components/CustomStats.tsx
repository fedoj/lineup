import { useCallback, useEffect, useState } from 'react';
import type { Player } from '@lineup/shared';
import { api, apiPath, peek, type CustomStats } from '../lib/api';
import { PaidLock } from '../lib/features';

const TITLE = 'Custom columns and stats';

/** Premium upsell shown in place of custom stats on a plan without them. */
function Locked() {
  return <PaidLock feature="customStats" what={TITLE} />;
}

/**
 * Stats tab: define the columns this team tracks (coaches and above) and see
 * each player's season totals for them, in one place.
 */
export function CustomStatsManager({ teamId, players }: { teamId: string; players: Player[] }) {
  const [data, setData] = useState<CustomStats | null>(() => peek<CustomStats>(apiPath.teamStats(teamId)) ?? null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.teamStats(teamId).then(setData).catch((e) => setError(e.message));
  }, [teamId]);
  useEffect(load, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.addTeamStat(teamId, name.trim());
      setName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the stat');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Stop tracking "${label}"? Its recorded counts are hidden too.`)) return;
    setBusy(true);
    try {
      await api.removeTeamStat(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the stat');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  return (
    <section className="card">
      <h2>{TITLE}</h2>
      {data.locked ? (
        <Locked />
      ) : (
        <p className="note">
          Track anything beyond goals and assists, such as tackles, saves or shots on target. Add a
          column here, count it per player on match day under Stats, and the season totals show below.
        </p>
      )}
      {error && <p className="danger-text">{error}</p>}
      {data.stats.length > 0 && (
        <ul className="chip-list">
          {data.stats.map((s) => (
            <li key={s.id} className="chip">
              {s.name}
              {data.canManage && !data.locked && (
                <button type="button" className="chip-x" title={`Remove ${s.name}`} disabled={busy} onClick={() => remove(s.id, s.name)}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.canManage && !data.locked && (
        <div className="row">
          <input
            style={{ flex: '1 1 200px' }}
            value={name}
            maxLength={40}
            placeholder="e.g. Tackles"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void add();
            }}
          />
          <button type="button" className="btn" disabled={busy || !name.trim()} onClick={add}>
            Add column
          </button>
        </div>
      )}
      {!data.locked && data.stats.length > 0 && (
        <div className="table-scroll">
          <table className="tiers">
            <thead>
              <tr>
                <th>Player</th>
                {data.stats.map((s) => (
                  <th key={s.id}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {players
                .filter((p) => p.active)
                .map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.number && `#${p.number} `}
                      {p.name}
                    </td>
                    {data.stats.map((s) => (
                      <td key={s.id}>{data.totals[p.id]?.[s.id] ?? 0}</td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Match day: tap + / − to count a team's own stats per player for this game. */
export function CustomStatsTracker({ gameId, teamId, players }: { gameId: string; teamId: string; players: Player[] }) {
  const [defs, setDefs] = useState<CustomStats | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [statId, setStatId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.teamStats(teamId), api.statValues(gameId)])
      .then(([d, v]) => {
        if (cancelled) return;
        setDefs(d);
        setStatId((prev) => prev ?? d.stats[0]?.id ?? null);
        setValues(Object.fromEntries(v.map((x) => [`${x.playerId}:${x.statId}`, x.value])));
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [gameId, teamId]);

  async function bump(playerId: string, delta: 1 | -1) {
    if (!statId) return;
    const key = `${playerId}:${statId}`;
    const before = values[key] ?? 0;
    if (delta < 0 && before === 0) return;
    setValues((v) => ({ ...v, [key]: before + delta }));
    try {
      const r = await api.bumpStat(gameId, playerId, statId, delta);
      setValues((v) => ({ ...v, [key]: r.value }));
    } catch (e) {
      setValues((v) => ({ ...v, [key]: before }));
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  }

  if (!defs) return <section className="card">{error ?? 'Loading…'}</section>;
  if (defs.locked) {
    return (
      <section className="card">
        <h2>{TITLE}</h2>
        <Locked />
      </section>
    );
  }
  if (defs.stats.length === 0) {
    return (
      <section className="card">
        <h2>{TITLE}</h2>
        <p className="note">
          No custom columns yet. Add the ones you want to track on the Stats tab, then count them
          here during the game.
        </p>
      </section>
    );
  }

  const active = players.filter((p) => p.active);

  return (
    <section className="card">
      <h2>{TITLE}</h2>
      {error && <p className="danger-text">{error}</p>}
      <nav className="seg stat-pick" aria-label="Stat to count">
        {defs.stats.map((s) => (
          <button key={s.id} type="button" className={statId === s.id ? 'on' : ''} onClick={() => setStatId(s.id)}>
            {s.name}
          </button>
        ))}
      </nav>
      <ul className="stat-counter">
        {active.map((p) => {
          const n = statId ? values[`${p.id}:${statId}`] ?? 0 : 0;
          return (
            <li key={p.id}>
              <span className="stat-who">
                {p.number && <b>#{p.number}</b>} {p.name}
              </span>
              {defs.canRecord ? (
                <span className="stat-ctl">
                  <button type="button" className="btn ghost btn-sm" aria-label={`Minus one for ${p.name}`} disabled={n === 0} onClick={() => bump(p.id, -1)}>
                    −
                  </button>
                  <b className="stat-val">{n}</b>
                  <button type="button" className="btn btn-sm" aria-label={`Plus one for ${p.name}`} onClick={() => bump(p.id, 1)}>
                    +
                  </button>
                </span>
              ) : (
                <b className="stat-val">{n}</b>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
