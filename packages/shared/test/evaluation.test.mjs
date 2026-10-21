import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOnTeam } from '../dist/access.js';
import { cleanScores, overallRating, EVALUATION_CATEGORIES, cardRating, cardStats, cardTier, toCardNumber } from '../dist/evaluation.js';
import { AVATAR_OPTIONS, avatarForGender, cleanAvatar, DEFAULT_AVATAR, defaultAvatarFor, LEGACY_HAIR } from '../dist/avatar.js';
import { hasFeature } from '../dist/entitlements.js';

const TEAM = { teamId: 'team-1', orgId: 'org-1', regionId: 'region-1', divisionId: null };
const ctx = (role, scope = 'teamId', id = 'team-1') => ({
  userId: 'u1', tier: 'free', paywallEnabled: true, guardianOf: [],
  memberships: [{ userId: 'u1', role, [scope]: id }],
});

test('seven evaluation categories', () => {
  assert.equal(EVALUATION_CATEGORIES.length, 7);
});

test('overall rating is the average of rated categories', () => {
  assert.equal(overallRating({ passing: 8, shooting: 10, speed: 6 }), 8);
  assert.equal(overallRating({ passing: 8, shooting: 9 }), 8.5);
  assert.equal(overallRating({}), null);
});

test('scores outside 1 to 10 or unknown categories are dropped', () => {
  assert.deepEqual(cleanScores({ passing: 11, shooting: 0, speed: 2.5, effort: 10, height: 3 }), { effort: 10 });
});

test('the player card shows numbers out of 99 in bronze, silver or gold', () => {
  assert.equal(toCardNumber(10), 99);
  assert.equal(toCardNumber(5), 50);
  assert.equal(cardRating({ passing: 8, shooting: 8 }), 79);
  assert.equal(cardRating({}), null);
  assert.deepEqual(cardStats({ speed: 9, shooting: 7, teamwork: 8, effort: 10 }), {
    PAC: 89, SHO: 69, PAS: null, DRI: null, DEF: null, TEA: 89,
  });
  assert.equal(cardTier(80), 'gold');
  assert.equal(cardTier(70), 'silver');
  assert.equal(cardTier(50), 'bronze');
  assert.equal(cardTier(null), 'bronze');
});

test('an avatar keeps only known choices', () => {
  assert.deepEqual(cleanAvatar(null), DEFAULT_AVATAR);
  const a = cleanAvatar({ skin: 's5', hair: 'h24', hairColor: 'purple', glasses: 'sport', extra: 'x' });
  assert.equal(a.skin, 's5');
  assert.equal(a.hair, 'h24');
  assert.equal(a.hairColor, DEFAULT_AVATAR.hairColor);
  assert.equal(a.glasses, 'sport');
  assert.equal('extra' in a, false);
  assert.equal(cleanAvatar({ hair: 'h49' }).hair, DEFAULT_AVATAR.hair);
});

test('hairstyles saved by name before 10/20 map to the closest new one', () => {
  assert.equal(cleanAvatar({ hair: 'afro' }).hair, LEGACY_HAIR.afro);
  assert.equal(cleanAvatar({ hair: 'bald' }).hair, 'h25');
  for (const h of Object.values(LEGACY_HAIR)) assert.ok(AVATAR_OPTIONS.hair.includes(h));
});

test('girls start with long hair and a slimmer face until a parent designs the avatar', () => {
  assert.equal(defaultAvatarFor('girl').hair, 'h35');
  assert.equal(defaultAvatarFor('girl').face, 'heart');
  const sparkly = { ...DEFAULT_AVATAR, glitter: 'glitter', cheeks: 'rosy' };
  assert.deepEqual(avatarForGender(sparkly, 'girl'), sparkly);
  assert.equal(avatarForGender(sparkly, 'boy').glitter, 'none');
  assert.equal(avatarForGender(sparkly, null).cheeks, 'natural');
  assert.deepEqual(defaultAvatarFor('boy'), DEFAULT_AVATAR);
  assert.deepEqual(defaultAvatarFor(null), DEFAULT_AVATAR);
});

test('only coaches and assistants rate; org and region staff read', () => {
  for (const role of ['coach', 'assistant']) {
    assert.equal(canOnTeam(ctx(role), TEAM, 'evaluation.edit').allowed, true, role);
  }
  assert.equal(canOnTeam(ctx('org_admin', 'orgId', 'org-1'), TEAM, 'evaluation.edit').allowed, false);
  assert.equal(canOnTeam(ctx('org_admin', 'orgId', 'org-1'), TEAM, 'evaluation.view').allowed, true);
  assert.equal(canOnTeam(ctx('director', 'regionId', 'region-1'), TEAM, 'evaluation.view').allowed, true);
  for (const role of ['team_parent', 'parent', 'viewer']) {
    assert.equal(canOnTeam(ctx(role), TEAM, 'evaluation.view').allowed, false, role);
  }
});

test("a family's view of their child's rating is on the family plans; rating is free", () => {
  assert.equal(hasFeature('free', 'playerEvaluation'), false);
  // Coaches rate players on any plan; the Coach plan includes it for a
  // coach's own child, like the family plans.
  for (const tier of ['parent', 'teamParent', 'coach', 'region', 'organization']) {
    assert.equal(hasFeature(tier, 'playerEvaluation'), true, tier);
  }
});
