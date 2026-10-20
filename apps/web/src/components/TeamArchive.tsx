import { useState } from 'react';
import type { Team } from '@lineup/shared';
import { api } from '../lib/api';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Team archive (Fady, 10/16). An archived team is read-only for everyone and
 * sits under Archived teams in the menu; it can be brought back for 1 month,
 * then it is deleted with everything in it (accounts stay).
 */
export function ArchivedTeamBanner({ team, onChanged }: { team: Team; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!team.archivedAt) return null;
  const canBringBack = Boolean(team.canArchive && team.restoreUntil && Date.now() <= new Date(team.restoreUntil).getTime());

  return (
    <section className="card archived-banner" role="status">
      <p>
        🗄️ <strong>{team.name} is archived</strong> (since {day(team.archivedAt)}). Everything is kept, but it is
        read-only for everyone.
      </p>
      {canBringBack ? (
        <>
          <button
            type="button"
            className="btn btn-sm btn-good"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.archiveTeam(team.id, 'restore');
                onChanged();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not bring it back');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Bringing it back…' : 'Bring it back'}
          </button>
          <span className="sub">
            {' '}
            You can bring it back until {day(team.restoreUntil!)}. After that the team and everything in it is deleted
            (people’s accounts stay).
          </span>
        </>
      ) : (
        team.restoreUntil && (
          <p className="sub">It is deleted on {day(team.restoreUntil)}, with everything in it; people’s accounts stay.</p>
        )
      )}
      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}

/** Team & roster: archive the team whenever you like. */
export function ArchiveTeamCard({ team, onChanged }: { team: Team; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!team.canArchive || team.archivedAt) return null;

  return (
    <section className="card">
      <h2>Archive team</h2>
      <p className="note">
        Done with this team, for example after its season? Archiving keeps everything (roster, games, chat and stats)
        but makes it read-only for everyone, stops reminders, and moves it to Archived teams in the menu. It no longer
        counts toward your plan’s teams. You can bring it back within 1 month; after that the team and everything in it
        is deleted. People’s accounts (coaches, parents, players) stay.
      </p>
      {confirming ? (
        <div className="row">
          <button
            type="button"
            className="btn btn-sm danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.archiveTeam(team.id, 'archive');
                setConfirming(false);
                onChanged();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not archive it');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Archiving…' : `Yes, archive ${team.name}`}
          </button>
          <button type="button" className="btn ghost btn-sm" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn ghost btn-sm" onClick={() => setConfirming(true)}>
          🗄️ Archive this team
        </button>
      )}
      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}
