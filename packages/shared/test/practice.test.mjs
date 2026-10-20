/**
 * Practice schedule rules. Run with: node --test packages/shared/test/practice.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { practiceDates, scheduleLengthDays, isPracticeCancelReason, cancelReasonOf, cancelLabel, PRACTICE_FREE_DAYS } from '../dist/practice.js';
import { hasFeature } from '../dist/entitlements.js';

test('schedule length counts both ends', () => {
  assert.equal(scheduleLengthDays('2026-10-12', '2026-10-12'), 1);
  assert.equal(scheduleLengthDays('2026-10-12', '2027-01-19'), 100);
  assert.equal(scheduleLengthDays('2026-10-12', '2027-01-20'), 101);
  assert.equal(PRACTICE_FREE_DAYS, 100);
});

test('practice dates fall on the chosen weekdays', () => {
  // Monday Oct 12 2026 to Sunday Oct 25: Mondays and Wednesdays.
  assert.deepEqual(practiceDates('2026-10-12', '2026-10-25', [1, 3]), [
    '2026-10-12', '2026-10-14', '2026-10-19', '2026-10-21',
  ]);
  assert.deepEqual(practiceDates('2026-10-12', '2026-10-12', [0]), []);
  // Across the US daylight-saving change (Nov 1 2026) dates stay on Tuesdays.
  assert.deepEqual(practiceDates('2026-10-27', '2026-11-10', [2]), ['2026-10-27', '2026-11-03', '2026-11-10']);
});

test('cancel reasons: rain, heat and lightning are one weather reason', () => {
  for (const r of ['weather', 'field', 'emergency', 'other']) assert.equal(isPracticeCancelReason(r), true, r);
  assert.equal(isPracticeCancelReason('rain'), false);
  assert.equal(isPracticeCancelReason('snow day'), false);
  for (const r of ['rain', 'heat', 'lightning', 'weather']) assert.equal(cancelReasonOf(r), 'weather', r);
  assert.equal(cancelReasonOf('field'), 'field');
  assert.equal(cancelReasonOf('snow day'), null);
  assert.equal(cancelLabel('lightning'), 'Weather');
  assert.equal(cancelLabel('field'), 'Field closed');
});

test('longer practice seasons and manual attendance are paid', () => {
  assert.equal(hasFeature('free', 'extendedPractice'), false);
  assert.equal(hasFeature('free', 'manualAttendance'), false);
  assert.equal(hasFeature('coach', 'extendedPractice'), true);
  assert.equal(hasFeature('coach', 'manualAttendance'), true);
});

// Parent and Team parent were merged (10/19): the one Parent plan covers it;
// whether someone may mark attendance is still up to their role on the team.
test('the Parent plan includes practice attendance by hand', () => {
  assert.equal(hasFeature('teamParent', 'manualAttendance'), true);
  assert.equal(hasFeature('parent', 'manualAttendance'), true);
  assert.equal(hasFeature('free', 'manualAttendance'), false);
  assert.equal(hasFeature('teamParent', 'extendedPractice'), false);
});
