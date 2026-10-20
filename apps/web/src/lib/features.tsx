import { createContext, useContext, type ReactNode } from 'react';
import { LINEUP_PLAN, tierForFeature, type Feature } from '@lineup/shared';

/**
 * The caller's plan features, from /api/me. With the paywall off the API
 * reports every feature, so nothing locks until billing is switched on (or a
 * tier is impersonated for testing).
 */
const FeaturesContext = createContext<readonly Feature[] | null>(null);

export function FeaturesProvider({ features, children }: { features: readonly Feature[]; children: ReactNode }) {
  return <FeaturesContext.Provider value={features}>{children}</FeaturesContext.Provider>;
}

/** True when the plan includes the feature, or when no plan is known yet. */
export function useFeature(feature: Feature): boolean {
  const features = useContext(FeaturesContext);
  return features === null || features.includes(feature);
}

/** The cheapest plan that unlocks a feature, by name. */
export function planNameFor(feature: Feature): string {
  const tier = tierForFeature(feature);
  return tier ? LINEUP_PLAN.tiers[tier].name : 'a paid';
}

/**
 * A locked feature: its name and "Premium feature", and tapping it opens the
 * plan comparison so the person can subscribe. `what` is a short name such
 * as "Match clock".
 */
export function PaidLock({ feature, what, className }: { feature: Feature; what: string; className?: string }) {
  return (
    <a
      className={`paid-lock${className ? ` ${className}` : ''}`}
      href="/account#plans"
      title={`${what}: ${planNameFor(feature)} plan`}
      aria-label={`${what} is a premium feature. See plans`}
    >
      <span aria-hidden="true">🔒</span> {what} · Premium feature
    </a>
  );
}
