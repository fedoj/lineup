/**
 * Team archive. Run: node --test packages/shared/test/teamArchive.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_RESTORE_DAYS, canRestoreTeam, teamRestoreUntil } from '../dist/index.js';

test('a team can be brought back for 30 days after it is archived', () => {
  assert.equal(TEAM_RESTORE_DAYS, 30);
  const at = '2026-10-16T20:00:00.000Z';
  assert.equal(teamRestoreUntil(at), '2026-11-15T20:00:00.000Z');
  assert.equal(canRestoreTeam(at, new Date('2026-10-17T00:00:00Z')), true);
  assert.equal(canRestoreTeam(at, new Date('2026-11-15T20:00:00Z')), true);
  assert.equal(canRestoreTeam(at, new Date('2026-11-15T20:00:01Z')), false);
});

test('a team that is not archived has nothing to bring back', () => {
  assert.equal(canRestoreTeam(null), false);
  assert.equal(canRestoreTeam(undefined), false);
});
