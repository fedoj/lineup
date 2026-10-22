import type { Feature, TierId } from '@lineup/shared';

/** What someone said they are on the "Choose the plan that's right for you" page. */
export const PLAN_FOR_KEY = 'lineup.planFor';

/**
 * The paid features each plan is mostly bought for, in the order the buyer
 * cares about them. Shown first, and the top five in "Best for you".
 */
export const PLAN_HIGHLIGHTS: Partial<Record<TierId, Feature[]>> = {
  coach: ['matchClock', 'fullStats', 'customStats', 'extendedPractice', 'manualAttendance', 'longShareLinks', 'chatPolls'],
  parent: ['ownPlayerStats', 'playerEvaluation', 'scopeStandings', 'chatAttachments', 'addToCalendar', 'eventFlyers', 'manualAttendance'],
  referee: ['refereeClock', 'adFree'],
  region: ['regions', 'scopeStandings', 'crossTeamAnalytics', 'customDivisions', 'multiTeamAdmin'],
  organization: ['orgs', 'regions', 'scopeStandings', 'crossTeamAnalytics', 'customDivisions'],
  organizationPlus: ['orgs', 'regions', 'scopeStandings', 'crossTeamAnalytics', 'customDivisions'],
};

export interface PlanFor {
  tier: TierId;
  /** Why this plan, in a few words: "You coach a team". */
  reason: string;
}

/**
 * The plan that fits this person best, from what they do in Lineup: running
 * an organization or region, coaching, being a team parent or parent, or
 * refereeing. Before they have a role, what they picked when signing up.
 */
export function recommendPlan(input: {
  teamRoles: Array<string | null | undefined>;
  managesOrg: boolean;
  managesRegion: boolean;
  referee: boolean;
  signupAnswer?: string | null;
  /** Signed a child up through a league or tournament link, or said "I'm a parent". */
  signupParent?: boolean;
}): PlanFor {
  const roles = new Set(input.teamRoles.filter(Boolean) as string[]);
  if (input.managesOrg) return { tier: 'organization', reason: 'You run an organization.' };
  if (input.managesRegion) return { tier: 'region', reason: 'You run a region.' };
  if (roles.has('coach') || roles.has('assistant')) return { tier: 'coach', reason: 'You coach a team.' };
  if (roles.has('team_parent')) return { tier: 'parent', reason: 'You are a team parent.' };
  if (roles.has('parent') || roles.has('player')) return { tier: 'parent', reason: 'You follow your child’s team.' };
  // Everyone who joins from a league's sign-up link is a parent (Shadi, 10/21).
  if (input.signupParent) return { tier: 'parent', reason: 'You signed your child up with a league or tournament.' };
  if (input.referee) return { tier: 'referee', reason: 'You referee league games.' };
  if (input.signupAnswer === 'organization') return { tier: 'organization', reason: 'You said you run an organization.' };
  if (input.signupAnswer === 'region') return { tier: 'region', reason: 'You said you run a region.' };
  return { tier: 'coach', reason: 'Most people who start on Free coach a team.' };
}
