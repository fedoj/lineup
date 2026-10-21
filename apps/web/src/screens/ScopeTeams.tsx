import { useState } from 'react';
import type { Team } from '@lineup/shared';
import type { Hierarchy, InviteCreated } from '../lib/api';
import InviteShare from '../components/InviteShare';
import { Logo } from '../components/Logo';
import { NewTeam } from './TeamSetup';

/**
 * How players, families and staff come into an organization or region. On
 * the Teams tab only (Fady, 10/20), with a way straight to the leagues and
 * tournaments, where each one's sign-up link is.
 */
export function JoinHelp({
  kind,
  onOpenSettings,
  openLabel = 'Open Settings',
  onOpenGames,
}: {
  kind: 'org' | 'region';
  onOpenSettings?: () => void;
  openLabel?: string;
  onOpenGames?: () => void;
}) {
  return (
    <section className="card join-help">
      <h2>How families and staff join</h2>
      <ol className="join-options">
        <li>
          <strong>Families: the league or tournament sign-up link</strong>
          <p className="note">
            Every league and tournament has its own sign-up link, open during its registration dates. Share it, and
            parents create their account and register their children themselves. You approve each child and place
            them on a team; the parent is linked to their child automatically.
          </p>
          {onOpenGames && (
            <button type="button" className="btn btn-sm" onClick={onOpenGames}>
              ⚽ Go to leagues &amp; tournaments
            </button>
          )}
        </li>
        <li>
          <strong>Staff: invite by email</strong>
          <p className="note">
            {kind === 'org' ? 'In Settings' : 'At the bottom of Sign-ups'}, under Invite members, invite coaches,
            assistant coaches, team parents and {kind === 'org' ? 'organization or region admins' : 'region admins'}.
            They get a link to accept.
          </p>
          {onOpenSettings && (
            <button type="button" className="btn ghost btn-sm" onClick={onOpenSettings}>
              {openLabel}
            </button>
          )}
        </li>
      </ol>
      <p className="note">
        Coaches on {kind === 'org' ? 'the organization’s' : 'the region’s'} teams don’t add players: players are approved
        and placed on teams by {kind === 'org' ? 'organization and region' : 'region'} staff as they sign up.
      </p>
    </section>
  );
}
/**
 * Teams tab for an organization or region: every team in it, opened with a
 * tap, and a new team created straight into a region by its staff.
 */
export default function ScopeTeams({
  kind,
  id,
  hierarchy,
  onOpenTeam,
  onOpenSettings,
  openLabel,
  onOpenGames,
  onChanged,
}: {
  kind: 'org' | 'region';
  id: string;
  hierarchy: Hierarchy | null;
  onOpenTeam: (teamId: string) => void;
  onOpenSettings?: () => void;
  /** The button under "How families and staff join". */
  openLabel?: string;
  /** Open the leagues and tournaments (the Games tab). */
  onOpenGames?: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  if (!hierarchy) return <section className="card">Loading…</section>;

  const org = kind === 'org' ? hierarchy.orgs.find((o) => o.id === id) : undefined;
  const allRegions = [
    ...hierarchy.orgs.flatMap((o) => o.regions.map((r) => ({ ...r, orgName: o.name as string | null, orgId: o.id }))),
    ...(hierarchy.regions ?? []).map((r) => ({ ...r, orgName: null as string | null, orgId: null as string | null })),
  ];
  const regions = kind === 'org' ? allRegions.filter((r) => r.orgId === id) : allRegions.filter((r) => r.id === id);
  const teams = hierarchy.teams.filter((t) => (kind === 'org' ? t.orgId === id : t.regionId === id));
  const creatable = regions.filter((r) => r.canAssign).map((r) => ({ id: r.id, label: r.name }));

  // Teams of an organization grouped by region, in the order of its regions.
  const groups =
    kind === 'org'
      ? [
          ...regions.map((r) => ({ title: r.name, teams: teams.filter((t) => t.regionId === r.id) })),
          { title: 'No region', teams: teams.filter((t) => !t.regionId) },
        ].filter((g) => g.teams.length > 0)
      : [{ title: '', teams }];

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {created && <InviteShare invite={created} onClose={() => setCreated(null)} />}

      <section className="card" data-tour="create-team">
        <div className="card-head">
          <h2>Teams <span className="count">{teams.length}</span></h2>
          {creatable.length > 0 && !adding && (
            <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
              ＋ New team
            </button>
          )}
        </div>
        {teams.length === 0 ? (
          <p className="note">
            No teams yet.{' '}
            {creatable.length > 0
              ? 'Create one with New team, or link an existing team from Settings.'
              : kind === 'org'
                ? 'Add a region first, then create teams in it.'
                : ''}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.title || 'all'}>
              {g.title && <h3 className="group-title">{g.title}</h3>}
              <ul className="people-list">
                {g.teams.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="person" onClick={() => onOpenTeam(t.id)}>
                      <Logo kind="team" id={t.id} version={t.logo} size={28} />
                      <span className="person-name">{t.name}</span>
                      <span className="person-caret" aria-hidden="true">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {org && regions.length === 0 && (
          <p className="note">This organization has no regions yet. Add one in Settings.</p>
        )}
      </section>

      {adding && (
        <NewTeam
          canCancel
          regions={creatable}
          onCancel={() => setAdding(false)}
          onCreated={(t: Team, invite, inviteError) => {
            setAdding(false);
            setCreated(invite ?? null);
            setMsg(
              inviteError
                ? `${t.name} was created, but the invite failed: ${inviteError}`
                : `${t.name} was created.${invite ? ' The coach invite is ready to share.' : ' Invite its coach from Settings.'}`,
            );
            onChanged();
          }}
        />
      )}

      <JoinHelp kind={kind} onOpenSettings={onOpenSettings} openLabel={openLabel} onOpenGames={onOpenGames} />
    </>
  );
}
