import { useEffect, useState } from 'react';
import { api, type RosterSources } from '../lib/api';

/**
 * Bring players in from an older roster (Fady, 10/16): the coach's other
 * standalone teams, or the region's teams for its staff. Players are copied;
 * their parents can come along.
 */
export default function RosterImport({
  teamId,
  startOpen = false,
  onImported,
}: {
  teamId: string;
  /** Open straight away, e.g. on a new team with no players yet. */
  startOpen?: boolean;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [data, setData] = useState<RosterSources | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [withParents, setWithParents] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .rosterSources(teamId)
      .then((d) => {
        if (!live) return;
        setData(d);
        setSourceId(d.sources[0]?.teamId ?? '');
      })
      .catch(() => live && setData({ sources: [] }));
    return () => {
      live = false;
    };
  }, [teamId]);

  useEffect(() => setPicked(new Set()), [sourceId]);

  // Nothing to bring from: say nothing.
  if (!data || data.sources.length === 0) return null;
  const source = data.sources.find((s) => s.teamId === sourceId) ?? data.sources[0];
  const players = source.players;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Bring players from another team</h2>
        {!open && (
          <button type="button" className="btn btn-sm ghost" onClick={() => setOpen(true)}>
            Pick players
          </button>
        )}
      </div>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
      {!open ? (
        <p className="note">Copy players from an older roster, such as last season’s team, instead of typing them again.</p>
      ) : (
        <>
          <label>
            From
            <select value={source.teamId} onChange={(e) => setSourceId(e.target.value)}>
              {data.sources.map((s) => (
                <option key={s.teamId} value={s.teamId}>
                  {s.name}
                  {s.archived ? ' (archived)' : ''}
                  {s.regionName ? ` · ${s.regionName}` : ''}
                </option>
              ))}
            </select>
          </label>
          {players.length === 0 ? (
            <p className="note">That team has no players.</p>
          ) : (
            <>
              <div className="row">
                <button type="button" className="linkish" onClick={() => setPicked(new Set(players.map((p) => p.id)))}>
                  Select all
                </button>
                <button type="button" className="linkish" onClick={() => setPicked(new Set())}>
                  Clear
                </button>
              </div>
              <ul className="check-list">
                {players.map((p) => (
                  <li key={p.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(p.id)}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          })
                        }
                      />
                      {p.number ? `#${p.number} ` : ''}
                      {p.name}
                      {!p.active && <span className="sub"> · inactive</span>}
                    </label>
                  </li>
                ))}
              </ul>
              <ul className="check-list">
                <li>
                  <label className="check">
                    <input type="checkbox" checked={withParents} onChange={(e) => setWithParents(e.target.checked)} />
                    Bring their parents too (they’re added to this team and told about it)
                  </label>
                </li>
              </ul>
            </>
          )}
          {error && <p className="danger-text">{error}</p>}
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || picked.size === 0}
              onClick={async () => {
                setBusy(true);
                setError(null);
                setMsg(null);
                try {
                  const r = await api.importPlayers({
                    teamId,
                    sourceTeamId: source.teamId,
                    playerIds: [...picked],
                    withParents,
                  });
                  setMsg(
                    `${r.added} ${r.added === 1 ? 'player' : 'players'} added` +
                      (r.skipped ? `, ${r.skipped} already on the roster` : '') +
                      (r.parentsAdded ? `, ${r.parentsAdded} ${r.parentsAdded === 1 ? 'parent' : 'parents'} added to the team` : '') +
                      '.',
                  );
                  setPicked(new Set());
                  setOpen(false);
                  onImported();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not add them');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Adding…' : `Add ${picked.size || ''} ${picked.size === 1 ? 'player' : 'players'}`}
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
