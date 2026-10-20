/**
 * Entitlement checks.
 * Run: node --test packages/shared/test/entitlements.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEUP_PLAN,
  TIER_ORDER,
  checkLimit,
  effectiveLimits,
  effectiveTier,
  formatPlanPrice,
  formatPrice,
  hasFeature,
  isEntitlementLive,
  isPerParent,
  nextTierFor,
  normalizeTier,
  premiumTierFor,
  tierForFeature,
} from '../dist/index.js';

const ent = (over = {}) => ({
  appId: 'lineup',
  userId: 'u1',
  tier: 'free',
  grantedAt: new Date().toISOString(),
  ...over,
});

test('free tier is 2 teams and 12 games per team', () => {
  const free = LINEUP_PLAN.tiers.free.limits;
  assert.equal(free.teams, 2);
  assert.equal(free.gamesPerTeam, 12);
});

test('coach plan is 6 teams and 20 games per team, prices match the catalog', () => {
  const coach = LINEUP_PLAN.tiers.coach.limits;
  assert.equal(coach.teams, 6);
  assert.equal(coach.gamesPerTeam, 20);
  assert.equal(LINEUP_PLAN.tiers.coach.priceCents, 999);
  assert.equal(LINEUP_PLAN.tiers.parent.priceCents, 499);
  // Team parent was merged into Parent (10/19); old rows still read as Parent.
  assert.equal(LINEUP_PLAN.tiers.teamParent, undefined);
  assert.equal(normalizeTier('teamParent'), 'parent');
  assert.equal(LINEUP_PLAN.tiers.referee.priceCents, 499);
  assert.equal(LINEUP_PLAN.tiers.region.priceCents, 19900);
  assert.equal(LINEUP_PLAN.tiers.organization.priceCents, 29900);
  assert.equal(LINEUP_PLAN.tiers.organizationPlus.priceCents, 49900);
});

test('region and organization plans scale by region, 20 teams and 20 games each', () => {
  const { region, organization, organizationPlus } = LINEUP_PLAN.tiers;
  assert.deepEqual([region.limits.regions, region.limits.teams, region.limits.gamesPerTeam], [1, 20, 20]);
  assert.deepEqual([organization.limits.regions, organization.limits.teams], [20, 400]);
  assert.deepEqual([organizationPlus.limits.regions, organizationPlus.limits.teams], [40, 800]);
  // A region plan runs its own region, but cannot found an organization.
  assert.equal(hasFeature('region', 'regions'), true);
  assert.equal(hasFeature('region', 'orgs'), false);
  assert.equal(hasFeature('organizationPlus', 'orgs'), true);
});

test('Test as Premium picks the plan each role would buy', () => {
  assert.equal(premiumTierFor('org_admin'), 'organization');
  assert.equal(premiumTierFor('region_admin'), 'organization');
  assert.equal(premiumTierFor('coach'), 'coach');
  assert.equal(premiumTierFor('assistant'), 'coach');
  assert.equal(premiumTierFor('parent'), 'parent');
  assert.equal(premiumTierFor('team_parent'), 'parent');
});

test('games are metered per team, teams are not', () => {
  assert.equal(isPerParent(LINEUP_PLAN, 'gamesPerTeam'), true);
  assert.equal(isPerParent(LINEUP_PLAN, 'playersPerTeam'), true);
  assert.equal(isPerParent(LINEUP_PLAN, 'teams'), false);
});

test('limits increase monotonically with tier', () => {
  for (const resource of LINEUP_PLAN.resources) {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const lower = LINEUP_PLAN.tiers[TIER_ORDER[i - 1]].limits[resource];
      const higher = LINEUP_PLAN.tiers[TIER_ORDER[i]].limits[resource];
      assert.ok(higher >= lower, `${resource}: ${TIER_ORDER[i]} < ${TIER_ORDER[i - 1]}`);
    }
  }
});

test('features accumulate along the coaching line', () => {
  const line = ['free', 'coach', 'organization'];
  for (let i = 1; i < line.length; i++) {
    const lower = LINEUP_PLAN.tiers[line[i - 1]].features;
    const higher = LINEUP_PLAN.tiers[line[i]].features;
    for (const f of lower) {
      assert.ok(higher.includes(f), `${line[i]} lost ${f}`);
    }
  }
});

test('organization includes every feature of every plan', () => {
  const org = LINEUP_PLAN.tiers.organization.features;
  for (const id of TIER_ORDER) {
    for (const f of LINEUP_PLAN.tiers[id].features) {
      assert.ok(org.includes(f), `organization lacks ${f} from ${id}`);
    }
  }
});

test('free tier unlocks no paid features', () => {
  assert.deepEqual(LINEUP_PLAN.tiers.free.features, []);
  assert.equal(hasFeature('free', 'orgs'), false);
  assert.equal(hasFeature('free', 'customDivisions'), false);
});

test('tierForFeature returns the cheapest qualifying tier', () => {
  assert.equal(tierForFeature('customDivisions'), 'coach');
  assert.equal(tierForFeature('regions'), 'region');
  assert.equal(tierForFeature('orgs'), 'organization');
  assert.equal(tierForFeature('ownPlayerStats'), 'parent');
  assert.equal(tierForFeature('eventFlyers'), 'parent');
  assert.equal(tierForFeature('refereeClock'), 'referee');
});

test('Referee Premium unlocks the referee clock and nothing a coach or parent pays for', () => {
  assert.deepEqual([...LINEUP_PLAN.tiers.referee.features].sort(), ['adFree', 'refereeClock']);
  assert.equal(hasFeature('free', 'refereeClock'), false);
  assert.equal(hasFeature('referee', 'matchClock'), false);
  assert.equal(hasFeature('organization', 'refereeClock'), true);
});

test('event flyers come with the parent, coach and organization plans', () => {
  for (const tier of ['parent', 'teamParent', 'coach', 'organization']) {
    assert.equal(hasFeature(tier, 'eventFlyers'), true, tier);
  }
  assert.equal(hasFeature('free', 'eventFlyers'), false);
  assert.equal(hasFeature('referee', 'eventFlyers'), false);
});

test('third team is refused on free', () => {
  const check = checkLimit(LINEUP_PLAN, ent(), { teams: 2 }, 'teams', 1, true);
  assert.equal(check.allowed, false);
  assert.equal(check.upgradeTo, 'coach');
});

test('second team is allowed on free', () => {
  const check = checkLimit(LINEUP_PLAN, ent(), { teams: 1 }, 'teams', 1, true);
  assert.equal(check.allowed, true);
  assert.equal(check.remaining, 1);
});

test('each team gets its own game allowance', () => {
  // Team A is full, team B is empty — B must still accept a game.
  const full = checkLimit(
    LINEUP_PLAN, ent(), { gamesPerTeam: 12 }, 'gamesPerTeam', 1, true, 'team-a');
  const empty = checkLimit(
    LINEUP_PLAN, ent(), { gamesPerTeam: 0 }, 'gamesPerTeam', 1, true, 'team-b');

  assert.equal(full.allowed, false);
  assert.equal(full.scopedTo, 'team-a');
  assert.equal(empty.allowed, true);
});

test('account-scoped checks carry no scope label', () => {
  const check = checkLimit(LINEUP_PLAN, ent(), { teams: 1 }, 'teams', 1, true, 'team-a');
  assert.equal(check.scopedTo, undefined);
});

test('paywall disabled makes every limit unlimited', () => {
  const limits = effectiveLimits(LINEUP_PLAN, null, false);
  for (const r of LINEUP_PLAN.resources) {
    assert.ok(limits[r] > 1_000_000, r);
  }
  const check = checkLimit(LINEUP_PLAN, null, { teams: 9999 }, 'teams', 1, false);
  assert.equal(check.allowed, true);
});

test('overrides raise a single limit without touching others', () => {
  const e = ent({ overrides: { teams: 50 } });
  const limits = effectiveLimits(LINEUP_PLAN, e, true);
  assert.equal(limits.teams, 50);
  assert.equal(limits.gamesPerTeam, 12);
});

test('no entitlement means free', () => {
  assert.equal(effectiveTier(null), 'free');
  assert.equal(effectiveLimits(LINEUP_PLAN, null, true).teams, 2);
});

test('cancelled plan keeps working until access ends', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const e = ent({ tier: 'organization', status: 'cancelled', accessUntil: future });
  assert.equal(isEntitlementLive(e), true);
  assert.equal(effectiveTier(e), 'organization');
});

test('cancelled plan drops to free once access ends', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const e = ent({ tier: 'organization', status: 'cancelled', accessUntil: past });
  assert.equal(isEntitlementLive(e), false);
  assert.equal(effectiveTier(e), 'free');
  assert.equal(effectiveLimits(LINEUP_PLAN, e, true).teams, 2);
});

test('cancelled with no end date is not live', () => {
  const e = ent({ tier: 'coach', status: 'cancelled', accessUntil: null });
  assert.equal(isEntitlementLive(e), false);
});

test('expired plan is never live', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const e = ent({ tier: 'organization', status: 'expired', accessUntil: future });
  assert.equal(isEntitlementLive(e), false);
});

test('nextTierFor finds the smallest sufficient tier', () => {
  assert.equal(nextTierFor(LINEUP_PLAN, 'teams', 5), 'coach');
  assert.equal(nextTierFor(LINEUP_PLAN, 'teams', 20), 'region');
  assert.equal(nextTierFor(LINEUP_PLAN, 'teams', 100), 'organization');
  assert.equal(nextTierFor(LINEUP_PLAN, 'teams', 600), 'organizationPlus');
  assert.equal(nextTierFor(LINEUP_PLAN, 'teams', 10_000), undefined);
});

test('prices format for display', () => {
  assert.equal(formatPrice(0), 'Free');
  assert.equal(formatPrice(999), '$9.99');
  assert.equal(formatPrice(15999), '$159.99');
});

test('paid plans are billed yearly', () => {
  assert.equal(LINEUP_PLAN.interval, 'year');
  assert.equal(formatPlanPrice(LINEUP_PLAN, 999), '$9.99/yr');
  assert.equal(formatPlanPrice(LINEUP_PLAN, 0), 'Free');
});

test('every tier has a blurb for the pricing table', () => {
  for (const id of TIER_ORDER) {
    assert.ok(LINEUP_PLAN.tiers[id].blurb.length > 0, id);
  }
});

test('legacy tier ids map onto the current plans', () => {
  assert.equal(normalizeTier('club'), 'coach');
  assert.equal(normalizeTier('league'), 'organization');
  assert.equal(normalizeTier('region'), 'region');
  assert.equal(normalizeTier('coach'), 'coach');
  assert.equal(normalizeTier('bogus'), 'free');
  assert.equal(normalizeTier(null), 'free');
  assert.equal(effectiveTier(ent({ tier: 'club' })), 'coach');
  assert.equal(hasFeature('league', 'orgs'), true);
});

test('the Coach plan includes everything in Parent', () => {
  const coach = LINEUP_PLAN.tiers.coach.features;
  for (const tier of ['parent']) {
    for (const f of LINEUP_PLAN.tiers[tier].features) {
      assert.ok(coach.includes(f), `${tier}: ${f}`);
    }
  }
});
