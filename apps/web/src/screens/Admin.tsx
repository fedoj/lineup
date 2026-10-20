import { useCallback, useEffect, useState } from 'react';
import { api, type AdminBilling, type AdminUsage, type Coupon, type RefundRequest, type SupportComment, type SupportRequest } from '../lib/api';
import { isNativeApp } from '../lib/native';
import { onTestSite, switchAppToLiveSite, switchAppToTestSite } from '../lib/appSite';
import { SupportThread } from './Support';

type View =
  | 'insights' | 'usage' | 'summary' | 'users' | 'notify' | 'billing' | 'integrations'
  | 'abuse' | 'subscriptions' | 'deletions' | 'support';

const VIEWS: Array<[View, string]> = [
  ['insights', 'Dashboard'],
  ['usage', 'Usage'],
  ['summary', 'Totals'],
  ['users', 'Users'],
  ['notify', 'Notify'],
  ['billing', 'Billing'],
  ['integrations', 'Integrations'],
  ['subscriptions', 'Subscriptions'],
  ['abuse', 'Heavy use'],
  ['deletions', 'Deletions'],
  ['support', 'Support'],
];

/** Tabs that load their own data instead of /admin?view=. */
const SELF_LOADING: readonly View[] = ['usage', 'notify', 'billing', 'integrations'];

const TIER_LABEL: Record<string, string> = {
  free: 'Free', parent: 'Parent', teamParent: 'Parent', referee: 'Referee', coach: 'Coach', region: 'Region',
  organization: 'Organization', organizationPlus: 'Organization Plus',
};
const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <span className={`stat-n${tone ? ` ${tone}` : ''}`}>{n}</span>
      <span className="stat-l">{label}</span>
    </div>
  );
}

/** The operator dashboard: subscribers, growth, activity, support and cost. */
function Insights({ data }: { data: any }) {
  const subs: Record<string, number> = Object.fromEntries((data.subscribers ?? []).map((s: any) => [s.tier, s.users]));
  const paid = ['parent', 'teamParent', 'referee', 'coach', 'region', 'organization', 'organizationPlus'].reduce((a, t) => a + (subs[t] ?? 0), 0);
  const sup: Record<string, number> = Object.fromEntries((data.support ?? []).map((s: any) => [s.status, s.n]));
  const g = data.growth ?? {};
  const s = data.sessions ?? {};
  const maxUsers = Math.max(1, ...(data.daily ?? []).map((d: any) => d.users));

  return (
    <>
      <section className="card">
        <h2>Subscribers by tier</h2>
        <div className="stat-row">
          <Stat n={subs.free ?? 0} label="free" />
          <Stat n={subs.coach ?? 0} label="coach" />
          {/* Team parent was merged into Parent (10/19); older rows count as Parent. */}
          <Stat n={(subs.parent ?? 0) + (subs.teamParent ?? 0)} label="parent" />
          <Stat n={subs.referee ?? 0} label="referee" />
          <Stat n={subs.organization ?? 0} label="organization" />
          <Stat n={paid} label="paid total" tone="good" />
          <Stat n={g.cancelled ?? 0} label="cancelled" />
        </div>
      </section>

      <section className="card">
        <h2>New users and subscribers</h2>
        <table className="tiers">
          <thead>
            <tr>
              <th />
              <th>Last month</th>
              <th>3 months</th>
              <th>6 months</th>
              <th>12 months</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>New users</td>
              <td>{g.users_1m ?? 0}</td>
              <td>{g.users_3m ?? 0}</td>
              <td>{g.users_6m ?? 0}</td>
              <td>{g.users_12m ?? 0}</td>
            </tr>
            <tr>
              <td>New paid subscribers</td>
              <td>{g.subs_1m ?? 0}</td>
              <td>{g.subs_3m ?? 0}</td>
              <td>{g.subs_6m ?? 0}</td>
              <td>{g.subs_12m ?? 0}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Signed-in activity</h2>
        <div className="stat-row">
          <Stat n={s.online_now ?? 0} label="online now" tone="good" />
          <Stat n={s.today ?? 0} label="today" />
          <Stat n={s.last7 ?? 0} label="last 7 days" />
          <Stat n={s.last30 ?? 0} label="last 30 days" />
          <Stat n={s.requests30 ?? 0} label="requests, 30 days" />
        </div>
        <div className="spark" aria-label="Active users per day, last 14 days">
          {(data.daily ?? []).map((d: any) => (
            <div key={d.day} className="spark-col" title={`${d.day}: ${d.users} users, ${d.requests} requests`}>
              <div className="spark-bar" style={{ height: `${Math.round((d.users / maxUsers) * 100)}%` }} />
              <span>{d.day.slice(8)}</span>
            </div>
          ))}
        </div>
        <p className="note">"Online now" means used in the last 15 minutes. Activity counts start from when tracking was switched on.</p>
      </section>

      <section className="card">
        <h2>Support tickets</h2>
        <div className="stat-row">
          <Stat n={sup.open ?? 0} label="open" tone={(sup.open ?? 0) > 0 ? 'bad' : undefined} />
          <Stat n={sup.in_progress ?? 0} label="in progress" />
          <Stat n={sup.resolved ?? 0} label="resolved" tone="good" />
          <Stat n={sup.dismissed ?? 0} label="closed" />
        </div>
        <p className="note">Open the Support tab to read and answer them.</p>
      </section>

      <section className="card">
        <h2>Usage and cost by tier (last 30 days)</h2>
        <div className="table-scroll">
          <table className="tiers">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Users</th>
                <th>Active</th>
                <th>Requests</th>
                <th>Teams</th>
                <th>Players</th>
                <th>Games</th>
                <th>Est. cost / mo</th>
              </tr>
            </thead>
            <tbody>
              {(data.tiers ?? []).map((t: any) => (
                <tr key={t.tier}>
                  <td>{TIER_LABEL[t.tier] ?? t.tier}</td>
                  <td>{t.users}</td>
                  <td>{t.active}</td>
                  <td>{t.requests}</td>
                  <td>{t.teams}</td>
                  <td>{t.players}</td>
                  <td>{t.games}</td>
                  <td>{money(t.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Usage and cost by user (last 30 days)</h2>
        <div className="table-scroll">
          <table className="tiers">
            <thead>
              <tr>
                <th>User</th>
                <th>Tier</th>
                <th>Requests</th>
                <th>Active days</th>
                <th>Teams</th>
                <th>Players</th>
                <th>Games</th>
                <th>Est. cost / mo</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {(data.users ?? []).map((u: any) => (
                <tr key={u.id}>
                  <td>{u.name ?? '—'}</td>
                  <td>{TIER_LABEL[u.tier] ?? u.tier}</td>
                  <td>{u.requests}</td>
                  <td>{u.days}</td>
                  <td>{u.teams}</td>
                  <td>{u.players}</td>
                  <td>{u.games}</td>
                  <td>{money(u.cost)}</td>
                  <td>{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          Cost is the platform's Azure spend ({money(data.monthlyCost)}/month: hosting, database and
          email for both environments) shared out by each tier's and user's share of requests. It is
          an estimate for comparing usage, not a bill.
        </p>
      </section>
    </>
  );
}

const ROLE_NAME: Record<string, string> = {
  org_admin: 'Organization admins',
  director: 'Directors',
  region_admin: 'Region admins',
  coach: 'Coaches',
  assistant: 'Assistant coaches',
  team_parent: 'Team parents',
  parent: 'Parents',
  player: 'Players',
  viewer: 'Viewers',
};

/** Compose an in-app message to any scope, role and plan, and see past ones. */
function Notify() {
  const [info, setInfo] = useState<any>(null);
  const [scope, setScope] = useState<'platform' | 'org' | 'region' | 'team'>('platform');
  const [scopeId, setScopeId] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [tiers, setTiers] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.adminNotifyInfo().then(setInfo).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const target = { scope, id: scope === 'platform' ? null : scopeId || null, roles, tiers };
  const ready = scope === 'platform' || Boolean(scopeId);

  useEffect(() => {
    setCount(null);
    if (!ready) return;
    let cancelled = false;
    api
      .adminNotify({ target, dryRun: true })
      .then((r) => !cancelled && setCount(r.recipients))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeId, roles.join(), tiers.join()]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function send() {
    if (!window.confirm(`Send "${title}" to ${count ?? 'the selected'} people?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.adminNotify({ title, body: message, link: link || undefined, target });
      setNotice(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}.`);
      setTitle('');
      setMessage('');
      setLink('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ id: string; label: string }> =
    scope === 'org'
      ? (info?.scopes.orgs ?? []).map((o: any) => ({ id: o.id, label: o.name }))
      : scope === 'region'
        ? (info?.scopes.regions ?? []).map((r: any) => ({ id: r.id, label: `${r.orgName} › ${r.name}` }))
        : scope === 'team'
          ? (info?.scopes.teams ?? []).map((t: any) => ({ id: t.id, label: t.name }))
          : [];

  return (
    <>
      <section className="card">
        <h2>Send a notification</h2>
        <p className="note">Shows in each recipient's bell inside the app.</p>
        {error && <p className="danger-text">{error}</p>}
        {notice && <p className="note" role="status">{notice}</p>}
        <div className="field-grid">
          <label>
            Send to
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as typeof scope);
                setScopeId('');
              }}
            >
              <option value="platform">Everyone on Lineup</option>
              <option value="org">An organization</option>
              <option value="region">A region</option>
              <option value="team">A team</option>
            </select>
          </label>
          {scope !== 'platform' && (
            <label>
              Which one
              <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <fieldset className="check-group">
          <legend>Roles (none ticked = everyone)</legend>
          {(info?.roles ?? []).map((r: string) => (
            <label key={r} className="check">
              <input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(roles, setRoles, r)} />
              {ROLE_NAME[r] ?? r}
            </label>
          ))}
        </fieldset>
        <fieldset className="check-group">
          <legend>Plans (none ticked = every plan)</legend>
          {(info?.tiers ?? []).map((t: string) => (
            <label key={t} className="check">
              <input type="checkbox" checked={tiers.includes(t)} onChange={() => toggle(tiers, setTiers, t)} />
              {TIER_LABEL[t] ?? t}
            </label>
          ))}
        </fieldset>
        <label>
          Title
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Check-in is open" />
        </label>
        <label>
          Message
          <textarea value={message} maxLength={1000} rows={4} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label>
          Link (optional)
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="/calendar or https://…" />
        </label>
        <div className="row">
          <button type="button" className="btn" disabled={busy || !ready || !title.trim() || !message.trim() || count === 0} onClick={send}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <span className="note">{ready ? (count === null ? 'Counting recipients…' : `${count} recipient${count === 1 ? '' : 's'}`) : 'Choose who to send to'}</span>
        </div>
      </section>

      <section className="card">
        <h2>Sent</h2>
        {!info ? (
          <p className="note">Loading…</p>
        ) : info.history.length === 0 ? (
          <p className="note">Nothing sent yet.</p>
        ) : (
          <table className="tiers">
            <thead>
              <tr>
                <th>Message</th>
                <th>To</th>
                <th>Read</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {info.history.map((h: any) => (
                <tr key={h.id}>
                  <td>
                    {h.title}
                    <br />
                    <span className="sub">{h.adminName ? `by ${h.adminName}` : ''}</span>
                  </td>
                  <td>
                    {h.target.scope === 'platform' ? 'Everyone' : h.target.scope}
                    {h.target.roles?.length ? ` · ${h.target.roles.join(', ')}` : ''}
                    {h.target.tiers?.length ? ` · ${h.target.tiers.join(', ')}` : ''}
                  </td>
                  <td>
                    {h.readCount}/{h.recipients}
                  </td>
                  <td>{new Date(h.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  disable: 'Disabled',
  enable: 'Re-enabled',
  signout: 'Signed out everywhere',
  delete: 'Deletion queued',
  recover: 'Recovered',
};

const PAID_TIERS = ['parent', 'teamParent', 'referee', 'coach', 'region', 'organization', 'organizationPlus'];

function useBilling() {
  const [data, setData] = useState<AdminBilling | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.adminBilling().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Could not load billing'));
  }, []);
  useEffect(load, [load]);
  return { data, error, reload: load };
}

function couponValue(c: Coupon): string {
  return c.percentOff != null ? `${c.percentOff}% off` : `$${((c.amountOffCents ?? 0) / 100).toFixed(2)} off`;
}

/** Subscribers by plan, coupons and refund requests. */
function Billing() {
  const { data, error, reload } = useBilling();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [plans, setPlans] = useState<string[]>([]);
  const [maxUses, setMaxUses] = useState('');
  const [ends, setEnds] = useState('');
  const [note, setNote] = useState('');

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      reload();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createCoupon() {
    const ok = await act(
      () =>
        api.adminBillingAction({
          action: 'coupon.create',
          code,
          percentOff: kind === 'percent' ? Number(value) : null,
          amountOffCents: kind === 'amount' ? Math.round(Number(value) * 100) : null,
          tiers: plans,
          maxRedemptions: maxUses ? Number(maxUses) : null,
          expiresAt: ends || null,
          note: note || null,
        }),
      `Coupon ${code.toUpperCase()} created.`,
    );
    if (ok) {
      setCode('');
      setValue('');
      setPlans([]);
      setMaxUses('');
      setEnds('');
      setNote('');
    }
  }

  async function decide(r: RefundRequest, status: 'approved' | 'declined' | 'refunded') {
    const adminNote = window.prompt(
      `${status === 'declined' ? 'Decline' : status === 'refunded' ? 'Mark refunded' : 'Approve'} the refund for ${r.email ?? r.name ?? 'this user'}? Optional note for them:`,
      '',
    );
    if (adminNote === null) return;
    await act(
      () => api.adminBillingAction({ action: 'refund.decide', id: r.id, status, note: adminNote }),
      `Refund ${status}. The user has been notified in the app.`,
    );
  }

  /** Send the refund through Stripe (counts toward the monthly cap) and end the plan. */
  async function issue(r: RefundRequest) {
    const price = ((data?.prices[r.tier] ?? 0) / 100).toFixed(2);
    const amount = window.prompt(
      `Refund ${r.email ?? r.name ?? 'this user'} through Stripe, and end their plan now. Amount in dollars (up to what they paid):`,
      price,
    );
    if (amount === null) return;
    const cents = Math.round(Number(amount) * 100);
    if (!(cents > 0)) {
      setActionError('Enter an amount over $0.');
      return;
    }
    await act(
      () => api.adminBillingAction({ action: 'refund.issue', id: r.id, amountCents: cents, endPlan: true }),
      `Refund of $${(cents / 100).toFixed(2)} sent through Stripe and the plan ended. The user has been notified.`,
    );
  }

  if (error) return <section className="card err">{error}</section>;
  if (!data) return <section className="card">Loading…</section>;

  const stripe = data.integrations.find((i) => i.key === 'stripe');
  const pending = data.refunds.filter((r) => r.status === 'pending');
  const totalSubs = PAID_TIERS.reduce((a, t) => a + (data.subscribers[t] ?? 0), 0);
  const yearly = PAID_TIERS.reduce((a, t) => a + (data.subscribers[t] ?? 0) * (data.prices[t] ?? 0), 0) / 100;
  const m = data.money;
  const capLeft = m ? Math.max(0, m.refundCapCents - m.refundedCents) / 100 : 0;

  return (
    <>
      {stripe?.status !== 'connected' && (
        <section className="card">
          <p className="note warn">
            Stripe is not connected yet. Coupons and refund decisions are recorded here and take effect once
            Stripe subscriptions are switched on. Nothing on this page charges or pays anyone.
          </p>
        </section>
      )}
      {actionError && <section className="card err">{actionError}</section>}
      {notice && (
        <section className="card" role="status">
          {notice}
        </section>
      )}

      {m && stripe?.status === 'connected' && (
        <section className="card">
          <h2>
            This month in Stripe{m.mode === 'test' ? ' (test mode)' : ''}
          </h2>
          <div className="stat-row">
            <Stat n={m.revenueCents == null ? '—' : money(m.revenueCents / 100)} label="paid in" tone="good" />
            <Stat n={m.activePaidPlans} label="plans paid through Stripe" />
            <Stat n={money(m.refundedCents / 100)} label={`refunded of ${money(m.refundCapCents / 100)} limit`} tone={capLeft === 0 ? 'bad' : undefined} />
          </div>
          <p className="note">
            Since {new Date(m.monthStart).toLocaleDateString()}. Lineup can send up to {money(m.refundCapCents / 100)} in refunds
            each month ({money(capLeft)} left); anything more is done in the Stripe dashboard, which is also the place for payouts,
            disputes and taxes.
          </p>
        </section>
      )}

      <section className="card">
        <h2>Subscribers</h2>
        <div className="stat-row">
          <Stat n={totalSubs} label="paying" tone="good" />
          <Stat n={money(yearly)} label="per year at list price" />
          <Stat n={pending.length} label="refunds to review" tone={pending.length ? 'bad' : undefined} />
        </div>
        <table className="tiers">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Price</th>
              <th>Subscribers</th>
            </tr>
          </thead>
          <tbody>
            {PAID_TIERS.map((t) => (
              <tr key={t}>
                <td>{TIER_LABEL[t]}</td>
                <td>{money((data.prices[t] ?? 0) / 100)}/yr</td>
                <td>{data.subscribers[t] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Refund requests</h2>
        {data.refunds.length === 0 ? (
          <p className="note">No refund requests. Subscribers ask for one from Help &amp; support, after cancelling their subscription.</p>
        ) : (
          <table className="tiers">
            <thead>
              <tr>
                <th>Who</th>
                <th>Plan</th>
                <th>Reason</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.refunds.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name ?? r.email ?? r.userId}
                    <br />
                    <span className="sub">{new Date(r.createdAt).toLocaleDateString()}</span>
                  </td>
                  <td>{TIER_LABEL[r.tier] ?? r.tier}</td>
                  <td>{r.reason}</td>
                  <td>
                    {r.status}
                    {r.amountCents != null && r.status === 'refunded' && <> · {money(r.amountCents / 100)}</>}
                    {r.adminNote && (
                      <>
                        <br />
                        <span className="sub">{r.adminNote}</span>
                      </>
                    )}
                  </td>
                  <td>
                    {r.canIssue && (
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void issue(r)}>
                        Send refund
                      </button>
                    )}
                    {r.status === 'pending' && (
                      <div className="row">
                        {!r.canIssue && (
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(r, 'approved')}>
                            Approve
                          </button>
                        )}
                        <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => decide(r, 'declined')}>
                          Decline
                        </button>
                      </div>
                    )}
                    {r.status === 'approved' && !r.canIssue && (
                      <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => decide(r, 'refunded')}>
                        Mark refunded
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Coupons</h2>
        <p className="note">
          Codes people enter at checkout. Leave plans unticked for every paid plan.
        </p>
        <div className="field-grid">
          <label>
            Code
            <input value={code} maxLength={32} placeholder="e.g. FALL25" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <label>
            Discount
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="percent">Percent off</option>
              <option value="amount">Dollars off</option>
            </select>
          </label>
          <label>
            {kind === 'percent' ? 'Percent (1 to 100)' : 'Dollars'}
            <input type="number" min={kind === 'percent' ? 1 : 0.01} max={kind === 'percent' ? 100 : undefined} step={kind === 'percent' ? 1 : 0.01} value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <label>
            Max uses (optional)
            <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </label>
          <label>
            Ends (optional)
            <input type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
          </label>
          <label>
            Note (optional)
            <input value={note} maxLength={200} placeholder="e.g. Fall club promo" onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <fieldset className="check-group">
          <legend>Plans</legend>
          {PAID_TIERS.map((t) => (
            <label key={t} className="check">
              <input
                type="checkbox"
                checked={plans.includes(t)}
                onChange={() => setPlans((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}
              />
              {TIER_LABEL[t]}
            </label>
          ))}
        </fieldset>
        <button type="button" className="btn" disabled={busy || code.trim().length < 3 || !value} onClick={createCoupon}>
          Create coupon
        </button>

        {data.coupons.length > 0 && (
          <table className="tiers">
            <thead>
              <tr>
                <th>Code</th>
                <th>Discount</th>
                <th>Plans</th>
                <th>Used</th>
                <th>Ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.coupons.map((c) => (
                <tr key={c.id} className={c.active && !c.expired ? '' : 'muted'}>
                  <td>
                    <strong>{c.code}</strong>
                    {c.note && (
                      <>
                        <br />
                        <span className="sub">{c.note}</span>
                      </>
                    )}
                  </td>
                  <td>{couponValue(c)}</td>
                  <td>{c.tiers.length ? c.tiers.map((t) => TIER_LABEL[t] ?? t).join(', ') : 'All paid plans'}</td>
                  <td>
                    {c.redemptions}
                    {c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}
                  </td>
                  <td>{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : 'Never'}{c.expired ? ' (ended)' : ''}</td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost btn-sm"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => api.adminBillingAction({ action: 'coupon.toggle', id: c.id, active: !c.active }),
                          `${c.code} ${c.active ? 'turned off' : 'turned back on'}.`,
                        )
                      }
                    >
                      {c.active ? 'Turn off' : 'Turn on'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  off: 'Off',
  pending: 'Pending',
  error: 'Problem',
};

/** Every connected service and whether it is set up. Never shows a secret. */
function Integrations() {
  const { data, error, reload } = useBilling();
  if (error) return <section className="card err">{error}</section>;
  if (!data) return <section className="card">Loading…</section>;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Integrations</h2>
        <button type="button" className="btn ghost btn-sm" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="note">
        Services Lineup depends on. Keys and passwords live in Azure Key Vault and are never shown here.
      </p>
      <ul className="integrations">
        {data.integrations.map((i) => (
          <li key={i.key} className={`integration ${i.status}`}>
            <span className="integration-dot" aria-hidden="true" />
            <div>
              <strong>{i.name}</strong>
              <div className="sub">{i.detail}</div>
            </div>
            <span className="integration-status">{STATUS_LABEL[i.status] ?? i.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One account: who they are, what they hold, and the controls over it. */
function UserDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.adminUser(id).then(setD).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  async function run(action: 'disable' | 'enable' | 'signout' | 'delete' | 'recover', confirmText: string) {
    if (!window.confirm(confirmText)) return;
    const reason =
      action === 'disable' || action === 'delete'
        ? window.prompt('Reason (optional, kept in the audit log)') ?? undefined
        : undefined;
    setBusy(true);
    setNotice(null);
    try {
      await api.adminUserAction({ userId: id, action, reason });
      setNotice(`${ACTION_LABEL[action]}.`);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const p = d?.profile;
  const fmt = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

  return (
    <section className="card admin-user">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{p ? p.displayName ?? p.email ?? 'User' : 'User'}</h2>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <p className="danger-text">{error}</p>}
      {notice && <p className="note" role="status">{notice}</p>}
      {!d && !error && <p className="note">Loading…</p>}
      {p && (
        <>
          <div className="pill-row">
            {p.isPlatformAdmin && <span className="pill">Platform admin</span>}
            {p.disabledAt && <span className="pill bad">Disabled</span>}
            {p.deactivatedAt && <span className="pill bad">Deactivated {new Date(p.deactivatedAt).toLocaleDateString()}</span>}
            {d.deletion && (
              <span className="pill bad">Deletes {new Date(d.deletion.executeAt).toLocaleDateString()}</span>
            )}
            <span className="pill">{TIER_LABEL[p.tier] ?? p.tier}</span>
          </div>
          <dl className="kv">
            <dt>Email</dt>
            <dd>{p.email ?? '—'}</dd>
            <dt>User id</dt>
            <dd className="sub">{p.id}</dd>
            <dt>Joined</dt>
            <dd>{fmt(p.createdAt)}</dd>
            <dt>Last seen</dt>
            <dd>{fmt(p.lastSeenAt)}</dd>
            <dt>Activity</dt>
            <dd>
              {d.activity?.requests7 ?? 0} requests in 7 days, {d.activity?.activeDays30 ?? 0} active days in 30
            </dd>
            <dt>Support</dt>
            <dd>
              {d.tickets?.open ?? 0} open of {d.tickets?.total ?? 0} tickets
            </dd>
            {p.disabledAt && (
              <>
                <dt>Disabled</dt>
                <dd>
                  {fmt(p.disabledAt)}
                  {p.disabledReason ? ` · ${p.disabledReason}` : ''}
                </dd>
              </>
            )}
          </dl>

          <h3>Roles</h3>
          {d.memberships.length ? (
            <ul className="plain">
              {d.memberships.map((m: any, i: number) => (
                <li key={i}>
                  {m.role} · {m.scope} {m.name ?? ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">No memberships.</p>
          )}

          <h3>Teams owned</h3>
          {d.teams.length ? (
            <ul className="plain">
              {d.teams.map((t: any) => (
                <li key={t.id}>
                  {t.name} · {t.games} games
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">None.</p>
          )}

          <h3>Account controls</h3>
          {d.isSelf ? (
            <p className="note">These controls are not available on your own account.</p>
          ) : (
            <div className="row wrap">
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => run('signout', 'Sign this user out on every device? They can sign straight back in.')}
              >
                Sign out everywhere
              </button>
              {p.disabledAt ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy || Boolean(d.deletion)}
                  onClick={() => run('enable', 'Re-enable this account?')}
                >
                  Enable account
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => run('disable', 'Disable this account? They are signed out and cannot use Lineup until re-enabled.')}
                >
                  Disable account
                </button>
              )}
              {d.deletion ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => run('recover', 'Cancel the pending deletion and restore this account?')}
                >
                  Recover account
                </button>
              ) : (
                <button
                  type="button"
                  className="btn danger"
                  disabled={busy}
                  onClick={() =>
                    run('delete', 'Delete this account? It is disabled now and permanently removed after 7 days unless recovered.')
                  }
                >
                  Delete account
                </button>
              )}
            </div>
          )}

          {d.actions.length > 0 && (
            <>
              <h3>Admin history</h3>
              <ul className="plain">
                {d.actions.map((a: any, i: number) => (
                  <li key={i} className="sub">
                    {fmt(a.createdAt)} · {ACTION_LABEL[a.action] ?? a.action}
                    {a.adminName ? ` by ${a.adminName}` : ''}
                    {a.reason ? ` · ${a.reason}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Usage (Fady, 10/19): the most-opened pages and most-tapped buttons, from
 * the per-day counts the app sends. Counts only, never who did it.
 */
function Usage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AdminUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .adminUsage(days)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Could not load usage'));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const table = (title: string, rows: Array<{ name: string; hits: number }>, what: string) => {
    const max = Math.max(1, ...rows.map((r) => r.hits));
    return (
      <section className="card">
        <h2>{title}</h2>
        {rows.length === 0 ? (
          <p className="note">Nothing counted yet. Counts start as people use the app.</p>
        ) : (
          <table className="tiers usage-table">
            <thead>
              <tr>
                <th>{what}</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>
                    {r.name}
                    <span className="usage-bar" style={{ width: `${Math.round((r.hits / max) * 100)}%` }} />
                  </td>
                  <td>{r.hits.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  };

  const totals = (data?.daily ?? []).reduce((a, d) => ({ pages: a.pages + d.pages, clicks: a.clicks + d.clicks }), { pages: 0, clicks: 0 });
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Usage</h2>
          <div className="seg" role="tablist" aria-label="Period">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
        </div>
        <p className="note">
          Which pages people open and which buttons and tabs they tap. Only the page or button is counted, never who did
          it or anything they typed. Counts older than 13 months are cleared.
        </p>
        {error && <p className="danger-text">{error}</p>}
        {data && (
          <div className="stat-row">
            <Stat n={totals.pages.toLocaleString()} label="pages opened" />
            <Stat n={totals.clicks.toLocaleString()} label="buttons tapped" />
            <Stat n={data.daily.length} label="days with use" />
          </div>
        )}
      </section>
      {!data && !error && <section className="card">Loading…</section>}
      {data && table('Most visited pages', data.pages, 'Page')}
      {data && table('Most used buttons and features', data.clicks, 'Page · button')}
    </>
  );
}

export default function Admin() {
  const [view, setView] = useState<View>('insights');
  // Data is tagged with the view it belongs to: on the render right after a
  // tab switch the previous view's payload (an object, not a list) is still
  // in state and must not be rendered by the new view.
  const [loaded, setLoaded] = useState<{ view: View; data: any } | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    // Some tabs load their own data.
    if (SELF_LOADING.includes(view)) {
      setLoaded({ view, data: {} });
      return;
    }
    api
      .admin(view as Parameters<typeof api.admin>[0], view === 'users' ? q : undefined)
      .then((d) => !cancelled && setLoaded({ view, data: d }))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [view, q, reloadKey]);

  const data = loaded?.view === view ? loaded.data : null;

  return (
    <>
      <nav className="period-tabs" aria-label="Admin views">
        {VIEWS.map(([id, label]) => (
          <button key={id} type="button" className={view === id ? 'on' : ''} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </nav>

      {error && <section className="card err">{error}</section>}
      {!data && !error && <section className="card">Loading…</section>}

      {data && view === 'insights' && <Insights data={data} />}

      {view === 'usage' && <Usage />}

      {view === 'notify' && <Notify />}

      {view === 'billing' && <Billing />}

      {view === 'integrations' && <Integrations />}

      {/* Test mode for the Android app: only inside the app, only for platform admins. */}
      {isNativeApp() && (
        <section className="card">
          <h2>Android app test mode</h2>
          {onTestSite() ? (
            <>
              <p className="note">This app is showing the test site (lineup-dev).</p>
              <button type="button" className="btn" onClick={switchAppToLiveSite}>
                Back to the live site
              </button>
            </>
          ) : (
            <>
              <p className="note">
                Switch this phone&rsquo;s app to the test site (lineup-dev) to try changes before they go live. You sign in
                there separately, and a banner at the top takes you back. Only this phone changes.
              </p>
              <button type="button" className="btn" onClick={switchAppToTestSite}>
                Use the test site in this app
              </button>
            </>
          )}
        </section>
      )}

      {data && view === 'summary' && (
        <>
          <section className="card">
            <h2>Platform</h2>
            <div className="stat-row">
              {[
                ['users', 'users'],
                ['active30', 'active 30d'],
                ['teams', 'teams'],
                ['games', 'games'],
                ['players', 'players'],
                ['orgs', 'orgs'],
              ].map(([key, label]) => (
                <div className="stat" key={key}>
                  <span className="stat-n">{data.totals?.[key] ?? 0}</span>
                  <span className="stat-l">{label}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="card">
            <h2>Revenue</h2>
            <div className="stat-row">
              <div className="stat">
                <span className="stat-n good">{data.totals?.paid ?? 0}</span>
                <span className="stat-l">paid</span>
              </div>
              <div className="stat">
                <span className="stat-n">{data.totals?.cancelled ?? 0}</span>
                <span className="stat-l">cancelled</span>
              </div>
              <div className="stat">
                <span className="stat-n bad">{data.totals?.pendingdeletions ?? data.totals?.pendingDeletions ?? 0}</span>
                <span className="stat-l">pending deletions</span>
              </div>
            </div>
            <table className="tiers">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Users</th>
                </tr>
              </thead>
              <tbody>
                {(data.byTier ?? []).map((t: any) => (
                  <tr key={t.tier}>
                    <td>{t.tier}</td>
                    <td>{t.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {data && view === 'users' && userId && (
        <UserDetail id={userId} onClose={() => setUserId(null)} onChanged={() => setReloadKey((k) => k + 1)} />
      )}

      {data && view === 'users' && (
        <section className="card">
          <h2>Users</h2>
          <input
            className="search"
            placeholder="Search name, email or user id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <table className="tiers">
            <thead>
              <tr>
                <th>User</th>
                <th>Tier</th>
                <th>Teams</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.map((u: any) => (
                <tr
                  key={u.id}
                  className={`clickable${u.id === userId ? ' current' : ''}`}
                  onClick={() => setUserId(u.id)}
                >
                  <td>
                    {u.displayName ?? '—'}
                    {u.disabledAt && <span className="pill bad small">disabled</span>}
                    {u.deactivatedAt && <span className="pill bad small">deactivated</span>}
                    {u.deletionAt && !u.deactivatedAt && <span className="pill bad small">deleting</span>}
                    <br />
                    <span className="sub">{u.email}</span>
                  </td>
                  <td>
                    {TIER_LABEL[u.tier] ?? u.tier}
                    {u.subscriptionStatus === 'cancelled' && (
                      <span className="sub"> (cancelled)</span>
                    )}
                  </td>
                  <td>{u.teams}</td>
                  <td>{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">Select a user to see their roles and teams, and to sign them out, disable, delete or recover the account.</p>
        </section>
      )}

      {data && view === 'abuse' && (
        <section className="card">
          <h2>Heavy use, last 24 hours</h2>
          <p className="note">
            Accounts over 500 requests or seen from more than 5 distinct addresses.
            Addresses are stored only as salted hashes.
          </p>
          <table className="tiers">
            <thead>
              <tr>
                <th>User</th>
                <th>Requests</th>
                <th>Distinct IPs</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={4}>Nothing unusual.</td>
                </tr>
              )}
              {data.map((u: any) => (
                <tr key={u.id}>
                  <td>{u.email ?? u.displayName}</td>
                  <td>{u.requests}</td>
                  <td className={u.distinctips > 5 ? 'bad' : ''}>{u.distinctips ?? u.distinctIps}</td>
                  <td>{new Date(u.lastAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data && view === 'subscriptions' && (
        <section className="card">
          <h2>Subscriptions</h2>
          <table className="tiers">
            <thead>
              <tr>
                <th>Holder</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Access until</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s: any) => (
                <tr key={s.id}>
                  <td>{s.orgName ?? s.regionName ?? s.email ?? '—'}</td>
                  <td>{s.tier}</td>
                  <td>{s.status}</td>
                  <td>{s.accessUntil ? new Date(s.accessUntil).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data && view === 'deletions' && (
        <section className="card">
          <h2>Deletion requests</h2>
          <table className="tiers">
            <thead>
              <tr>
                <th>User</th>
                <th>Scope</th>
                <th>Requested</th>
                <th>Executes</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.email ?? '—'}</td>
                  <td>{d.scope === 'account' && d.kind === 'deactivate' ? 'account (deactivated)' : d.scope}</td>
                  <td>{new Date(d.requestedAt).toLocaleDateString()}</td>
                  <td>{new Date(d.executeAt).toLocaleDateString()}</td>
                  <td>
                    {d.executedAt ? 'done' : d.cancelledAt ? 'cancelled' : 'pending'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data && view === 'support' && (
        <section className="card">
          <h2>Support requests</h2>
          {data.length === 0 && <p className="note">No support requests.</p>}
          <ul className="tickets">
            {data.map((r: any) => (
              <AdminTicket key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

const STATUSES: SupportRequest['status'][] = ['open', 'in_progress', 'resolved', 'dismissed'];

function AdminTicket({ r }: { r: any }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<SupportComment[]>(r.comments ?? []);
  const [status, setStatus] = useState<SupportRequest['status']>(r.status);
  const [scoutEligible, setScoutEligible] = useState<boolean>(Boolean(r.scoutEligible));
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viaEmail = r.source === 'email';

  async function send(nextStatus?: SupportRequest['status'], nextScout?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.adminSupport({
        requestId: r.id,
        body: nextScout === undefined ? reply.trim() || undefined : undefined,
        status: nextStatus,
        scoutEligible: nextScout,
      });
      setComments(res.comments);
      if (res.status) setStatus(res.status);
      if (typeof res.scoutEligible === 'boolean') setScoutEligible(res.scoutEligible);
      if (nextScout === undefined) setReply('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`ticket ${open ? 'open' : ''}`}>
      <button type="button" className="ticket-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ticket-subject">{r.subject}</span>
        <span className={`status-pill s-${status}`}>{status.replace('_', ' ')}</span>
        <span className="sub">
          {viaEmail ? '✉️ ' : ''}
          {r.displayName ?? r.email ?? '—'}
          {viaEmail && r.email && r.displayName !== r.email ? ` <${r.email}>` : ''} · {new Date(r.createdAt).toLocaleString()} ·{' '}
          {scoutEligible ? 'Scout eligible' : 'manual'}
          {comments.length > 0 && ` · ${comments.length} comments`}
        </span>
      </button>
      {open && (
        <div className="ticket-body">
          <SupportThread
            request={r}
            comments={comments}
            requesterLabel={r.displayName ?? r.email ?? 'Requester'}
          />
          {r.scoutNote && (
            <p className="note">
              <strong>Scout note:</strong> {r.scoutNote}
            </p>
          )}
          {viaEmail && (
            <p className="note">
              Came in by email to support@mahoul.io. Replies go back to {r.email} by email.
            </p>
          )}
          <label>
            Reply to requester
            <textarea rows={3} maxLength={4000} value={reply} onChange={(e) => setReply(e.target.value)} />
          </label>
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={busy || !reply.trim()} onClick={() => send()}>
              Send reply
            </button>
            <select
              aria-label="Status"
              value={status}
              disabled={busy}
              onChange={(e) => send(e.target.value as SupportRequest['status'])}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
            <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => send(undefined, !scoutEligible)}>
              {scoutEligible ? 'Take away from Scout' : 'Let Scout work on this'}
            </button>
          </div>
          {error && <p className="danger-text">{error}</p>}
        </div>
      )}
    </li>
  );
}
