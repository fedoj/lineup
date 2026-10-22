import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, cleanTeamType, currentSeason, divisionAge, isTeamAgeGroup, placementCheck, suggestedDivision, teamGender, TEAM_AGE_GROUPS } from '../dist/signup.js';

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

test('placing a child: boys and girls teams take only their own, coed takes both', () => {
  const boy = { gender: 'boys', division: 'BU10' };
  const girl = { gender: 'girls', division: 'GU10' };
  assert.equal(placementCheck(boy, { gender: 'boys', division: 'BU10' }).ok, true);
  assert.equal(placementCheck(girl, { gender: 'boys', division: 'BU10' }).ok, false);
  assert.equal(placementCheck(girl, { division: 'GU10' }).ok, true);
  assert.equal(placementCheck(boy, { division: 'GU10' }).ok, false);
  assert.equal(placementCheck(boy, { gender: 'coed', division: 'CU10' }).ok, true);
  assert.equal(placementCheck(girl, { division: 'CU10' }).ok, true);
  assert.equal(placementCheck(girl, {}).ok, true);
});

test('placing a child: own age group or older (play up), never younger', () => {
  const u9 = { gender: 'girls', division: 'GU9' };
  assert.deepEqual(placementCheck(u9, { division: 'GU9' }), { ok: true, playsUp: false });
  assert.deepEqual(placementCheck(u9, { division: 'GU10' }), { ok: true, playsUp: true });
  assert.equal(placementCheck(u9, { division: 'GU8' }).ok, false);
  assert.equal(placementCheck(u9, { gender: 'girls', division: null }).ok, true);
});

test('age groups and team genders are read from the division', () => {
  assert.equal(divisionAge('BU10'), 10);
  assert.equal(divisionAge('cu8'), 8);
  assert.equal(divisionAge(null), null);
  assert.equal(teamGender({ division: 'GU12' }), 'girls');
  assert.equal(teamGender({ gender: 'coed', division: 'BU12' }), 'coed');
  assert.equal(teamGender({}), null);
});

test('team age groups follow AYSO on MatchTrak: two-year bands plus U9, U11 and U13', () => {
  assert.deepEqual([...TEAM_AGE_GROUPS], [6, 8, 9, 10, 11, 12, 13, 14, 16, 19]);
  assert.equal(isTeamAgeGroup(9), true);
  assert.equal(isTeamAgeGroup(7), false);
  assert.equal(isTeamAgeGroup(15), false);
});

test('team types: trimmed, short, or none', () => {
  assert.equal(cleanTeamType('  All   Stars '), 'All Stars');
  assert.equal(cleanTeamType(''), null);
  assert.equal(cleanTeamType(null), null);
  assert.equal(cleanTeamType('x'.repeat(40)).length, 30);
});
