import { useEffect, useState } from 'react';
import { PAID_ONLY_ROLES } from '@lineup/shared';
import { api, type ImpersonationState } from '../lib/api';

const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Org admin',
  director: 'Director',
  region_admin: 'Region admin',
  coach: 'Coach',
  assistant: 'Assistant coach',
  team_parent: 'Team parent',
  parent: 'Parent',
  player: 'Player',
  viewer: 'Viewer',
};

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  premium: 'Premium (paid)',
  parent: 'Parent',
  teamParent: 'Parent',
  referee: 'Referee',
  coach: 'Coach',
  region: 'Region',
  organization: 'Organization',
  organizationPlus: 'Organization Plus',
};

/** Roles that only exist on a paid organization or region plan. */
const STAFF_ROLES: readonly string[] = PAID_ONLY_ROLES;

/**
 * Testing tool: assume a role and/or subscription plan.
 *
 * Only renders for people on the server-side allowlist. Changing role or plan
 * only changes how YOUR OWN teams behave — it never exposes anyone else's data.
 */
export default function Impersonation({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<ImpersonationState | null>(null);
  const [role, setRole] = useState('');
  const [tier, setTier] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.impersonation().then(setState).catch(() => setState(null));
  }, []);

  if (!state) return null;
  // Hidden entirely for everyone else, but still shown to someone mid-session
  // so they are never stranded in an assumed role.
  if (!state.available && !state.active) return null;

  async function start() {
    setError(null);
    setBusy(true);
    try {
      setState(await api.startImpersonation({ role: role || null, tier: tier || null }));
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      setState(await api.stopImpersonation());
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Test as another role</h2>

      {error && <p className="danger-text">{error}</p>}

      {state.active ? (
        <>
          <dl className="kv">
            <dt>Role</dt>
            <dd>{state.role ? ROLE_LABEL[state.role] ?? state.role : 'unchanged'}</dd>
            <dt>Plan</dt>
            <dd>{state.tier ? TIER_LABEL[state.tier] ?? state.tier : 'unchanged'}</dd>
            <dt>Expires</dt>
            <dd>{state.until ? new Date(state.until).toLocaleString() : '—'}</dd>
          </dl>
          <button type="button" className="btn" onClick={stop} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop testing'}
          </button>
        </>
      ) : (
        <>
          <p className="note">
            Pick a role, a plan, or both. This only changes how your own teams behave, and it
            expires by itself after 8 hours.
          </p>

          <div className="field-grid">
            <label>
              Role
              <select
                value={role}
                onChange={(e) => {
                  const next = e.target.value;
                  setRole(next);
                  // Organization and region staff only exist on a paid plan.
                  if (STAFF_ROLES.includes(next)) setTier('premium');
                }}
              >
                <option value="">Keep my role</option>
                {state.roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r] ?? r}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Plan
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                {!STAFF_ROLES.includes(role) && <option value="">Keep my plan</option>}
                {state.tiers
                  .filter((t) => !STAFF_ROLES.includes(role) || t === 'premium')
                  .map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t] ?? t}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {STAFF_ROLES.includes(role) && (
            <p className="note">Organization and region admins and directors are always on a paid plan.</p>
          )}

          <button
            type="button"
            className="btn"
            onClick={start}
            disabled={busy || (!role && !tier)}
          >
            {busy ? 'Starting…' : 'Start testing'}
          </button>
        </>
      )}
    </section>
  );
}

/** Always-visible reminder that the session is not showing the real account. */
export function ImpersonationBanner({
  state,
  onStop,
}: {
  state: ImpersonationState;
  onStop: () => void;
}) {
  if (!state.active) return null;
  const bits = [
    state.role ? ROLE_LABEL[state.role] ?? state.role : null,
    state.tier ? `${TIER_LABEL[state.tier] ?? state.tier} plan` : null,
  ].filter(Boolean);

  return (
    <div className="impersonation-banner" role="status">
      <span aria-hidden="true">🎭</span>
      <span>
        Testing as <strong>{bits.join(' · ')}</strong>
      </span>
      <button type="button" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}
