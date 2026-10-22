/**
 * Custom roles (Shadi, 10/21). Run with: node --test packages/shared/test/customRoles.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOnTeam, canOnScope, assignableRoles, canManageScope } from '../dist/access.js';
import {
  CUSTOM_PERMISSIONS,
  cleanCustomRole,
  customRoleActions,
  customPermissionSummary,
} from '../dist/customRoles.js';

const LEAGUE_TEAM = { teamId: 'team-1', orgId: 'org-1', regionId: 'region-1', divisionId: null, inLeague: true };
const OTHER_TEAM = { ...LEAGUE_TEAM, teamId: 'team-2' };

const ctx = (memberships) => ({ userId: 'u1', memberships, tier: 'organization', paywallEnabled: false });
const custom = (teamId, permissions) => ({
  userId: 'u1',
  role: 'custom',
  teamId,
  actions: customRoleActions(permissions),
  customRoleName: 'BU10 Director',
});

test('seeing the teams is always granted, nothing else unless picked', () => {
  const actions = customRoleActions([]);
  assert.ok(actions.includes('team.view'));
  assert.ok(actions.includes('roster.view'));
  assert.ok(!actions.includes('game.create'));
  assert.ok(!actions.includes('member.invite'));
});

test('permissions map to their actions', () => {
  const actions = customRoleActions(['schedule', 'matchday']);
  for (const a of ['game.create', 'game.edit', 'fixture.schedule', 'lineup.edit', 'timer.run']) assert.ok(actions.includes(a), a);
  assert.ok(!actions.includes('team.edit'));
  assert.ok(!actions.includes('game.delete'));
});

test('a custom role acts only on its own teams, with only its own actions', () => {
  const c = ctx([custom('team-1', ['schedule'])]);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'game.create').allowed, true);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'roster.view').allowed, true);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'team.edit').allowed, false);
  assert.equal(canOnTeam(c, OTHER_TEAM, 'team.view').allowed, false);
});

test('a custom role never reaches the organization or region itself', () => {
  const c = ctx([custom('team-1', CUSTOM_PERMISSIONS.map((p) => p.key))]);
  for (const a of ['member.invite', 'team.create', 'fixture.schedule', 'org.manage', 'region.manage']) {
    assert.equal(canOnScope(c, { orgId: 'org-1', regionId: 'region-1' }, a).allowed, false, a);
  }
  assert.equal(canManageScope(c, 'org').allowed, false);
  assert.equal(canManageScope(c, 'region').allowed, false);
});

test('league staff actions handed down by a custom role work on league teams', () => {
  const c = ctx([custom('team-1', ['people', 'teams'])]);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'member.invite').allowed, true);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'roster.add').allowed, true);
  // A coach on the same league team still cannot.
  const coach = ctx([{ userId: 'u1', role: 'coach', teamId: 'team-1' }]);
  assert.equal(canOnTeam(coach, LEAGUE_TEAM, 'roster.add').allowed, false);
});

test('a coach who also holds a custom role keeps the coach powers', () => {
  const c = ctx([{ userId: 'u1', role: 'coach', teamId: 'team-1' }, custom('team-1', [])]);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'lineup.edit').allowed, true);
  assert.equal(canOnTeam(c, LEAGUE_TEAM, 'evaluation.edit').allowed, true);
});

test('archived teams stay read-only for custom roles', () => {
  const c = ctx([custom('team-1', ['schedule'])]);
  assert.equal(canOnTeam(c, { ...LEAGUE_TEAM, archived: true }, 'game.create').allowed, false);
  assert.equal(canOnTeam(c, { ...LEAGUE_TEAM, archived: true }, 'game.view').allowed, true);
});

test('custom is never offered as an invite role', () => {
  const c = ctx([{ userId: 'u1', role: 'director', orgId: 'org-1' }]);
  assert.ok(!assignableRoles(c, 'director').includes('custom'));
});

test('cleanCustomRole tidies the form', () => {
  const ok = cleanCustomRole({
    name: '  BU10   Director ',
    permissions: ['schedule', 'view', 'bogus', 'schedule'],
    divisions: ['bu10', 'xx', 'GU12'],
    teamIds: ['not-a-uuid', '3C620B63-0000-4000-8000-000000000000'],
  });
  assert.deepEqual(ok, {
    name: 'BU10 Director',
    permissions: ['schedule'],
    divisions: ['BU10', 'GU12'],
    teamIds: ['3c620b63-0000-4000-8000-000000000000'],
  });
  assert.ok('error' in cleanCustomRole({ name: '', divisions: ['BU10'] }));
  assert.ok('error' in cleanCustomRole({ name: 'X', divisions: [], teamIds: [] }));
  assert.ok('error' in cleanCustomRole({ name: 'x'.repeat(41), divisions: ['BU10'] }));
});

test('summary names the picked permissions', () => {
  assert.equal(customPermissionSummary([]), 'View only');
  assert.equal(customPermissionSummary(['matchday', 'schedule']), 'Schedule games, Run match day');
});

test('photos and polls in chat are custom role choices with no team actions (Shadi, 10/22)', () => {
  const clean = cleanCustomRole({ name: 'BU10 Director', permissions: ['chatPhotos', 'chatPolls'], divisions: ['BU10'] });
  assert.deepEqual(clean.permissions, ['chatPhotos', 'chatPolls']);
  assert.deepEqual(customRoleActions(['chatPhotos', 'chatPolls']), customRoleActions([]));
});
