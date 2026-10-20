/**
 * Referee spots and codes. Run with: node --test packages/shared/test/referee.test.mjs
 * (build the package first).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFEREE_SLOTS, cleanRefereeCode, isRefereeSlot, isValidRefereeCode, newRefereeCode } from '../dist/referee.js';

test('a main referee and two assistants', () => {
  assert.deepEqual([...REFEREE_SLOTS], ['main', 'ar1', 'ar2']);
  assert.ok(isRefereeSlot('ar2'));
  assert.ok(!isRefereeSlot('ar3'));
  assert.ok(!isRefereeSlot(null));
});

test('codes are cleaned and checked', () => {
  assert.equal(cleanRefereeCode(' ref-7kx2 qpm '), 'REF7KX2QPM');
  assert.ok(isValidRefereeCode('REF7KX2QPM'));
  assert.ok(!isValidRefereeCode('AB12'));
  assert.ok(!isValidRefereeCode('ABCDEFGHJKLMN'));
});

test('new codes are 8 easy-to-read characters', () => {
  const code = newRefereeCode();
  assert.ok(isValidRefereeCode(code));
  assert.equal(code.length, 8);
  assert.ok(!/[01IO]/.test(code));
  assert.equal(newRefereeCode(() => 0), 'AAAAAAAA');
});

test('the referee score counts own goals for the other side', async () => {
  const { refScore } = await import('../dist/referee.js');
  assert.deepEqual(refScore([]), { home: 0, away: 0 });
  assert.deepEqual(
    refScore([
      { side: 'home', kind: 'goal' },
      { side: 'home', kind: 'goal' },
      { side: 'away', kind: 'goal' },
      { side: 'away', kind: 'own_goal' },
      { side: 'home', kind: 'yellow' },
      { side: 'away', kind: 'sub' },
    ]),
    { home: 3, away: 1 },
  );
});

test('the game minute runs on across periods, starting at 1', async () => {
  const { refMinute } = await import('../dist/referee.js');
  assert.equal(refMinute(0, 0, 720), 1);
  assert.equal(refMinute(0, 59, 720), 1);
  assert.equal(refMinute(0, 60, 720), 2);
  // Second quarter of 12 minutes, 30 seconds in: minute 13.
  assert.equal(refMinute(1, 30, 720), 13);
  assert.equal(refMinute(9, 99999, 720), 200);
});

test('typed minutes and final scores are checked', async () => {
  const { cleanRefMinute, cleanRefScore } = await import('../dist/referee.js');
  assert.equal(cleanRefMinute(''), null);
  assert.equal(cleanRefMinute('34'), 34);
  assert.ok('error' in cleanRefMinute(0));
  assert.ok('error' in cleanRefMinute(2.5));
  assert.deepEqual(cleanRefScore('2', 1), { home: 2, away: 1 });
  assert.ok('error' in cleanRefScore(-1, 0));
  assert.ok('error' in cleanRefScore(1, ''));
});

test('who played: the starters and everyone subbed on', async () => {
  const { playersWhoPlayed, isRefEventKind, isRefPlayerStatus } = await import('../dist/referee.js');
  assert.deepEqual([...playersWhoPlayed(['a', 'b'], ['c', null, 'a'])].sort(), ['a', 'b', 'c']);
  assert.ok(isRefEventKind('own_goal'));
  assert.ok(!isRefEventKind('corner'));
  assert.ok(isRefPlayerStatus('bench'));
  assert.ok(!isRefPlayerStatus('injured'));
});
