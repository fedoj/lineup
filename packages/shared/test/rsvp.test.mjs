/**
 * RSVP reasons and add-to-calendar files. Run with:
 * node --test packages/shared/test/rsvp.test.mjs (build the package first).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, cleanRsvpReason, nameWithReason } from '../dist/rsvp.js';
import { hasFeature } from '../dist/entitlements.js';

test('not going keeps a reason, and a comment only for other', () => {
  assert.deepEqual(cleanRsvpReason('sick', 'flu'), { reason: 'sick', note: null });
  assert.deepEqual(cleanRsvpReason('other', '  family   trip '), { reason: 'other', note: 'family trip' });
  assert.deepEqual(cleanRsvpReason('other', ''), { reason: 'other', note: null });
  assert.deepEqual(cleanRsvpReason('bored', 'x'), { reason: null, note: null });
  assert.equal(cleanRsvpReason('other', 'x'.repeat(300)).note.length, 200);
});

test('staff see the reason next to the name', () => {
  assert.equal(nameWithReason('Ben', 'sick'), 'Ben (sick)');
  assert.equal(nameWithReason('Ava', 'other', 'family trip'), 'Ava (other: family trip)');
  assert.equal(nameWithReason('Cy', null), 'Cy');
});

test('a timed entry is local time with an end; an untimed one is all day', () => {
  const now = new Date('2026-10-14T16:00:00Z');
  const timed = buildIcs({ uid: 'g1', title: 'Iron vs Rivals', date: '2026-10-24', time: '10:00', durationMinutes: 75, location: 'Riverside Park, Field 2', now });
  assert.match(timed, /DTSTART:20261024T100000\r\n/);
  assert.match(timed, /DTEND:20261024T111500\r\n/);
  assert.match(timed, /LOCATION:Riverside Park\\, Field 2\r\n/);
  assert.match(timed, /UID:g1@lineup\.mahoul\.io/);
  const allDay = buildIcs({ uid: 'e1', title: 'Picture day', date: '2026-12-31', now });
  assert.match(allDay, /DTSTART;VALUE=DATE:20261231\r\n/);
  assert.match(allDay, /DTEND;VALUE=DATE:20270101\r\n/);
  assert.ok(buildIcs({ uid: 'x', title: 'y'.repeat(200), date: '2026-10-24', now }).split('\r\n').every((l) => l.length <= 75));
});

test('add to calendar is on every paid plan, not free', () => {
  assert.equal(hasFeature('free', 'addToCalendar'), false);
  for (const tier of ['parent', 'teamParent', 'coach', 'region', 'organization', 'organizationPlus']) {
    assert.equal(hasFeature(tier, 'addToCalendar'), true, tier);
  }
});
