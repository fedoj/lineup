/**
 * Seasons and tournaments. Run: node --test packages/shared/test/competition.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCompetition, competitionDeleteOn, competitionStatus } from '../dist/index.js';

test('upcoming before the start, active through the end date, archived after', () => {
  assert.equal(competitionStatus('2026-11-01', '2026-12-31', '2026-10-16'), 'upcoming');
  assert.equal(competitionStatus('2026-09-01', '2026-12-31', '2026-10-16'), 'active');
  assert.equal(competitionStatus('2026-09-01', '2026-10-16', '2026-10-16'), 'active');
  assert.equal(competitionStatus('2026-09-01', '2026-10-15', '2026-10-16'), 'archived');
});

test('an archived season is deleted 3 months after its end date', () => {
  assert.equal(competitionDeleteOn('2026-12-31'), '2027-04-01');
  assert.equal(competitionDeleteOn('2026-11-30'), '2027-03-01');
  assert.equal(competitionDeleteOn('2026-06-15'), '2026-09-16');
});

test('a season needs a kind, a name and dates in order', () => {
  assert.deepEqual(cleanCompetition({ kind: 'season', name: '  Fall   2026 ', startsOn: '2026-08-24', endsOn: '2026-11-25' }), {
    kind: 'season', name: 'Fall 2026', startsOn: '2026-08-24', endsOn: '2026-11-25',
  });
  assert.ok('error' in cleanCompetition({ kind: 'league', name: 'X', startsOn: '2026-01-01', endsOn: '2026-02-01' }));
  assert.ok('error' in cleanCompetition({ kind: 'tournament', name: '', startsOn: '2026-01-01', endsOn: '2026-02-01' }));
  assert.ok('error' in cleanCompetition({ kind: 'tournament', name: 'Cup', startsOn: '2026-02-01', endsOn: '2026-01-01' }));
  assert.ok('error' in cleanCompetition({ kind: 'tournament', name: 'Cup', startsOn: '2026-2-1', endsOn: '2026-03-01' }));
});

import { gameLockDay, isGameLocked } from '../dist/index.js';

test('games lock 3 days after their league or tournament ends', () => {
  assert.equal(gameLockDay('2026-10-31'), '2026-11-04');
  assert.equal(isGameLocked('2026-10-31', '2026-11-03'), false);
  assert.equal(isGameLocked('2026-10-31', '2026-11-04'), true);
  assert.equal(isGameLocked(null, '2026-11-04'), false);
});
