import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, currentSeason, suggestedDivision } from '../dist/signup.js';

test('codes keep letters and digits only, in capitals', () => {
  assert.equal(cleanCode(' cy-press 154 '), 'CYPRESS154');
  assert.equal(cleanCode('Región 42'), 'REGION42');
});

test('seasons run August to July', () => {
  assert.equal(currentSeason(new Date(2026, 9, 11)), '2026-27');
  assert.equal(currentSeason(new Date(2027, 2, 1)), '2026-27');
  assert.equal(currentSeason(new Date(2027, 7, 1)), '2027-28');
});

test('age group from birth year', () => {
  assert.equal(suggestedDivision(2017, 'boys', '2026-27'), 'BU10');
  assert.equal(suggestedDivision(2019, 'girls', '2026-27'), 'GU8');
});

import { cleanCompetitionCode, registrationStatus, suggestCompetitionCode } from '../dist/index.js';

test('league sign-ups are open between the registration dates', () => {
  assert.equal(registrationStatus('2026-10-20', '2026-11-01', '2026-12-31', '2026-10-17'), 'upcoming');
  assert.equal(registrationStatus('2026-10-01', '2026-11-01', '2026-12-31', '2026-10-17'), 'open');
  assert.equal(registrationStatus(null, '2026-10-17', '2026-12-31', '2026-10-17'), 'open');
  assert.equal(registrationStatus(null, '2026-10-16', '2026-12-31', '2026-10-17'), 'closed');
  // No closing date: open until the league ends.
  assert.equal(registrationStatus(null, null, '2026-12-31', '2026-10-17'), 'open');
  assert.equal(registrationStatus(null, null, '2026-10-01', '2026-10-17'), 'closed');
});

test('sign-up codes', () => {
  let n = 0;
  const seq = () => [0, 0.5, 0.99, 0.25][n++ % 4];
  assert.match(suggestCompetitionCode('Fall 2026', seq), /^FALL-[A-Z2-9]{4}$/);
  assert.match(suggestCompetitionCode('2026', seq), /^LEAGUE-[A-Z2-9]{4}$/);
  assert.equal(cleanCompetitionCode(' fall-7kq2 '), 'FALL-7KQ2');
});
