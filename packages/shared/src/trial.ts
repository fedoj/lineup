/**
 * Free trials. Organizations and regions try their plan free for 30 days,
 * coaches try the Coach plan for 7. No payment card is needed.
 *
 * One organization or region trial and one Coach trial per person. When an
 * organization or region trial ends without a subscription it is paused for
 * everyone, kept for TRIAL_KEEP_DAYS so a subscription can bring it back, and
 * then deleted.
 */

export type TrialTier = 'organization' | 'region' | 'coach';
export type TrialKind = 'scope' | 'coach';

export const TRIAL_DAYS: Readonly<Record<TrialTier, number>> = {
  organization: 30,
  region: 30,
  coach: 7,
};

/** Days a lapsed trial's data is kept so a subscription can restore it. */
export const TRIAL_KEEP_DAYS = 30;

const DAY_MS = 86_400_000;

export function isTrialTier(v: unknown): v is TrialTier {
  return v === 'organization' || v === 'region' || v === 'coach';
}

/** Organization and region trials share one allowance; Coach has its own. */
export function trialKind(tier: TrialTier): TrialKind {
  return tier === 'coach' ? 'coach' : 'scope';
}

/** When a trial started now (or at `from`) ends. */
export function trialEndsAt(tier: TrialTier, from = new Date()): Date {
  return new Date(from.getTime() + TRIAL_DAYS[tier] * DAY_MS);
}

/** Whole days left, rounded up; 0 once the trial has ended. */
export function trialDaysLeft(endsAt: string | Date, now = new Date()): number {
  const ms = new Date(endsAt).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/** Until when a lapsed trial's data is kept. */
export function trialKeepUntil(endsAt: string | Date): Date {
  return new Date(new Date(endsAt).getTime() + TRIAL_KEEP_DAYS * DAY_MS);
}

/**
 * active    running now
 * converted subscribed; nothing more to show
 * ended     ran out unpaid; data kept until keepUntil
 * deleted   ran out unpaid and the data is gone
 */
export type TrialState = 'active' | 'converted' | 'ended' | 'deleted';

export function trialState(
  t: { endsAt: string | Date; convertedAt?: string | Date | null; purgedAt?: string | Date | null },
  now = new Date(),
): TrialState {
  if (t.convertedAt) return 'converted';
  if (t.purgedAt) return 'deleted';
  return new Date(t.endsAt).getTime() > now.getTime() ? 'active' : 'ended';
}

export interface TrialInfo {
  id: string;
  kind: TrialKind;
  tier: TrialTier;
  /** The organization or region the trial created. */
  name: string | null;
  orgId: string | null;
  regionId: string | null;
  startedAt: string;
  endsAt: string;
  daysLeft: number;
  state: TrialState;
  /** The director chose to carry on as a free coach after it ended. */
  dismissed: boolean;
  /** For an ended trial: the last day a subscription can restore it. */
  keepUntil: string | null;
}

export interface TrialStatus {
  scope: TrialInfo | null;
  coach: TrialInfo | null;
  /** Which trials this person may still start. */
  canStart: { organization: boolean; region: boolean; coach: boolean };
  /** Why none can start, when that is the case. */
  blockedReason: string | null;
}
