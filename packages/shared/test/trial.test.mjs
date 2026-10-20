/**
 * Free trial rules. Run with: node --test packages/shared/test/trial.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIAL_DAYS,
  TRIAL_KEEP_DAYS,
  isTrialTier,
  trialDaysLeft,
  trialEndsAt,
  trialKeepUntil,
  trialKind,
  trialState,
} from '../dist/trial.js';

const start = new Date('2026-10-13T15:00:00Z');

test('organizations and regions get 30 days, coaches 7', () => {
  assert.equal(TRIAL_DAYS.organization, 30);
  assert.equal(TRIAL_DAYS.region, 30);
  assert.equal(TRIAL_DAYS.coach, 7);
  assert.equal(trialEndsAt('organization', start).toISOString(), '2026-11-12T15:00:00.000Z');
  assert.equal(trialEndsAt('coach', start).toISOString(), '2026-10-20T15:00:00.000Z');
});

test('organization and region trials share one allowance', () => {
  assert.equal(trialKind('organization'), 'scope');
  assert.equal(trialKind('region'), 'scope');
  assert.equal(trialKind('coach'), 'coach');
  assert.equal(isTrialTier('region'), true);
  assert.equal(isTrialTier('organizationPlus'), false);
});

test('days left round up and stop at zero', () => {
  const ends = trialEndsAt('coach', start);
  assert.equal(trialDaysLeft(ends, start), 7);
  assert.equal(trialDaysLeft(ends, new Date('2026-10-20T14:00:00Z')), 1);
  assert.equal(trialDaysLeft(ends, new Date('2026-10-20T15:00:00Z')), 0);
});

test('an ended trial is kept 30 days, then deleted', () => {
  const ends = trialEndsAt('region', start);
  assert.equal(TRIAL_KEEP_DAYS, 30);
  assert.equal(trialKeepUntil(ends).toISOString(), '2026-12-12T15:00:00.000Z');
  assert.equal(trialState({ endsAt: ends }, start), 'active');
  assert.equal(trialState({ endsAt: ends }, new Date('2026-11-13T00:00:00Z')), 'ended');
  assert.equal(trialState({ endsAt: ends, purgedAt: '2026-12-13T00:00:00Z' }, new Date('2026-12-13T00:00:00Z')), 'deleted');
  assert.equal(trialState({ endsAt: ends, convertedAt: '2026-11-20T00:00:00Z' }, new Date('2026-12-13T00:00:00Z')), 'converted');
});
