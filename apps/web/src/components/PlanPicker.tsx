import { useState } from 'react';
import { LINEUP_PLAN, TRIAL_DAYS, formatPlanPrice, type TierId, type TrialTier } from '@lineup/shared';
import { PLAN_FOR_KEY } from '../lib/planFor';

/** A trial picked before signing in, started on Account once signed in. */
export const PENDING_TRIAL_KEY = 'lineup.pendingTrial';

type Answer = 'organization' | 'region' | 'coach';

const QUESTIONS: Array<{ id: Answer; icon: string; title: string; body: string }> = [
  {
    id: 'organization',
    icon: '🏟️',
    title: 'An organization',
    body: 'You run several regions, each with several teams or clubs.',
  },
  {
    id: 'region',
    icon: '📍',
    title: 'A region',
    body: 'You run several teams or clubs in one region, with no organization above you.',
  },
  {
    id: 'coach',
    icon: '📋',
    title: 'A coach',
    body: 'You run your own team or teams with your staff and parents: lineups, stats and more.',
  },
];

/** The plans each answer is shown, best fit first. */
const SUGGEST: Record<Answer, TierId[]> = {
  organization: ['organization', 'organizationPlus'],
  region: ['region'],
  coach: ['free', 'coach'],
};

/** The trial each plan offers, if any. */
const TRIAL_FOR: Partial<Record<TierId, TrialTier>> = {
  organization: 'organization',
  organizationPlus: 'organization',
  region: 'region',
  coach: 'coach',
};

/** Every plan in the public list, in price order. */
const ALL_PLANS: TierId[] = ['free', 'parent', 'referee', 'coach', 'region', 'organization', 'organizationPlus'];

/**
 * "Choose the plan that's right for you": one question with three answers,
 * then the matching plans with prices and a free trial. Shown on the home
 * page before signing in. Picking a trial remembers it through sign-up, and
 * Account starts it with one tap.
 */
export default function PlanPicker({
  signUpUrl = '/',
  signInUrl = '/',
  onChoose,
}: {
  signUpUrl?: string;
  signInUrl?: string;
  /**
   * Signed in (right after creating an account): a pick is handled in the
   * app, a trial to start or null for the free plan, instead of signing up.
   */
  onChoose?: (trial: TrialTier | null) => void;
}) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [showAll, setShowAll] = useState(false);
  const signedIn = Boolean(onChoose);

  function remember(trial: TrialTier | null) {
    try {
      // "free" sends a new account straight to setting up a team.
      localStorage.setItem(PENDING_TRIAL_KEY, trial ?? 'free');
    } catch {
      /* private mode: the trial can still be started from Account */
    }
  }

  /** A plan button: signs up (and remembers the pick), or picks in the app. */
  function pick(trial: TrialTier | null, label: string) {
    return signedIn ? (
      <button type="button" className="btn" onClick={() => onChoose!(trial)}>
        {label}
      </button>
    ) : (
      <a className="btn" href={signUpUrl} onClick={() => remember(trial)}>
        {label}
      </a>
    );
  }

  return (
    <section className={`${signedIn ? 'card' : 'auth-card'} plan-picker`} aria-labelledby="plan-picker-title">
      <span className="eyebrow">{signedIn ? 'Welcome to Lineup' : 'Plans'}</span>
      <h2 id="plan-picker-title" className="plan-picker-title">
        Choose the plan that’s right for you
      </h2>
      <p className="auth-lede">Which of these sounds like you?</p>

      <div className="picker-options" role="radiogroup" aria-label="Which of these sounds like you?">
        {QUESTIONS.map((q) => (
          <button
            key={q.id}
            type="button"
            role="radio"
            aria-checked={answer === q.id}
            className={`picker-option${answer === q.id ? ' on' : ''}`}
            onClick={() => {
              setAnswer(q.id);
              try {
                // Account uses it to suggest the right paid plan later.
                localStorage.setItem(PLAN_FOR_KEY, q.id);
              } catch {
                /* private mode */
              }
            }}
          >
            <span className="feature-icon" aria-hidden="true">
              {q.icon}
            </span>
            <span>
              <strong>{q.title}</strong>
              <span className="picker-body">{q.body}</span>
            </span>
          </button>
        ))}
      </div>

      {answer && (
        <div className="plan-cards" aria-live="polite">
          {SUGGEST[answer].map((id) => {
            const tier = LINEUP_PLAN.tiers[id];
            const trial = TRIAL_FOR[id];
            return (
              <article key={id} className="plan-card">
                <header>
                  <strong>{tier.name}</strong>
                  <span className="plan-price">
                    {tier.priceCents === 0 ? '$0' : formatPlanPrice(LINEUP_PLAN, tier.priceCents)}
                  </span>
                </header>
                <p>{tier.blurb}</p>
                <div className="plan-card-actions">
                  {id === 'free'
                    ? pick(null, 'Start free')
                    : trial
                      ? pick(trial, `Try it free for ${TRIAL_DAYS[trial]} days`)
                      : null}
                </div>
              </article>
            );
          })}
          <p className="note plan-picker-note">
            No card needed for a free trial. {answer === 'coach' ? 'Coaches' : 'The person who starts an organization or region trial is its director and'}{' '}
            {answer === 'coach'
              ? 'can stay on the free plan as long as they like.'
              : 'can invite admins to help. If the trial ends without a subscription it is paused, and kept for 30 days in case you subscribe.'}{' '}
            {!signedIn && (
              <>
                Already have an account? <a href={signInUrl}>Sign in</a>.{' '}
              </>
            )}
            Parents and team parents join through the invite their coach sends.
          </p>
        </div>
      )}

      <button type="button" className="linkish" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
        {showAll ? 'Hide all plans' : 'See all plans and prices'}
      </button>
      {showAll && (
        <div className="table-scroll">
          <table className="tiers">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Price</th>
                <th>What you get</th>
              </tr>
            </thead>
            <tbody>
              {ALL_PLANS.map((id) => (
                <tr key={id}>
                  <td>{LINEUP_PLAN.tiers[id].name}</td>
                  <td>{formatPlanPrice(LINEUP_PLAN, LINEUP_PLAN.tiers[id].priceCents)}</td>
                  <td>{LINEUP_PLAN.tiers[id].blurb}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            Paid plans are billed yearly. See <a href="/help/roles">Who does what</a> for what each role can do.
          </p>
        </div>
      )}
    </section>
  );
}
