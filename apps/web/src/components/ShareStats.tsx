import { useEffect, useState } from 'react';
import { type Analytics, type CompetitionSummary } from '../lib/api';
import { renderStatsImage } from '../lib/exportImages';
import { canvasBlob, fileSlug, shareFile } from '../lib/shareFile';
import { PaidLock, useFeature } from '../lib/features';

interface Props {
  teamId: string;
  teamName: string;
  data: Analytics;
  /** The team's leagues and tournaments, with its place in each. */
  comps: CompetitionSummary[];
  /** The free preview: sharing waits for a plan with full stats. */
  locked?: boolean;
}

/** "3rd of 8 · 13 pts · 4W 1D 2L · Semi-finals", for a team's league or tournament. */
export function standingText(c: CompetitionSummary): string {
  const s = c.standing;
  if (!s) return '';
  const parts: string[] = [];
  if (s.positionLabel) parts.push(`${s.positionLabel} of ${s.of}`);
  if (s.played > 0) parts.push(`${s.pts} pts`, `${s.won}W ${s.drawn}D ${s.lost}L`);
  else parts.push('no games yet');
  if (s.stage) parts.push(s.stage);
  return parts.join(' · ');
}

/**
 * Share stats as a picture (Fady, 10/19): the whole team or one player, with
 * as much as fits on one page (record, leagues and tournaments, every
 * player's numbers, every result), on white so it prints. Made on the phone
 * and handed to the share sheet; nothing is uploaded or kept. A premium
 * feature (sharing).
 */
export default function ShareStats({ teamName, data, comps, locked = false }: Props) {
  const allowed = useFeature('longShareLinks');
  const [playerId, setPlayerId] = useState('');
  const [fullNames, setFullNames] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // A small preview of what will be shared.
  useEffect(() => {
    if (!allowed || locked) return;
    const canvas = renderStatsImage({ teamName, data, comps, playerId: playerId || null, fullNames });
    setPreview(canvas.toDataURL('image/png'));
  }, [allowed, locked, teamName, data, comps, playerId, fullNames]);

  async function share(download: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const canvas = renderStatsImage({ teamName, data, comps, playerId: playerId || null, fullNames });
      const who = playerId ? data.players.find((p) => p.playerId === playerId)?.name ?? 'player' : teamName;
      const out = await shareFile(await canvasBlob(canvas), `${fileSlug(who)}-stats.png`, `${who} stats`, download);
      setMsg(out === 'downloaded' ? 'Saved the picture. You can print it or send it.' : out === 'shared' ? 'Shared.' : null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not make the picture');
    } finally {
      setBusy(false);
    }
  }

  if (locked || !allowed) {
    return (
      <section className="card">
        <h2>Share stats</h2>
        <PaidLock feature="longShareLinks" what="Sharing stats as a picture" />
      </section>
    );
  }

  return (
    <section className="card share-stats">
      <h2>Share stats</h2>
      <p className="note">
        Makes a picture with every stat on one page, on white so it prints well. Nothing is saved on Lineup: the picture
        goes straight to your phone's share menu or downloads. Names show as first name and last initial unless you
        choose full names.
      </p>
      <div className="field-grid">
        <label>
          What to share
          <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
            <option value="">Whole team</option>
            {[...data.players]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.number ? `#${p.number} ` : ''}
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={fullNames} onChange={(e) => setFullNames(e.target.checked)} /> Show full names
      </label>
      {preview && <img className="share-preview" src={preview} alt="Preview of the stats picture" />}
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => void share(false)}>
          {busy ? 'Making…' : 'Share picture…'}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void share(true)}>
          Download to print
        </button>
      </div>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}