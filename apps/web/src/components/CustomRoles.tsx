import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CustomRolesView } from '../lib/api';

type RoleView = CustomRolesView['roles'][number];

interface Draft {
  roleId: string | null;
  name: string;
  permissions: string[];
  divisions: string[];
  teamIds: string[];
}

const EMPTY: Draft = { roleId: null, name: '', permissions: [], divisions: [], teamIds: [] };

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * Custom roles (Shadi, 10/21), in an organization's or region's Settings: its
 * staff make a role, pick the age groups and/or single teams it covers and
 * what it may do there, then give it to people by email. Hidden from anyone
 * who cannot invite people at this organization or region.
 */
export default function CustomRoles({ scope, id }: { scope: 'org' | 'region'; id: string }) {
  const [view, setView] = useState<CustomRolesView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [emails, setEmails] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setView(await api.customRoles(scope, id));
      setHidden(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setHidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load custom roles');
    }
  }, [scope, id]);

  useEffect(() => {
    setView(null);
    setDraft(null);
    void load();
  }, [load]);

  async function act(b: Parameters<typeof api.customRoleAction>[0], done: (v: CustomRolesView) => string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const next = await api.customRoleAction(b);
      setView(next);
      setMsg(done(next));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!view) return error ? <section className="card err">{error}</section> : null;

  const teamName = new Map(view.teams.map((t) => [t.id, t.name]));
  const label = new Map(view.permissions.map((p) => [p.key, p.label]));

  function covers(r: RoleView): string {
    const parts = [...r.divisions, ...r.teamIds.map((t) => teamName.get(t) ?? 'a removed team')];
    return `${parts.join(', ')} · ${r.teamCount} ${r.teamCount === 1 ? 'team' : 'teams'}`;
  }

  async function save() {
    if (!draft) return;
    const fields = { name: draft.name, permissions: draft.permissions, divisions: draft.divisions, teamIds: draft.teamIds };
    const ok = await act(
      draft.roleId
        ? { scope, id, action: 'update', roleId: draft.roleId, ...fields }
        : { scope, id, action: 'create', ...fields },
      () => (draft.roleId ? `${draft.name} saved.` : `${draft.name} made. Now add the people who hold it.`),
    );
    if (ok) setDraft(null);
  }

  async function assign(r: RoleView) {
    const email = (emails[r.id] ?? '').trim();
    if (!email) return;
    const ok = await act({ scope, id, action: 'assign', roleId: r.id, email }, (v) =>
      v.result === 'added'
        ? `${email} is now ${r.name}.`
        : v.result === 'already'
          ? `${email} already has this role.`
          : v.result === 'already-invited'
            ? `${email} was already invited.`
            : v.emailed
              ? `${email} is not on Lineup yet, so we emailed them an invite. They get the role when they accept.`
              : `${email} is not on Lineup yet. Send them this invite link: ${v.link ?? ''}`,
    );
    if (ok) setEmails((x) => ({ ...x, [r.id]: '' }));
  }

  // Teams listed for single picks: those not already covered by a chosen age group.
  const singles = draft ? view.teams.filter((t) => !(t.ageGroup && draft.divisions.includes(t.ageGroup))) : [];

  return (
    <section className="card" id="custom-roles">
      <div className="card-head">
        <h2>🧩 Custom roles</h2>
        {!draft && (
          <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...EMPTY })}>
            ＋ New role
          </button>
        )}
      </div>
      <p className="sub">
        Make your own roles, such as a BU10 Director. Pick the age groups or teams it covers and what it can do there.
        People with the role see only those teams, never the rest of {view.name}.
      </p>
      {msg && <p className="note" role="status">{msg}</p>}
      {error && <p className="error">{error}</p>}

      {draft && (
        <div className="comp-form">
          <div className="field-grid">
            <label>
              Role name
              <input
                value={draft.name}
                maxLength={40}
                placeholder="BU10 Director"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
          </div>

          <h3 className="group-title">Age groups</h3>
          {view.ageGroups.length ? (
            <div className="chips" role="group" aria-label="Age groups">
              {view.ageGroups.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`chip${draft.divisions.includes(g) ? ' on' : ''}`}
                  onClick={() => setDraft({ ...draft, divisions: toggle(draft.divisions, g) })}
                >
                  {g}
                </button>
              ))}
            </div>
          ) : (
            <p className="note">No teams with an age group here yet.</p>
          )}
          <p className="sub">Covers every team in that age group, including teams added later.</p>

          {singles.length > 0 && (
            <>
              <h3 className="group-title">Or single teams</h3>
              <div className="chips" role="group" aria-label="Teams">
                {singles.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`chip${draft.teamIds.includes(t.id) ? ' on' : ''}`}
                    onClick={() => setDraft({ ...draft, teamIds: toggle(draft.teamIds, t.id) })}
                  >
                    {t.name}
                    {t.ageGroup ? ` · ${t.ageGroup}` : ''}
                    {scope === 'org' && t.regionName ? ` · ${t.regionName}` : ''}
                  </button>
                ))}
              </div>
            </>
          )}

          <h3 className="group-title">What they can do</h3>
          <ul className="check-list">
            {view.permissions.map((p) => (
              <li key={p.key}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={p.fixed || draft.permissions.includes(p.key)}
                    disabled={p.fixed}
                    onChange={() => setDraft({ ...draft, permissions: toggle(draft.permissions, p.key) })}
                  />
                  <span>
                    <b>{p.label}</b>
                    <span className="sub"> · {p.hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || !draft.name.trim() || (!draft.divisions.length && !draft.teamIds.length)}
              onClick={() => void save()}
            >
              {draft.roleId ? 'Save role' : 'Make role'}
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {view.roles.length === 0 && !draft && <p className="note">No custom roles yet.</p>}

      {view.roles.map((r) => (
        <div key={r.id} className="custom-role">
          <div className="row custom-role-head">
            <h3 className="group-title">{r.name}</h3>
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() =>
                setDraft({
                  roleId: r.id,
                  name: r.name,
                  permissions: [...r.permissions],
                  divisions: [...r.divisions],
                  teamIds: [...r.teamIds],
                })
              }
            >
              Edit
            </button>
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete ${r.name}? Everyone who has it loses access to its teams.`)) {
                  void act({ scope, id, action: 'delete', roleId: r.id }, () => `${r.name} deleted.`);
                }
              }}
            >
              Delete
            </button>
          </div>
          <p className="sub">Covers {covers(r)}</p>
          <p className="sub">
            Can: see their teams
            {r.permissions.length ? `, ${r.permissions.map((k) => (label.get(k) ?? k).toLowerCase()).join(', ')}` : ' (view only)'}
          </p>

          <ul className="people-list">
            {r.people.map((p) => (
              <li key={p.userId} className="checkin-child">
                <span className="person-name">
                  {p.name}
                  {p.email && p.email !== p.name && <span className="sub"> · {p.email}</span>}
                </span>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Take ${r.name} away from ${p.name}?`)) {
                      void act({ scope, id, action: 'unassign', roleId: r.id, userId: p.userId }, () => `${p.name} no longer has ${r.name}.`);
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
            {r.invited.map((p) => (
              <li key={p.inviteId} className="checkin-child">
                <span className="person-name">
                  {p.email}
                  <span className="sub"> · invited</span>
                </span>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() => void act({ scope, id, action: 'unassign', roleId: r.id, inviteId: p.inviteId }, () => `Invite to ${p.email} cancelled.`)}
                >
                  Cancel invite
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void assign(r);
            }}
          >
            <input
              type="email"
              placeholder="Add someone by email"
              value={emails[r.id] ?? ''}
              onChange={(e) => setEmails((x) => ({ ...x, [r.id]: e.target.value }))}
            />
            <button type="submit" className="btn btn-sm" disabled={busy || !(emails[r.id] ?? '').trim()}>
              Add
            </button>
          </form>
        </div>
      ))}
    </section>
  );
}
