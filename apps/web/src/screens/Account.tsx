import { useEffect, useRef, useState } from 'react';
import { formatPlanPrice, TIER_ORDER, type Feature, type TierId } from '@lineup/shared';
import { api, type MeResponse } from '../lib/api';
import Impersonation from '../components/Impersonation';
import { FamilyCard, JoinRegion } from '../components/RegionJoin';
import { TrialCard, trialFor } from '../components/Trial';
import type { TrialTier } from '@lineup/shared';
import TwoStepCard from '../components/TwoStep';
import InstallCard from '../components/InstallCard';
import { ADS_ENABLED } from '../lib/ads';
import { PLAN_HIGHLIGHTS, type PlanFor } from '../lib/planFor';
import { buysOnWebsite, FROM_APP_KEY, openWebsite, storeName, websiteHost } from '../lib/purchases';
import { revealInFold } from '../lib/foldCards';

/** Cheapest to most complete, matching the plan catalog. */
const PLAN_COLUMNS = TIER_ORDER;

/** Rows of the comparison table, in the order a coach or parent cares about. */
const PLAN_FEATURES: Array<[Feature, string]> = [
  ['matchClock', 'Match day clock'],
  ['fullStats', 'All stats (free tracks goals, assists and cards)'],
  ['customStats', 'Your own custom stats'],
  ['longShareLinks', 'Share lineups, stats and calendars (pictures and calendar files)'],
  ['scopeStandings', 'Organization and region standings'],
  ['chatAttachments', 'Photos in team chat'],
  ['extendedPractice', 'Practice seasons over 100 days'],
  ['manualAttendance', 'Manual practice attendance (team parents and coaches)'],
  ['ownPlayerStats', "Your child's own stats"],
  ['eventFlyers', 'Flyers on team events (team parents and coaches)'],
  ['playerEvaluation', "Your child's player card and designing their avatar (coaches rate players on every plan)"],
  ['chatEditing', 'Edit (10 minutes) and delete your team chat messages'],
  ['chatPolls', 'Create polls in team chat (anyone in the chat can vote)'],
  ['refereeClock', 'Referee game clock (refereeing is free)'],
  ['orgs', 'Organizations and regions, top-down view'],
  ...(ADS_ENABLED ? ([['adFree', 'No ads']] as Array<[Feature, string]>) : []),
];

interface Props {
  me: MeResponse;
  teamId: string | null;
  /** Every role held is team parent or below, so team and game limits do not apply. */
  familyOnly?: boolean;
  /** The paid plan that fits this person best, with why. */
  recommended?: PlanFor;
  onRefresh: () => void;
  /** An organization or region trial was started; open it. */
  onTrialStarted?: (scope: { orgId: string | null; regionId: string | null }) => void;
  /** A parent is starting to coach a team of their own: open the new team form. */
  onStartCoaching?: () => void;
}

/** Family plans join teams by invite, so team and game limits mean nothing to them. */
const FAMILY_TIERS = new Set(['parent']);

const FEATURE_LABEL = new Map(PLAN_FEATURES);

interface PlanRow {
  key: string;
  label: string;
  highlight: boolean;
  cell: (id: TierId) => string | number;
  aria?: (id: TierId) => string;
}

/** Plan, subscription controls and data rights. */
export default function Account({
  me,
  teamId,
  familyOnly = false,
  recommended,
  onRefresh,
  onTrialStarted,
  onStartCoaching,
}: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<null | 'deactivate' | 'delete'>(null);
  const [closing, setClosing] = useState(false);
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const planWindow = useRef<HTMLDivElement>(null);
  const billing = me.billing;
  const canBuy = Boolean(billing?.checkout) && !billing?.stripePlan;
  // Inside the store apps plans are bought on the website (lib/purchases.ts).
  const webOnly = buysOnWebsite();
  const [fromApp] = useState(() => {
    if (webOnly) return false;
    if (new URLSearchParams(location.search).get('from') === 'app') sessionStorage.setItem(FROM_APP_KEY, '1');
    return sessionStorage.getItem(FROM_APP_KEY) === '1';
  });

  // Back in the app after paying on the website: pick up the new plan.
  useEffect(() => {
    if (!webOnly) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') onRefresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [webOnly, onRefresh]);

  // Back from Stripe's payment page: the plan starts once Stripe confirms the
  // payment, usually within seconds, so check a few times.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const result = q.get('checkout');
    if (!result) return;
    history.replaceState(null, '', `/account${location.hash}`);
    if (result === 'cancel') {
      setMsg('Checkout was cancelled. Nothing was charged.');
      return;
    }
    setMsg(
      fromApp
        ? 'Thanks! Your payment went through. Your plan turns on in a moment; you can go back to the Lineup app now.'
        : 'Thanks! Your payment went through. Your plan turns on in a moment.',
    );
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      onRefresh();
      if (tries >= 5) window.clearInterval(t);
    }, 3000);
    return () => window.clearInterval(t);
    // Runs once, when Account opens after checkout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function subscribe(tier: TierId) {
    setBillingBusy(tier);
    setBillingError(null);
    try {
      const r = await api.checkout(tier);
      location.href = r.url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : 'Could not open checkout.');
      setBillingBusy(null);
    }
  }

  async function manageBilling() {
    setBillingBusy('portal');
    setBillingError(null);
    try {
      const r = await api.billingPortal();
      location.href = r.url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : 'Could not open billing.');
      setBillingBusy(null);
    }
  }

  // The plan that fits best, unless it's the one they have (or a free one).
  const reco: TierId | null =
    recommended && recommended.tier !== me.tier && me.plan.tiers[recommended.tier]?.priceCents > 0 ? recommended.tier : null;
  // Tapping another plan in the table shows its details on top, in turquoise
  // so it is not mistaken for the suggestion (Fady, 10/19).
  const [picked, setPicked] = useState<TierId | null>(null);
  const shownPlan: TierId | null = picked ?? reco;
  const isPick = picked !== null && picked !== reco;
  const planCard = useRef<HTMLDivElement>(null);
  const pickPlan = (id: TierId) => {
    setPicked(id === reco ? null : id);
    window.setTimeout(() => planCard.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  };

  // On a narrow screen, slide the comparison so the suggested plan is in view
  // just right of the pinned feature names.
  useEffect(() => {
    const win = planWindow.current;
    const col = win?.querySelector<HTMLElement>('th.recommended');
    const label = win?.querySelector<HTMLElement>('th:first-child');
    if (!win || !col || !label) return;
    const w = win.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    if (c.right > w.right) {
      win.scrollLeft += c.left - (w.left + label.getBoundingClientRect().width) - 12;
    }
  }, [reco]);
  const highlights = reco ? (PLAN_HIGHLIGHTS[reco] ?? []).filter((f) => me.plan.tiers[reco].features.includes(f)) : [];
  // Up to five features the shown plan is mostly bought for, else its first five.
  const shownFeatures = shownPlan
    ? [
        ...(PLAN_HIGHLIGHTS[shownPlan] ?? []).filter((f) => me.plan.tiers[shownPlan].features.includes(f)),
        ...PLAN_FEATURES.map(([f]) => f).filter((f) => me.plan.tiers[shownPlan].features.includes(f)),
      ].filter((f, i, all) => all.indexOf(f) === i)
    : [];
  const recoHighlights = shownFeatures
    .map((f) => [f, FEATURE_LABEL.get(f)] as const)
    .filter((x): x is readonly [Feature, string] => Boolean(x[1]))
    .slice(0, 5);

  // Rows: what the suggested plan is mostly bought for first, then team and
  // game limits, then the rest of the features.
  const featureRow = (feature: Feature, label: string, highlight: boolean): PlanRow => ({
    key: feature,
    label,
    highlight,
    cell: (id) => (me.plan.tiers[id].features.includes(feature) ? '✓' : '–'),
    aria: (id) => (me.plan.tiers[id].features.includes(feature) ? 'Included' : 'Not included'),
  });
  const limitRows: PlanRow[] = [
    {
      key: 'teams',
      label: 'Teams you create',
      highlight: reco === 'coach',
      cell: (id) => (FAMILY_TIERS.has(id) ? 'Join by invite' : me.plan.tiers[id].limits.teams),
    },
    {
      key: 'games',
      label: 'Games per team each season (Aug to Jul)',
      highlight: reco === 'coach',
      cell: (id) => (FAMILY_TIERS.has(id) ? '–' : me.plan.tiers[id].limits.gamesPerTeam),
    },
    {
      key: 'regions',
      label: 'Regions',
      highlight: reco === 'region' || reco === 'organization' || reco === 'organizationPlus',
      cell: (id) => me.plan.tiers[id].limits.regions || '–',
    },
  ];
  const rows: PlanRow[] = [
    ...highlights.filter((f) => FEATURE_LABEL.has(f)).map((f) => featureRow(f, FEATURE_LABEL.get(f)!, true)),
    ...limitRows,
    ...PLAN_FEATURES.filter(([f]) => !highlights.includes(f)).map(([f, label]) => featureRow(f, label, false)),
  ];

  // A plan's "Start free trial" picks that trial in the Free trial part above (Fady, 10/20).
  const [trialPick, setTrialPick] = useState<{ tier: TrialTier; n: number } | null>(null);
  function trialButton(id: TierId, big: boolean) {
    const t = familyOnly ? null : trialFor(me.trial, me.paywallEnabled, id);
    if (!t) return null;
    return (
      <button
        type="button"
        className={big ? 'btn ghost' : 'btn ghost small'}
        onClick={() => {
          setTrialPick((p) => ({ tier: t, n: (p?.n ?? 0) + 1 }));
          window.setTimeout(() => document.getElementById('trial')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
        }}
      >
        {big ? 'Start free trial' : 'Free trial'}
      </button>
    );
  }

  function subscribeButton(id: TierId, big: boolean) {
    if (me.plan.tiers[id].priceCents <= 0) return null;
    if (webOnly) {
      return (
        <button
          type="button"
          className={big ? 'btn' : 'btn small'}
          disabled={!billing?.checkout || Boolean(billing?.stripePlan)}
          title={
            billing?.stripePlan
              ? 'You already have a plan. Change it on the website.'
              : `Subscribe to ${me.plan.tiers[id].name} on ${websiteHost()}`
          }
          onClick={() => void openWebsite('/account?from=app&to=plans')}
        >
          {big ? `Subscribe on ${websiteHost()} ↗` : 'On website ↗'}
        </button>
      );
    }
    return (
      <button
        type="button"
        className={big ? 'btn' : 'btn small'}
        disabled={!canBuy || billingBusy !== null}
        title={
          !billing?.checkout
            ? 'Online checkout is coming soon'
            : billing.stripePlan
              ? 'You already have a plan. Use Manage billing to change or cancel it.'
              : `Subscribe to ${me.plan.tiers[id].name}`
        }
        onClick={() => void subscribe(id)}
      >
        {billingBusy === id ? 'Opening…' : big ? `Subscribe to ${me.plan.tiers[id].name}` : 'Subscribe'}
      </button>
    );
  }

  // "See plans" links land here; the section renders after the page loads,
  // so the browser's own anchor jump has nothing to scroll to yet.
  useEffect(() => {
    const to = (id: string) => {
      const card = document.getElementById(id);
      revealInFold(card);
      card?.scrollIntoView({ behavior: 'smooth' });
    };
    if (location.hash === '#plans' || location.hash === '#trial') {
      to(location.hash.slice(1));
    } else if (new URLSearchParams(location.search).get('to') === 'plans') {
      // From the app's Subscribe button (the hash does not survive sign-in).
      to('plans');
    }
  }, []);

  async function resume() {
    await api.resumeSubscription();
    setMsg('Subscription resumed.');
    onRefresh();
  }

  async function deleteAccount() {
    const r = await api.deleteThing('account');
    setMsg(
      r.executeAt
        ? `Account scheduled for permanent deletion on ${new Date(r.executeAt).toLocaleDateString()}. Sign in before then and tap "Cancel pending deletion" to keep it.`
        : 'Deletion requested.',
    );
    setConfirmDelete(null);
  }

  /** Deactivate (Fady, 10/17): kept for a year, reactivate by signing in. */
  async function deactivateAccount() {
    setClosing(true);
    try {
      await api.deactivateAccount();
      // The app now shows the "Your account is deactivated" screen.
      location.reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not deactivate the account');
      setClosing(false);
    }
  }

  async function undelete() {
    await api.undelete();
    setMsg('Account deletion cancelled.');
  }

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}

      <Impersonation onChanged={onRefresh} />

      <JoinRegion />

      <FamilyCard />

      {familyOnly && onStartCoaching && (
        <section className="card" id="start-coaching">
          <h2>Coaching a team of your own?</h2>
          <p className="note">
            Parents who start coaching can set up their own team: a roster, lineups, a calendar and a chat,
            all separate from your child's league team. The Coach plan covers it, with a free trial when one is
            available.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={onStartCoaching}>
              I'm starting to coach my own team
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setPicked('coach');
                const el = document.getElementById('plans');
                revealInFold(el);
                el?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              See the Coach plan
            </button>
          </div>
        </section>
      )}

      {/* Your plan, free trial and plans in one card (Fady, 10/20). */}
      <section className="card" id="your-plan">
        <h2>Your plan</h2>
        <dl className="kv">
          <dt>Signed in</dt>
          <dd>{me.user.email ?? me.user.provider}</dd>
          <dt>Tier</dt>
          <dd>{me.plan.tiers[me.tier].name}</dd>
          {!familyOnly && (
            <>
              <dt>Teams</dt>
              <dd>
                {me.usage.teams ?? 0}
                {me.paywallEnabled ? ` / ${me.limits.teams}` : ' (unlimited)'}
              </dd>
              <dt>Games per team each season</dt>
              <dd>{me.paywallEnabled ? me.limits.gamesPerTeam : 'unlimited'}</dd>
            </>
          )}
        </dl>

        {/* Cancelling happens in Stripe (Manage billing). Once cancelled, the
            plan runs to the end of the period and Resume takes its place.
            In the store apps both open the website (lib/purchases.ts). */}
        {me.subscription?.status === 'cancelled' && me.subscription.accessUntil ? (
          <>
            <p className="note">
              Cancelled. Your plan stays active until{' '}
              {new Date(me.subscription.accessUntil).toLocaleDateString()}. Nothing has
              been deleted.
            </p>
            <button
              type="button"
              className="btn btn-good"
              onClick={webOnly ? () => void openWebsite('/account?from=app') : resume}
            >
              {webOnly ? `Resume subscription on ${websiteHost()} ↗` : 'Resume subscription'}
            </button>
          </>
        ) : (
          billing?.portal &&
          (webOnly ? (
            <>
              <button type="button" className="btn ghost" onClick={() => void openWebsite('/account?from=app')}>
                Manage billing on {websiteHost()} ↗
              </button>
              <p className="note">Billing is handled on our website: change your card, see invoices or cancel there.</p>
            </>
          ) : (
            <>
              <button type="button" className="btn ghost" disabled={billingBusy !== null} onClick={() => void manageBilling()}>
                {billingBusy === 'portal' ? 'Opening…' : 'Manage billing'}
              </button>
              <p className="note">Manage billing opens Stripe, where you can change your card, see invoices or cancel.</p>
            </>
          ))
        )}

        {me.subscription && me.subscription.scope === 'personal' && me.tier !== 'free' && (
          <p className="note">
            Refunds are requested from <a href="/support">Help &amp; support</a> once the subscription is cancelled.
          </p>
        )}

        {!me.paywallEnabled && (
          <p className="note">Everything is free while we are in early access.</p>
        )}

        {!familyOnly && (
          <TrialCard
            embedded
            requested={trialPick}
            status={me.trial}
            paywall={me.paywallEnabled}
            onStarted={(tier, scope) => {
              if (tier !== 'coach' && onTrialStarted) onTrialStarted(scope);
              else onRefresh();
            }}
          />
        )}

        <div id="plans">
        <h3 className="group-title">Plans</h3>
        {webOnly && billing?.checkout && (
          <p className="note">
            Plans aren’t sold through {storeName()}. Subscribe on our website, {websiteHost()}: sign in there with this
            same account, and your plan shows here as soon as you come back.
          </p>
        )}
        {fromApp && !me.subscription && (
          <p className="note">
            You came from the Lineup app. Subscribe here, then go back to the app: your plan will be there.
          </p>
        )}
        {billing?.mode === 'test' && (
          <p className="note warn">
            Test mode: payments go to Stripe's sandbox and no real money moves. Pay with the test card 4242 4242 4242 4242,
            any future date, any 3-digit code and any ZIP.
          </p>
        )}
        {billingError && <p className="danger-text">{billingError}</p>}

        {shownPlan && (
          <div className={`plan-reco${isPick ? ' picked' : ''}`} ref={planCard} aria-live="polite">
            <div className="plan-reco-head">
              <span className="plan-reco-tag">{isPick ? 'You picked' : 'Best for you'}</span>
              <strong className="plan-reco-name">{me.plan.tiers[shownPlan].name}</strong>
              <span className="plan-price">{formatPlanPrice(me.plan, me.plan.tiers[shownPlan].priceCents)}</span>
            </div>
            <p className="sub">
              {isPick ? '' : `${recommended?.reason ?? ''} `}
              {me.plan.tiers[shownPlan].blurb}
            </p>
            {recoHighlights.length > 0 && (
              <ul className="plan-reco-list">
                {recoHighlights.map(([f, label]) => (
                  <li key={f}>✓ {label}</li>
                ))}
              </ul>
            )}
            <div className="row">
              {shownPlan === me.tier ? <span className="sub">Your current plan</span> : subscribeButton(shownPlan, true)}
              {shownPlan !== me.tier && trialButton(shownPlan, true)}
              {isPick && (
                <button type="button" className="btn ghost btn-sm" onClick={() => setPicked(null)}>
                  {reco ? `‹ Back to ${me.plan.tiers[reco].name}, best for you` : 'Close'}
                </button>
              )}
            </div>
          </div>
        )}

        <h3 className="group-title">Compare every plan</h3>
        <p className="sub plan-window-hint">
          Tap a plan’s name to see it on top. Scroll inside the table to see every feature
          {reco ? `; ${me.plan.tiers[reco].name} is highlighted` : ''}.
        </p>
        <div className="table-scroll plan-window" role="region" aria-label="Plan comparison" tabIndex={0} ref={planWindow}>
          <table className="tiers plan-compare">
            <thead>
              <tr>
                <th />
                {PLAN_COLUMNS.map((id) => (
                  <th
                    key={id}
                    className={
                      [id === me.tier ? 'current' : '', id === reco ? 'recommended' : '', isPick && id === picked ? 'picked' : '']
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                  >
                    {id === reco && <span className="plan-reco-tag small">Best for you</span>}
                    {isPick && id === picked && <span className="plan-reco-tag small">You picked</span>}
                    <button
                      type="button"
                      className="plan-pick"
                      aria-pressed={id === shownPlan}
                      title={`See ${me.plan.tiers[id].name} on top`}
                      onClick={() => pickPlan(id)}
                    >
                      {me.plan.tiers[id].name}
                    </button>
                    <br />
                    <span className="sub">{formatPlanPrice(me.plan, me.plan.tiers[id].priceCents)}</span>
                    <div className="plan-head-action">
                      {id === me.tier ? <span className="sub">Current</span> : subscribeButton(id, false)}
                      {id !== me.tier && trialButton(id, false)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={row.highlight ? 'highlight' : undefined}>
                  <td>{row.label}</td>
                  {PLAN_COLUMNS.map((id) => (
                    <td
                      key={id}
                      className={id === reco ? 'recommended' : isPick && id === picked ? 'picked' : undefined}
                      aria-label={row.aria?.(id)}
                      onClick={() => pickPlan(id)}
                    >
                      {row.cell(id)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          Coach is for coaches and assistant coaches. Parent is for every parent, team parents included.
          Region is for a region on its own; Organization (20 regions) and Organization Plus (40
          regions) cover organization and region admins and directors. Paid features belong to
          the person who subscribes; joining a paid organization does not unlock them for coaches or
          parents. Paid plans are billed {me.plan.interval === 'year' ? 'yearly' : 'monthly'}, and
          cancelling keeps your plan until the end of the current term.{' '}
          {billing?.checkout
            ? webOnly
              ? `Subscribing happens on ${websiteHost()} with Stripe’s secure payment page, where you can also enter a discount code.`
              : 'Subscribe opens Stripe’s secure payment page, where you can also enter a discount code.'
            : 'Online checkout is coming soon.'}{' '}
          See <a href="/help/roles" target="_blank" rel="noopener noreferrer">Who does what</a>.
        </p>
        </div>
      </section>

      <InstallCard />

      <TwoStepCard />

      <section className="card">
        <h2>Your data</h2>
        <p className="note">
          Download a copy of a team, or close your account. Deactivating keeps everything for a
          year so you can come back.
        </p>
        <div className="row">
          {teamId && (
            <a className="btn ghost" href={api.exportUrl(teamId)} download>
              Export this team
            </a>
          )}
          <button type="button" className="btn ghost" onClick={undelete}>
            Cancel pending deletion
          </button>
        </div>

        {confirmDelete === 'deactivate' ? (
          <div className="danger">
            <p>
              <strong>Deactivate your account?</strong>
            </p>
            <p>
              You won’t be able to use Lineup until you reactivate. We keep everything (your teams,
              players, games and stats) for <strong>1 year</strong>. Sign in any time during that
              year and tap <strong>Reactivate my account</strong> to pick up where you left off. After
              a year, your account, the teams you own and their player records are deleted for good.
              A paid plan stops renewing.
            </p>
            <div className="row">
              <button type="button" className="btn danger" disabled={closing} onClick={() => void deactivateAccount()}>
                {closing ? 'Deactivating…' : 'Yes, deactivate my account'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(null)}>
                Keep it
              </button>
            </div>
            <p className="note">
              Want it all gone sooner?{' '}
              <button type="button" className="linkish" onClick={() => setConfirmDelete('delete')}>
                Delete permanently instead
              </button>
            </p>
          </div>
        ) : confirmDelete === 'delete' ? (
          <div className="danger">
            <p>
              This permanently removes your account, your teams and every player record on them.
              You have 7 days to change your mind.
            </p>
            <div className="row">
              <button type="button" className="btn danger" onClick={deleteAccount}>
                Yes, delete permanently
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirmDelete(null)}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn ghost danger-text"
            onClick={() => setConfirmDelete('deactivate')}
          >
            Deactivate my account
          </button>
        )}
      </section>
    </>
  );
}
