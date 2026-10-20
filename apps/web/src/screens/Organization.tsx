import { useCallback, useEffect, useState } from 'react';
import type { Role } from '@lineup/shared';
import { api, type Hierarchy, type InviteCreated, type ScopeDecision } from '../lib/api';
import InviteShare from '../components/InviteShare';
import { LogoUpload } from '../components/Logo';
import { RegionSignupsPanel } from '../components/RegionJoin';
import RegionFields from '../components/RegionFields';
import { TrialBadge } from '../components/Trial';

/** Roles that make sense at each level. Team roles never attach above a team. */
const ROLES_BY_SCOPE: Record<'org' | 'region' | 'team', Array<[Role, string]>> = {
  org: [
    ['org_admin', 'Org admin'],
    ['director', 'Org director (renames, invites admins)'],
    ['region_admin', 'Region admin (all regions)'],
    ['viewer', 'Viewer'],
  ],
  region: [
    ['director', 'Region director'],
    ['region_admin', 'Region admin'],
    ['viewer', 'Viewer'],
  ],
  // Parents join from the team's Team & roster tab, where their child is picked.
  team: [
    ['coach', 'Coach'],
    ['assistant', 'Assistant coach'],
    ['team_parent', 'Team parent (team mom / manager)'],
    ['viewer', 'Viewer'],
  ],
};

const TIER_NAME: Record<string, string> = {
  free: 'Free',
  parent: 'Parent',
  teamParent: 'Parent',
  referee: 'Referee',
  coach: 'Coach',
  region: 'Region',
  organization: 'Organization',
  organizationPlus: 'Organization Plus',
};

function upgradeNote(what: string, d: ScopeDecision) {
  if (d.reason !== 'upgrade-required') return null;
  const plan = d.upgradeTo ? TIER_NAME[d.upgradeTo] ?? d.upgradeTo : 'a higher';
  return (
    <p className="note warn">
      {what} are part of the {plan} plan. Upgrade from Account to unlock them.
    </p>
  );
}

/**
 * Organization -> Region -> Team setup.
 *
 * Create an organization, add regions to it, then link teams into a region.
 * Every control reflects the server's decision for the caller, so testing as
 * another role or plan shows exactly what that role or plan would see.
 */
export default function Organization({
  onChanged,
  focus = null,
  section = 'settings',
}: {
  onChanged: () => void;
  /** Settings for one organization or region, opened from its page. */
  focus?: { kind: 'org' | 'region'; id: string } | null;
  /**
   * A region's page splits in two: Settings (name, code, logo, teams) and
   * Sign-ups (join code, players to place, people, and invites at the bottom).
   */
  section?: 'settings' | 'signups';
}) {
  const [h, setH] = useState<Hierarchy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgEdit, setOrgEdit] = useState<Record<string, string>>({});
  const [regionName, setRegionName] = useState<Record<string, string>>({});
  const [regionEdit, setRegionEdit] = useState<Record<string, { name: string }>>({});
  const [ownRegionName, setOwnRegionName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState('coach');
  const [inviteScope, setInviteScope] = useState('');
  const [created, setCreated] = useState<InviteCreated | null>(null);

  const load = useCallback(async () => {
    try {
      setH(await api.hierarchy());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load organizations');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(done);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!h) {
    return <section className={error ? 'card err' : 'card'}>{error ?? 'Loading…'}</section>;
  }

  // Standalone regions (the Region plan) have no organization above them.
  const standalone = h.regions ?? [];
  const createRegion = h.createRegion ?? { allowed: false, reason: null, upgradeTo: null };

  // Regions the caller may place teams into, across every org they can see.
  const targets = [
    ...h.orgs.flatMap((o) =>
      o.regions.filter((r) => r.canAssign).map((r) => ({ id: r.id, label: `${o.name} › ${r.name}` })),
    ),
    ...standalone.filter((r) => r.canAssign).map((r) => ({ id: r.id, label: r.name })),
  ];
  const managedOrgs = h.orgs.filter((o) => o.canManage);

  // Settings for one organization or region show only that part of the tree.
  const focusOrg = focus
    ? h.orgs.find((o) => (focus.kind === 'org' ? o.id === focus.id : o.regions.some((r) => r.id === focus.id))) ?? null
    : null;
  const focusRegion =
    focus?.kind === 'region'
      ? focusOrg?.regions.find((r) => r.id === focus.id) ?? standalone.find((r) => r.id === focus.id) ?? null
      : null;
  const shownOrgs = focus ? (focus.kind === 'org' && focusOrg ? [focusOrg] : []) : h.orgs;
  // A region's settings also list the caller's own teams that are not in any
  // league yet, so its admins and directors can link them in.
  const shownTeams = focus
    ? h.teams.filter((t) =>
        focus.kind === 'org'
          ? t.orgId === focus.id
          : t.regionId === focus.id || (Boolean(focusRegion?.canAssign) && !t.orgId && !t.regionId && t.canMove),
      )
    : h.teams;

  // Where the caller may invite people: an organization or region where they
  // hold member.invite, and any team below it.
  const inviteOrgs = (focus ? (focus.kind === 'org' && focusOrg ? [focusOrg] : []) : h.orgs).filter(
    (o) => o.canInvite ?? o.canManage,
  );
  const inviteRegions = [
    ...h.orgs.flatMap((o) =>
      o.regions
        .filter((r) => (r.canInvite ?? r.canAssign) && (!focus || (focus.kind === 'org' ? o.id === focus.id : r.id === focus.id)))
        .map((r) => ({ id: r.id, label: `${o.name} › ${r.name}`, orgId: o.id })),
    ),
    ...standalone
      .filter((r) => (r.canInvite ?? r.canAssign) && (!focus || (focus.kind === 'region' && r.id === focus.id)))
      .map((r) => ({ id: r.id, label: r.name, orgId: null })),
  ];
  const inviteTeams = shownTeams.filter(
    (t) =>
      inviteOrgs.some((o) => o.id === t.orgId) ||
      inviteRegions.some((r) => r.id === t.regionId) ||
      (!focus && t.canMove),
  );
  const canInviteHere = inviteOrgs.length + inviteRegions.length + inviteTeams.length > 0;
  // The organizations card is noise for someone whose plan is one region.
  const showOrgCard = h.orgs.length > 0 || h.createOrg.allowed || (standalone.length === 0 && !createRegion.allowed);
  const regionPage = focus?.kind === 'region';
  const signups = regionPage && section === 'signups';
  // On a region's page, invites live at the bottom of Sign-ups, not in Settings.
  const showInvites = canInviteHere && (!regionPage || signups);

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {error && <section className="card err">{error}</section>}

      {focus && !focusOrg && !focusRegion && (
        <section className="card">
          <p className="note">You do not have settings for this {focus.kind === 'org' ? 'organization' : 'region'}.</p>
        </section>
      )}

      {focusRegion && !signups && (
        <section className="card">
          <h2>{focusRegion.name} settings</h2>
          {focusRegion.trialEndsAt && <TrialBadge endsAt={focusRegion.trialEndsAt} />}
          {focusRegion.canManage ? (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <input
                  style={{ flex: '1 1 200px' }}
                  value={regionEdit[focusRegion.id]?.name ?? focusRegion.name}
                  maxLength={80}
                  aria-label="Region name"
                  disabled={!focusRegion.canRename}
                  title={focusRegion.canRename ? undefined : 'Only a director can rename the region'}
                  onChange={(e) =>
                    setRegionEdit((p) => ({
                      ...p,
                      [focusRegion.id]: { name: e.target.value },
                    }))
                  }
                />
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy || !(regionEdit[focusRegion.id]?.name ?? focusRegion.name).trim()}
                  onClick={() =>
                    run(
                      () =>
                        api.updateRegion({
                          id: focusRegion.id,
                          name: (regionEdit[focusRegion.id]?.name ?? focusRegion.name).trim(),
                        }),
                      'Region saved.',
                    )
                  }
                >
                  Save
                </button>
              </div>
              <LogoUpload
                kind="region"
                id={focusRegion.id}
                version={focusRegion.logo}
                onChanged={() => {
                  void load();
                  onChanged();
                }}
              />
            </>
          ) : (
            <p className="note">
              {focusOrg ? `${focusOrg.name} › ` : ''}
              {focusRegion.name}
              {' · '}{focusRegion.teams} teams
            </p>
          )}
        </section>
      )}
      {focusRegion && !signups && <RegionFields regionId={focusRegion.id} />}

      {focusRegion && signups && (focusRegion.canInvite || focusRegion.canManage) && (
        <RegionSignupsPanel regionId={focusRegion.id} onChanged={onChanged} />
      )}
      {focusRegion && signups && !(focusRegion.canInvite || focusRegion.canManage) && (
        <section className="card">
          <p className="note">Sign-ups for this region are handled by its admins and directors.</p>
        </section>
      )}

      {!focus && (createRegion.allowed || standalone.length > 0) && (
        <section className="card">
          <h2>{standalone.length > 1 ? 'Your regions' : 'Your region'}</h2>
          <p className="note">
            A region of your own, with no organization above it: up to 20 teams, a sign-up code for
            families, and standings and a calendar across all of its teams.
          </p>
          {standalone.length > 0 && (
            <table className="tiers">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Teams</th>
                </tr>
              </thead>
              <tbody>
                {standalone.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.name}
                      
                      {r.trialEndsAt && <span className="sub"> · free trial</span>}
                    </td>
                    <td>{r.teams}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {standalone.length > 0 && (
            <p className="note">
              Open the region from the menu. Its Settings tab has the name and logo; its Sign-ups tab has the
              sign-up code, families waiting to be placed, and invites for coaches and region staff.
            </p>
          )}
          {createRegion.allowed && (
            <div className="row" style={{ marginTop: 12 }}>
              <input
                style={{ flex: '1 1 220px' }}
                placeholder="Region name, e.g. Cypress Youth Soccer"
                maxLength={80}
                value={ownRegionName}
                onChange={(e) => setOwnRegionName(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || !ownRegionName.trim()}
                onClick={() =>
                  run(async () => {
                    await api.createRegion({ name: ownRegionName.trim() });
                    setOwnRegionName('');
                  }, 'Region created. It is in your menu now. Link your teams into it below.')
                }
              >
                Start my region
              </button>
            </div>
          )}
        </section>
      )}

      {!focus && showOrgCard && (
      <section className="card">
        <h2>Organizations</h2>
        <p className="note">
          An organization holds regions, and a region holds teams. Create an organization, add
          a region to it, then link your teams into that region below.
        </p>
        {h.createOrg.allowed && h.orgs.length === 0 ? (
          <div className="row">
            <input
              style={{ flex: '1 1 220px' }}
              placeholder="Organization name, e.g. AYSO Area 10"
              maxLength={80}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={busy || !orgName.trim()}
              onClick={() =>
                run(async () => {
                  await api.createOrg(orgName.trim());
                  setOrgName('');
                }, 'Organization created. Add a region to it next.')
              }
            >
              Create organization
            </button>
          </div>
        ) : h.orgs.length > 0 && h.createOrg.allowed ? (
          <p className="note">
            This plan allows one organization. Rename it below if the name needs to change.
          </p>
        ) : (
          upgradeNote('Organizations', h.createOrg) ?? (
            <p className="note">
              Only an organization director or admin can create organizations. To run your own,{' '}
              <a href="/account#trial">start a free 30-day trial</a> (no card needed).
            </p>
          )
        )}
      </section>
      )}

      {shownOrgs.map((o) => (
        <section className="card" key={o.id}>
          <h2>{focus ? `${o.name} settings` : o.name}</h2>
          {o.trialEndsAt && <TrialBadge endsAt={o.trialEndsAt} />}
          {o.canRename && (
            <div className="row" style={{ marginBottom: 12 }}>
              <input
                style={{ flex: '1 1 220px' }}
                placeholder="Organization name"
                value={orgEdit[o.id] ?? o.name}
                maxLength={80}
                onChange={(e) => setOrgEdit((p) => ({ ...p, [o.id]: e.target.value }))}
              />
              <button
                type="button"
                className="btn ghost"
                disabled={busy || !(orgEdit[o.id] ?? o.name).trim()}
                onClick={() =>
                  run(
                    () => api.updateOrg({ id: o.id, name: (orgEdit[o.id] ?? o.name).trim() }),
                    'Organization renamed.',
                  )
                }
              >
                Save org name
              </button>
            </div>
          )}
          {o.canManage && (
            <LogoUpload
              kind="org"
              id={o.id}
              version={o.logo}
              onChanged={() => {
                void load();
                onChanged();
              }}
            />
          )}
          {o.regions.length === 0 ? (
            <p className="note">No regions yet.</p>
          ) : (
            <table className="tiers">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Teams</th>
                  {o.canManage && managedOrgs.length > 1 && <th>Organization</th>}
                </tr>
              </thead>
              <tbody>
                {o.regions.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {o.canManage || r.canManage ? (
                        <div className="row">
                          <input
                            value={regionEdit[r.id]?.name ?? r.name}
                            maxLength={80}
                            disabled={!r.canRename}
                            title={r.canRename ? undefined : 'Only a director can rename the region'}
                            onChange={(e) =>
                              setRegionEdit((p) => ({
                                ...p,
                                [r.id]: { name: e.target.value },
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            disabled={busy || !(regionEdit[r.id]?.name ?? r.name).trim()}
                            onClick={() =>
                              run(
                                () =>
                                  api.updateRegion({
                                    id: r.id,
                                    name: (regionEdit[r.id]?.name ?? r.name).trim(),
                                  }),
                                'Region renamed.',
                              )
                            }
                          >
                            Save
                          </button>
                          <LogoUpload
                            kind="region"
                            id={r.id}
                            version={r.logo}
                            onChanged={() => {
                              void load();
                              onChanged();
                            }}
                          />
                        </div>
                      ) : (
                        <>{r.name}</>
                      )}
                    </td>
                    <td>{r.teams}</td>
                    {o.canManage && managedOrgs.length > 1 && (
                      <td>
                        <select
                          aria-label={`Organization for ${r.name}`}
                          value={o.id}
                          disabled={busy}
                          onChange={(e) =>
                            run(
                              () => api.updateRegion({ id: r.id, orgId: e.target.value }),
                              `${r.name} moved, along with its teams.`,
                            )
                          }
                        >
                          {managedOrgs.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {o.addRegion.allowed ? (
            <div className="row" style={{ marginTop: 12 }} data-tour="add-region">
              <input
                style={{ flex: '1 1 180px' }}
                placeholder="Region name, e.g. Region 42"
                maxLength={80}
                value={regionName[o.id] ?? ''}
                onChange={(e) => setRegionName((p) => ({ ...p, [o.id]: e.target.value }))}
              />
              <button
                type="button"
                className="btn ghost"
                disabled={busy || !(regionName[o.id] ?? '').trim()}
                onClick={() =>
                  run(async () => {
                    await api.createRegion({
                      orgId: o.id,
                      name: (regionName[o.id] ?? '').trim(),
                    });
                    setRegionName((p) => ({ ...p, [o.id]: '' }));
                  }, 'Region added. You can now link teams into it.')
                }
              >
                Add region
              </button>
            </div>
          ) : (
            upgradeNote('Regions', o.addRegion)
          )}
        </section>
      ))}

      {showInvites && (
      <section className="card" data-tour="invite-members">
        <h2>Invite members</h2>
        <p className="note">
          Pick where they join, then their role. They get an email with a link, and you can
          also send the link yourself by WhatsApp or text. Parents join from a team's Team &amp;
          roster tab, where their child is picked.
        </p>
        <div className="row">
          <select
            value={inviteScope}
            onChange={(e) => {
              setInviteScope(e.target.value);
              const kind = e.target.value.split(':')[0] as keyof typeof ROLES_BY_SCOPE;
              setInviteRole(ROLES_BY_SCOPE[kind]?.[0]?.[0] ?? 'coach');
            }}
          >
            <option value="">Where do they join?</option>
            {inviteOrgs.map((o) => (
              <option key={`org:${o.id}`} value={`org:${o.id}`}>
                Organization: {o.name}
              </option>
            ))}
            {inviteRegions.map((r) => (
              <option key={`region:${r.id}`} value={`region:${r.id}`}>
                Region: {r.label}
              </option>
            ))}
            {inviteTeams.map((t) => (
              <option key={`team:${t.id}`} value={`team:${t.id}`}>
                Team: {t.name}
              </option>
            ))}
          </select>
          <select
            value={inviteRole}
            disabled={!inviteScope}
            onChange={(e) => setInviteRole(e.target.value)}
          >
            {(ROLES_BY_SCOPE[inviteScope.split(':')[0] as keyof typeof ROLES_BY_SCOPE] ??
              ROLES_BY_SCOPE.team
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ marginTop: 9 }}>
          <input
            style={{ flex: '1 1 160px' }}
            placeholder="Name (optional)"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
          />
          <input
            style={{ flex: '1 1 220px' }}
            type="email"
            placeholder="person@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || !inviteEmail.trim() || !inviteScope}
            onClick={() =>
              run(async () => {
                const [scope, id] = inviteScope.split(':');
                const r = await api.invite({
                  email: inviteEmail.trim(),
                  name: inviteName.trim() || undefined,
                  role: inviteRole as Role,
                  orgId: scope === 'org' ? id : undefined,
                  regionId: scope === 'region' ? id : undefined,
                  teamId: scope === 'team' ? id : undefined,
                });
                setInviteEmail('');
                setInviteName('');
                setCreated(r);
              }, 'Invite created.')
            }
          >
            Send invite
          </button>
        </div>
      </section>
      )}

      {created && <InviteShare invite={created} onClose={() => setCreated(null)} />}

      {!signups && (!focus || shownTeams.some((t) => t.canMove)) && (
      <section className="card">
        <h2>{focus ? 'Teams' : 'Your teams'}</h2>
        <p className="note">
          Choose a region to link a team into it. The team joins that region's organization. Only
          organization and region admins and directors can move teams.
        </p>
        {shownTeams.length === 0 ? (
          <p className="note">No teams yet.</p>
        ) : (
          <table className="tiers">
            <thead>
              <tr>
                <th>Team</th>
                <th>Belongs to</th>
              </tr>
            </thead>
            <tbody>
              {shownTeams.map((t) => {
                const current = t.regionId ?? (t.orgId ? `org:${t.orgId}` : '');
                const known = targets.some((x) => x.id === current);
                return (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>
                      <select
                        aria-label={`Region for ${t.name}`}
                        value={current}
                        disabled={busy || !t.canMove}
                        onChange={(e) =>
                          run(
                            () => api.moveTeam(t.id, e.target.value || null),
                            e.target.value
                              ? `${t.name} linked.`
                              : `${t.name} removed from its organization.`,
                          )
                        }
                      >
                        <option value="">No organization</option>
                        {targets.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.label}
                          </option>
                        ))}
                        {current && !known && (
                          <option value={current} disabled>
                            {t.orgName}
                            {t.regionName ? ` › ${t.regionName}` : ' (no region)'}
                          </option>
                        )}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {h.teams.length > 0 && targets.length === 0 && !focus && (
          <p className="note">
            {h.orgs.length === 0
              ? 'Create an organization and a region first, then link teams here.'
              : 'Add a region to an organization you manage, then link teams here.'}
          </p>
        )}
      </section>
      )}
    </>
  );
}
