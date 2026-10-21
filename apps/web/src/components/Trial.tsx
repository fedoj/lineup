import { useEffect, useState } from 'react';
import { TRIAL_DAYS, isTrialTier, type TrialInfo, type TrialStatus, type TrialTier } from '@lineup/shared';
import { api } from '../lib/api';
import { PENDING_TRIAL_KEY } from './PlanPicker';

const TIER_LABEL: Record<TrialTier, string> = {
  organization: 'Organization',
  region: 'Region',
  coach: 'Coach',
};

const DESCRIBE: Record<TrialTier, string> = {
  organization:
    'You become the organization’s director. Add regions and teams, invite admins to help run it, and use every paid feature for 30 days. If it ends without a subscription, the organization is paused for everyone and kept for 30 days in case you subscribe.',
  region:
    'A region of your own, with no organization above it. You become its director: add up to 20 teams, invite admins, coaches and families, and use every paid feature for 30 days. If it ends without a subscription, the region is paused for everyone and kept for 30 days in case you subscribe.',
  coach:
    'Every Coach feature for 7 days: the match day clock, all stats, sharing lineups and stats as pictures, flyers and more. Afterwards your account goes back to the free plan.',
};

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One line describing a trial the person has had. */
export function TrialLine({ t }: { t: TrialInfo }) {
  const what = `${TIER_LABEL[t.tier]} trial${t.name ? ` for ${t.name}` : ''}`;
  if (t.state === 'active') {
    return (
      <p className="note">
        <strong>{what}:</strong> {t.daysLeft} {t.daysLeft === 1 ? 'day' : 'days'} left (ends {day(t.endsAt)}).
      </p>
    );
  }
  if (t.state === 'converted') return <p className="note">Your {what} became a subscription.</p>;
  if (t.state === 'deleted') {
    return <p className="note">Your {what} ended on {day(t.endsAt)} and its data has been deleted.</p>;
  }
  return (
    <p className="note warn">
      Your {what} ended on {day(t.endsAt)}.
      {t.keepUntil && ` It is paused for everyone. Subscribe by ${day(t.keepUntil)} to bring it back as it was; after that it is deleted.`}
    </p>
  );
}

/** "Days left" note on an organization or region that is on a trial. */
export function TrialBadge({ endsAt }: { endsAt: string }) {
  const left = Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000));
  return (
    <p className="note">
      Free trial: {left} {left === 1 ? 'day' : 'days'} left (ends {day(endsAt)}). Subscribe before then to keep it running.
    </p>
  );
}

/** Start a free trial, and see the trials already had. Lives on Account. */
export function TrialCard({
  status,
  paywall,
  onStarted,
  embedded = false,
  requested = null,
}: {
  status: TrialStatus | null | undefined;
  /** Inside the Your plan card (Fady, 10/20) rather than a card of its own. */
  embedded?: boolean;
  /** A plan's "Start free trial" button picked this trial; 
 repeats a pick. */
  requested?: { tier: TrialTier; n: number } | null;
  /** With the paywall off everyone already has every Coach feature. */
  paywall: boolean;
  onStarted: (tier: TrialTier, scope: { orgId: string | null; regionId: string | null }) => void;
}) {
  // A trial picked on the home page before signing in is preselected.
  const [tier, setTier] = useState<TrialTier | null>(() => {
    try {
      const v = localStorage.getItem(PENDING_TRIAL_KEY);
      return isTrialTier(v) ? v : null;
    } catch {
      return null;
    }
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (requested) setTier(requested.tier);
  }, [requested]);

  useEffect(() => {
    try {
      localStorage.removeItem(PENDING_TRIAL_KEY);
    } catch {
      /* nothing to clear */
    }
  }, []);

  if (!status) return null;
  const offered = (['organization', 'region', 'coach'] as const).filter(
    (t) => status.canStart[t] && (t !== 'coach' || paywall),
  );
  if (offered.length === 0 && !status.scope && !status.coach) return null;
  const picked = tier && (offered as readonly TrialTier[]).includes(tier) ? tier : null;

  async function start() {
    if (!picked) return;
    const tier = picked;
    setBusy(true);
    setError(null);
    try {
      const r = await api.startTrial(tier, tier === 'coach' ? undefined : name.trim());
      setDone(
        tier === 'coach'
          ? 'Your 7-day Coach trial has started.'
          : `Your 30-day trial has started. ${name.trim()} is in your menu now, with you as its director.`,
      );
      setTier(null);
      setName('');
      onStarted(tier, { orgId: r.orgId, regionId: r.regionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the trial');
    } finally {
      setBusy(false);
    }
  }

  const Wrap = embedded ? 'div' : 'section';
  return (
    <Wrap className={embedded ? 'trial-in-plan' : 'card'} id="trial">
      {embedded ? <h3 className="group-title">Free trial</h3> : <h2>Free trial</h2>}
      {done && <p role="status">{done}</p>}
      {status.scope && <TrialLine t={status.scope} />}
      {status.coach && <TrialLine t={status.coach} />}
      {offered.length > 0 && (
        <>
          <p className="note">Try a paid plan free. No card needed, and one trial of each kind per person.</p>
          <div className="row">
            {offered.map((t) => (
              <button
                key={t}
                type="button"
                className={picked === t ? 'btn' : 'btn ghost'}
                aria-pressed={picked === t}
                onClick={() => {
                  setTier(t);
                  setError(null);
                }}
              >
                {TIER_LABEL[t]} · {TRIAL_DAYS[t]} days free
              </button>
            ))}
          </div>
          {picked && (
            <div style={{ marginTop: 12 }}>
              <p className="note">{DESCRIBE[picked]}</p>
              <div className="row">
                {picked !== 'coach' && (
                  <input
                    style={{ flex: '1 1 220px' }}
                    placeholder={picked === 'organization' ? 'Organization name, e.g. AYSO Area 10' : 'Region name, e.g. Cypress Youth Soccer'}
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label={`${TIER_LABEL[picked]} name`}
                  />
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy || (picked !== 'coach' && !name.trim())}
                  onClick={() => void start()}
                >
                  {busy ? 'Starting…' : `Start my free ${TIER_LABEL[picked]} trial`}
                </button>
              </div>
            </div>
          )}
          {error && <p className="note warn">{error}</p>}
        </>
      )}
      {offered.length === 0 && status.blockedReason && <p className="note">{status.blockedReason}</p>}
    </Wrap>
  );
}

/** The trial a plan's "Start free trial" button starts, when there is one. */
export function trialFor(status: TrialStatus | null | undefined, paywall: boolean, tier: string): TrialTier | null {
  if (!status || !isTrialTier(tier)) return null;
  if (!status.canStart[tier] || (tier === 'coach' && !paywall)) return null;
  return tier;
}

/**
 * Shown to the director instead of the app once their organization or region
 * trial has ended unpaid: subscribe to bring it back, or carry on as a free
 * coach and start fresh.
 */
export function TrialEnded({
  trial,
  onSwitched,
  onSupport,
}: {
  trial: TrialInfo;
  onSwitched: () => void;
  onSupport: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [subscribe, setSubscribe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = trial.tier === 'organization' ? 'organization' : 'region';

  async function switchToCoach() {
    setBusy(true);
    setError(null);
    try {
      await api.dismissTrial();
      onSwitched();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <section className="card">
        <h2>Your free trial has ended</h2>
        <p>
          The 30-day trial for <strong>{trial.name ?? `your ${kind}`}</strong> ended on {day(trial.endsAt)}. The {kind}{' '}
          is paused: you, your admins and everyone you invited can’t see it now.
        </p>
        {trial.keepUntil && (
          <p>
            Subscribe by {day(trial.keepUntil)} and it comes back exactly as it was. After that it is deleted.
          </p>
        )}
        <div className="row">
          <button type="button" className="btn" onClick={() => setSubscribe(true)}>
            Subscribe
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void switchToCoach()}>
            Switch to a free coach account
          </button>
        </div>
        {subscribe && (
          <p className="note">
            Online checkout is coming soon. To subscribe now, send us a note in{' '}
            <button type="button" className="linkish" onClick={onSupport}>
              Help &amp; support
            </button>{' '}
            and we will set it up.
          </p>
        )}
        <p className="note">
          A free coach account runs up to 2 teams with 12 games each per season. You start fresh: create your team, then
          invite your staff and parents. You can still subscribe to bring the {kind} back until{' '}
          {trial.keepUntil ? day(trial.keepUntil) : 'it is deleted'}, from Account.
        </p>
        {error && <p className="note warn">{error}</p>}
        <p className="note">
          <a href="/.auth/logout">Sign out</a>
        </p>
      </section>
    </main>
  );
}
