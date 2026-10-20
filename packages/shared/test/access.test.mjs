/**
 * Access-control checks. Run with: node --test packages/shared/test/access.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canOnTeam,
  canOnScope,
  canManageScope,
  canViewPlayer,
  visiblePlayerIds,
  assignableRoles,
  isFamilyOnly,
  tierHasFeature,
} from '../dist/access.js';

const TEAM = {
  teamId: 'team-1',
  orgId: 'org-1',
  regionId: 'region-1',
  divisionId: null,
};

const ctx = (over = {}) => ({
  userId: 'u1',
  memberships: [],
  tier: 'free',
  paywallEnabled: true,
  guardianOf: [],
  ...over,
});

const m = (role, scope, id) => ({ userId: 'u1', role, [scope]: id });

test('free coach can run their team', () => {
  const c = ctx({ memberships: [m('coach', 'teamId', 'team-1')] });
  for (const action of ['lineup.edit', 'roster.edit', 'timer.run', 'stats.edit', 'game.create']) {
    assert.equal(canOnTeam(c, TEAM, action).allowed, true, action);
  }
});

test('free coach cannot manage org or region', () => {
  const c = ctx({ memberships: [m('coach', 'teamId', 'team-1')] });
  const org = canOnTeam(c, TEAM, 'org.manage');
  assert.equal(org.allowed, false);
  // Role is the blocker here, not the plan — a coach never manages an org.
  assert.equal(org.reason, 'role-denied');
});

test('org_admin on free plan is blocked commercially, not by role', () => {
  const c = ctx({ memberships: [m('org_admin', 'orgId', 'org-1')], tier: 'free' });
  const d = canOnTeam(c, TEAM, 'org.manage');
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'upgrade-required');
  assert.equal(d.requiresFeature, 'orgs');
});

test('org_admin on organization tier can manage org', () => {
  const c = ctx({ memberships: [m('org_admin', 'orgId', 'org-1')], tier: 'organization' });
  assert.equal(canOnTeam(c, TEAM, 'org.manage').allowed, true);
});

test('org-scope checks only match memberships at that org', () => {
  const c = ctx({ memberships: [m('org_admin', 'orgId', 'org-1')], tier: 'organization' });
  assert.equal(canOnScope(c, { orgId: 'org-1' }, 'region.manage').allowed, true);
  assert.equal(canOnScope(c, { orgId: 'org-2' }, 'region.manage').allowed, false);
});

test('a team-scope role never reaches up to the org', () => {
  const c = ctx({ memberships: [m('org_admin', 'teamId', 'team-1')], tier: 'organization' });
  assert.equal(canOnScope(c, { orgId: 'org-1' }, 'org.manage').allowed, false);
});

test('a director may add teams to their region but not another', () => {
  const c = ctx({ memberships: [m('director', 'regionId', 'region-1')], tier: 'organization' });
  const own = { orgId: 'org-1', regionId: 'region-1' };
  const other = { orgId: 'org-1', regionId: 'region-2' };
  assert.equal(canOnScope(c, own, 'team.create').allowed, true);
  assert.equal(canOnScope(c, other, 'team.create').allowed, false);
});

test('custom divisions need coach tier or better', () => {
  const free = ctx({ memberships: [m('director', 'regionId', 'region-1')], tier: 'free' });
  assert.equal(canOnTeam(free, TEAM, 'division.manage').reason, 'upgrade-required');

  const club = ctx({ memberships: [m('director', 'regionId', 'region-1')], tier: 'coach' });
  assert.equal(canOnTeam(club, TEAM, 'division.manage').allowed, true);
});

test('paywall disabled lets everything through the tier gate', () => {
  const c = ctx({
    memberships: [m('org_admin', 'orgId', 'org-1')],
    tier: 'free',
    paywallEnabled: false,
  });
  assert.equal(canOnTeam(c, TEAM, 'org.manage').allowed, true);
});

test('assistant cannot edit the roster or delete', () => {
  const c = ctx({ memberships: [m('assistant', 'teamId', 'team-1')] });
  assert.equal(canOnTeam(c, TEAM, 'lineup.edit').allowed, true);
  assert.equal(canOnTeam(c, TEAM, 'timer.run').allowed, true);
  assert.equal(canOnTeam(c, TEAM, 'roster.edit').allowed, false);
  assert.equal(canOnTeam(c, TEAM, 'game.delete').allowed, false);
});

test('team parent runs events, snacks and calendar sharing, never match day', () => {
  const c = ctx({ memberships: [m('team_parent', 'teamId', 'team-1')] });
  for (const action of ['event.create', 'event.edit', 'snack.edit', 'calendar.share', 'game.view', 'roster.view']) {
    assert.equal(canOnTeam(c, TEAM, action).allowed, true, action);
  }
  for (const action of ['lineup.edit', 'timer.run', 'stats.edit', 'stats.view', 'game.create', 'member.invite', 'roster.edit']) {
    assert.equal(canOnTeam(c, TEAM, action).allowed, false, action);
  }
  // The whole roster, so families can be put on the snack schedule.
  assert.deepEqual(visiblePlayerIds(c, TEAM, ['a', 'b']), ['a', 'b']);
});

test('parents and players see events and snacks but cannot change them', () => {
  for (const role of ['parent', 'player']) {
    const c = ctx({ memberships: [m(role, 'teamId', 'team-1')] });
    assert.equal(canOnTeam(c, TEAM, 'event.view').allowed, true, role);
    assert.equal(canOnTeam(c, TEAM, 'snack.view').allowed, true, role);
    assert.equal(canOnTeam(c, TEAM, 'event.create').allowed, false, role);
    assert.equal(canOnTeam(c, TEAM, 'snack.edit').allowed, false, role);
  }
});

test('coaches can hand out the team parent role', () => {
  const c = ctx({ memberships: [m('coach', 'teamId', 'team-1')] });
  assert.equal(assignableRoles(c, 'coach').includes('team_parent'), true);
  assert.equal(assignableRoles(c, 'team_parent').includes('coach'), false);
});

test('family-only accounts are team parents, parents, players or viewers', () => {
  assert.equal(isFamilyOnly(['team_parent']), true);
  assert.equal(isFamilyOnly(['parent', 'viewer', 'team_parent']), true);
  assert.equal(isFamilyOnly(['parent', 'coach']), false);
  assert.equal(isFamilyOnly(['assistant']), false);
  // No roles yet is a new coach signing up, not a family account.
  assert.equal(isFamilyOnly([]), false);
});

test('parent sees only linked children', () => {
  const c = ctx({
    memberships: [m('parent', 'teamId', 'team-1')],
    guardianOf: ['p-mine'],
  });
  assert.equal(canViewPlayer(c, TEAM, 'p-mine').allowed, true);
  const other = canViewPlayer(c, TEAM, 'p-other');
  assert.equal(other.allowed, false);
  assert.equal(other.reason, 'not-guardian');

  assert.deepEqual(visiblePlayerIds(c, TEAM, ['p-mine', 'p-other', 'p-third']), ['p-mine']);
});

test('parent with no guardian link sees nobody', () => {
  const c = ctx({ memberships: [m('parent', 'teamId', 'team-1')], guardianOf: [] });
  assert.deepEqual(visiblePlayerIds(c, TEAM, ['p-1', 'p-2']), []);
});

test('coach sees the whole roster', () => {
  const c = ctx({ memberships: [m('coach', 'teamId', 'team-1')] });
  assert.deepEqual(visiblePlayerIds(c, TEAM, ['p-1', 'p-2']), ['p-1', 'p-2']);
});

test('parent cannot write anything', () => {
  const c = ctx({ memberships: [m('parent', 'teamId', 'team-1')], guardianOf: ['p-1'] });
  for (const action of ['roster.edit', 'lineup.edit', 'stats.edit', 'attendance.edit', 'game.create']) {
    assert.equal(canOnTeam(c, TEAM, action).allowed, false, action);
  }
});

test('no membership means no access', () => {
  const d = canOnTeam(ctx(), TEAM, 'team.view');
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'no-membership');
});

test('membership on another team does not leak', () => {
  const c = ctx({ memberships: [m('coach', 'teamId', 'team-OTHER')] });
  assert.equal(canOnTeam(c, TEAM, 'team.view').reason, 'no-membership');
});

test('org membership inherits down to a team in that org', () => {
  const c = ctx({ memberships: [m('org_admin', 'orgId', 'org-1')], tier: 'organization' });
  assert.equal(canOnTeam(c, TEAM, 'lineup.edit').allowed, true);
});

test('strongest applicable role wins', () => {
  const c = ctx({
    memberships: [m('viewer', 'teamId', 'team-1'), m('coach', 'teamId', 'team-1')],
  });
  assert.equal(canOnTeam(c, TEAM, 'roster.edit').matchedRole, 'coach');
});

test('free user cannot assign paid-only roles', () => {
  const c = ctx({ tier: 'free' });
  const roles = assignableRoles(c, 'coach');
  assert.equal(roles.includes('org_admin'), false);
  assert.equal(roles.includes('director'), false);
  assert.equal(roles.includes('parent'), true);
  assert.equal(roles.includes('assistant'), true);
});

test('nobody can assign a role above their own', () => {
  const c = ctx({ tier: 'organization' });
  assert.equal(assignableRoles(c, 'coach').includes('director'), false);
  assert.equal(assignableRoles(c, 'org_admin').includes('org_admin'), true);
});

test('platform admin bypasses both gates', () => {
  const c = ctx({ isPlatformAdmin: true, tier: 'free' });
  assert.equal(canOnTeam(c, TEAM, 'org.manage').allowed, true);
});

test('canManageScope mirrors the tier gate', () => {
  const free = ctx({ memberships: [m('org_admin', 'orgId', 'org-1')], tier: 'free' });
  assert.equal(canManageScope(free, 'org').reason, 'upgrade-required');
  assert.equal(canManageScope(free, 'team').allowed, true);
});

test('tier feature table is ordered correctly', () => {
  assert.equal(tierHasFeature('free', 'orgs'), false);
  assert.equal(tierHasFeature('coach', 'customDivisions'), true);
  assert.equal(tierHasFeature('coach', 'regions'), false);
  assert.equal(tierHasFeature('organization', 'regions'), true);
  assert.equal(tierHasFeature('organization', 'orgs'), true);
});

test('on a league team only org and region staff add players or invite', () => {
  const LEAGUE = { ...TEAM, inLeague: true };
  const coach = ctx({ memberships: [m('coach', 'teamId', 'team-1')] });
  for (const action of ['roster.add', 'member.invite']) {
    assert.equal(canOnTeam(coach, LEAGUE, action).allowed, false, action);
    assert.equal(canOnTeam(coach, TEAM, action).allowed, true, `standalone ${action}`);
  }
  // Coaches still edit numbers and positions and run the team.
  for (const action of ['roster.edit', 'lineup.edit', 'game.create']) {
    assert.equal(canOnTeam(coach, LEAGUE, action).allowed, true, action);
  }
  const assistant = ctx({ memberships: [m('assistant', 'teamId', 'team-1')] });
  assert.equal(canOnTeam(assistant, TEAM, 'roster.add').allowed, false);
  const regionAdmin = ctx({ tier: 'organization', memberships: [m('region_admin', 'regionId', 'region-1')] });
  for (const action of ['roster.add', 'member.invite']) {
    assert.equal(canOnTeam(regionAdmin, LEAGUE, action).allowed, true, action);
  }
  // A region admin who also coaches the team is still staff.
  const both = ctx({ memberships: [m('coach', 'teamId', 'team-1'), m('director', 'orgId', 'org-1')] });
  assert.equal(canOnTeam(both, LEAGUE, 'member.invite').allowed, true);
});

test('directors outrank admins: only directors rename, and they can invite admins', () => {
  const dir = ctx({ tier: 'organization', memberships: [m('director', 'orgId', 'org-1')] });
  const adm = ctx({ tier: 'organization', memberships: [m('org_admin', 'orgId', 'org-1')] });
  assert.equal(canOnScope(dir, { orgId: 'org-1' }, 'scope.rename').allowed, true);
  assert.equal(canOnScope(adm, { orgId: 'org-1' }, 'scope.rename').allowed, false);
  // Admins still run the organization: settings, regions, invites.
  assert.equal(canOnScope(adm, { orgId: 'org-1' }, 'org.manage').allowed, true);
  assert.equal(canOnScope(adm, { orgId: 'org-1' }, 'region.manage').allowed, true);
  assert.equal(canOnScope(dir, { orgId: 'org-1' }, 'org.manage').allowed, true);
  assert.equal(assignableRoles(dir, 'director').includes('org_admin'), true);
  assert.equal(assignableRoles(adm, 'org_admin').includes('director'), false);
  // Region level: the region director renames, the region admin does not.
  const rdir = ctx({ tier: 'organization', memberships: [m('director', 'regionId', 'region-1')] });
  const radm = ctx({ tier: 'organization', memberships: [m('region_admin', 'regionId', 'region-1')] });
  assert.equal(canOnScope(rdir, { orgId: 'org-1', regionId: 'region-1' }, 'scope.rename').allowed, true);
  assert.equal(canOnScope(radm, { orgId: 'org-1', regionId: 'region-1' }, 'scope.rename').allowed, false);
  // A region director never gets organization-level rights.
  assert.equal(canOnScope(rdir, { orgId: 'org-1' }, 'org.manage').allowed, false);
  assert.equal(canOnScope(rdir, { orgId: 'org-1' }, 'scope.rename').allowed, false);
});

test('an archived team is read-only for everyone, platform admins included', () => {
  const archived = { ...TEAM, archived: true };
  const coach = ctx({ memberships: [m('coach', 'teamId', 'team-1')] });
  for (const action of ['lineup.edit', 'roster.edit', 'game.create', 'event.create', 'team.edit']) {
    const d = canOnTeam(coach, archived, action);
    assert.equal(d.allowed, false, action);
    assert.equal(d.reason, 'archived', action);
  }
  for (const action of ['team.view', 'game.view', 'stats.view', 'data.export']) {
    assert.equal(canOnTeam(coach, archived, action).allowed, true, action);
  }
  const admin = ctx({ isPlatformAdmin: true });
  assert.equal(canOnTeam(admin, archived, 'game.edit').reason, 'archived');
  // Someone with no access still gets the plain denial, not "archived".
  assert.equal(canOnTeam(ctx(), archived, 'game.edit').reason, 'no-membership');
});
