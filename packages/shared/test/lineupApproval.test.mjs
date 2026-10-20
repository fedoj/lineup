/**
 * Assistant coach lineup approval. Run: node --test packages/shared/test/lineupApproval.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGameLive, lineupNeedsApproval } from '../dist/index.js';

const now = { today: '2026-10-17', minutes: 9 * 60 + 40 }; // 9:40am on game day

test('a game is live from 30 minutes before kick-off on game day', () => {
  assert.equal(isGameLive({ date: '2026-10-17', kickoff: '10:00', clockRunning: false }, now), true);
  assert.equal(isGameLive({ date: '2026-10-17', kickoff: '11:00', clockRunning: false }, now), false);
  assert.equal(isGameLive({ date: '2026-10-17', kickoff: null, clockRunning: false }, now), true);
  assert.equal(isGameLive({ date: '2026-10-24', kickoff: '09:00', clockRunning: false }, now), false);
  assert.equal(isGameLive({ date: null, kickoff: null, clockRunning: false }, now), false);
});

test('a running match clock makes the game live whatever the date', () => {
  assert.equal(isGameLive({ date: '2026-10-24', kickoff: '09:00', clockRunning: true }, now), true);
});

test('only an assistant waits for approval, and only before the game unless the coach allowed it', () => {
  assert.equal(lineupNeedsApproval('assistant', false, false), true);
  assert.equal(lineupNeedsApproval('assistant', true, false), false);
  assert.equal(lineupNeedsApproval('assistant', false, true), false);
  for (const role of ['coach', 'org_admin', 'director', 'region_admin']) {
    assert.equal(lineupNeedsApproval(role, false, false), false, role);
  }
});
