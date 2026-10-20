/**
 * Fair-play and formation checks.
 * Run: node --test packages/shared/test/fairplay.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFairLineup,
  removeUnavailable,
  copyLineup,
  minutesFromAssignments,
  isGamePlayed,
  slotsForFormation,
  formationFits,
  formationNames,
  FORMATS,
  FORMAT_IDS,
  periodCount,
  periodLabels,
} from '../dist/index.js';

const squad = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `Player ${i + 1}`,
    available: true,
    ...over,
  }));

/* ----------------------------------------------------------- formations */

test('every formation fits its format', () => {
  for (const fmt of FORMAT_IDS) {
    for (const name of formationNames(fmt)) {
      assert.equal(formationFits(fmt, name), true, `${fmt} ${name}`);
    }
  }
});

test('slot count always equals on-pitch count', () => {
  for (const fmt of FORMAT_IDS) {
    for (const name of formationNames(fmt)) {
      const slots = slotsForFormation(fmt, name);
      assert.equal(slots.length, FORMATS[fmt].onPitch, `${fmt} ${name}`);
      assert.equal(slots.filter((s) => s.isKeeper).length, 1);
    }
  }
});

test('slot ids are unique and stable', () => {
  const a = slotsForFormation('7v7', '2-3-1').map((s) => s.id);
  const b = slotsForFormation('7v7', '2-3-1').map((s) => s.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.deepEqual(a, ['GK', 'DEF1', 'DEF2', 'MID1', 'MID2', 'MID3', 'FWD1']);
});

test('positions stay inside the pitch', () => {
  for (const fmt of FORMAT_IDS) {
    for (const name of formationNames(fmt)) {
      for (const s of slotsForFormation(fmt, name)) {
        assert.ok(s.x >= 0 && s.x <= 100, `${fmt} ${name} ${s.id} x=${s.x}`);
        assert.ok(s.y >= 0 && s.y <= 100, `${fmt} ${name} ${s.id} y=${s.y}`);
      }
    }
  }
});

test('unknown formation falls back to the format default', () => {
  const slots = slotsForFormation('9v9', 'nonsense');
  assert.equal(slots.length, 9);
});

test('period helpers', () => {
  assert.equal(periodCount('halves'), 2);
  assert.equal(periodCount('quarters'), 4);
  assert.deepEqual(periodLabels('halves'), ['1st half', '2nd half']);
  assert.equal(periodLabels('quarters').length, 4);
});

/* ------------------------------------------------------------ fair play */

test('every slot is filled when the squad is big enough', () => {
  const r = buildFairLineup({
    players: squad(11),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 7,
  });
  assert.equal(r.warnings.length, 0);
  for (let p = 0; p < 4; p++) {
    assert.equal(Object.keys(r.assignments[String(p)]).length, 7, `period ${p}`);
  }
});

test('nobody is on the pitch twice in the same period', () => {
  const r = buildFairLineup({
    players: squad(14),
    format: '9v9',
    periods: 4,
    formations: ['3-3-2'],
    seed: 3,
  });
  for (const slots of Object.values(r.assignments)) {
    const ids = Object.values(slots);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('playing time spread is at most one period', () => {
  for (const n of [8, 9, 10, 11, 12, 13, 14, 15]) {
    const r = buildFairLineup({
      players: squad(n),
      format: '7v7',
      periods: 4,
      formations: ['2-3-1'],
      seed: n,
    });
    assert.ok(r.spread <= 1, `squad ${n} gave spread ${r.spread}`);
  }
});

test('keeper duty is shared', () => {
  const r = buildFairLineup({
    players: squad(10),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 11,
  });
  const keeperCounts = r.fairness.map((f) => f.keeperPeriods);
  assert.ok(Math.max(...keeperCounts) <= 1, 'nobody keeps more than once');
  assert.equal(keeperCounts.reduce((a, b) => a + b, 0), 4);
});

test('neverKeeper is honoured', () => {
  const players = squad(10).map((p, i) => ({ ...p, neverKeeper: i < 9 }));
  const r = buildFairLineup({
    players,
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 5,
  });
  const keepers = r.fairness.filter((f) => f.keeperPeriods > 0).map((f) => f.playerId);
  assert.deepEqual(keepers, ['p10']);
});

test('absent players never appear', () => {
  const players = squad(12).map((p, i) => ({ ...p, available: i >= 3 }));
  const r = buildFairLineup({
    players,
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 2,
  });
  const used = new Set(Object.values(r.assignments).flatMap((s) => Object.values(s)));
  for (const absent of ['p1', 'p2', 'p3']) {
    assert.equal(used.has(absent), false, absent);
  }
  assert.equal(r.fairness.length, 9);
});

test('same seed gives the same lineup, different seed differs', () => {
  const base = { players: squad(11), format: '7v7', periods: 4, formations: ['2-3-1'] };
  const a = buildFairLineup({ ...base, seed: 42 });
  const b = buildFairLineup({ ...base, seed: 42 });
  const c = buildFairLineup({ ...base, seed: 99 });
  assert.deepEqual(a.assignments, b.assignments);
  assert.notDeepEqual(a.assignments, c.assignments);
});

test('different formation per period is honoured', () => {
  const r = buildFairLineup({
    players: squad(11),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1', '3-2-1', '2-2-2', '2-3-1'],
    seed: 8,
  });
  assert.ok('DEF3' in r.assignments['1'], 'Q2 uses a three-back shape');
  assert.equal('DEF3' in r.assignments['0'], false, 'Q1 does not');
  assert.ok('FWD2' in r.assignments['2'], 'Q3 uses two forwards');
});

test('too few players warns but still assigns what it can', () => {
  const r = buildFairLineup({
    players: squad(5),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 1,
  });
  assert.ok(r.warnings.some((w) => w.includes('Only 5 available')));
  assert.equal(Object.keys(r.assignments['0']).length, 5);
});

test('empty squad returns empty, not a crash', () => {
  const r = buildFairLineup({
    players: [],
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
  });
  assert.deepEqual(r.fairness, []);
  assert.ok(r.warnings.some((w) => w.includes('No available players')));
});

test('exactly enough players means nobody is benched', () => {
  const r = buildFairLineup({
    players: squad(7),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 4,
  });
  assert.equal(r.spread, 0);
  for (const f of r.fairness) {
    assert.equal(f.periodsPlayed, 4);
    assert.equal(f.periodsBenched, 0);
  }
});

test('nobody sits out two periods in a row with a modest squad', () => {
  const r = buildFairLineup({
    players: squad(9),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 6,
  });
  for (const f of r.fairness) {
    assert.ok(f.longestBenchRun <= 1, `${f.playerId} sat ${f.longestBenchRun} in a row`);
  }
});

test('prior playing time carries into a mid-game rebuild', () => {
  const players = squad(9);
  const r = buildFairLineup({
    players,
    format: '7v7',
    periods: 2,
    formations: ['2-3-1'],
    seed: 10,
    priorPlayed: { p1: 2, p2: 2, p3: 0, p4: 0 },
  });
  const byId = Object.fromEntries(r.fairness.map((f) => [f.playerId, f]));
  // p3 and p4 started behind, so they must play both remaining periods.
  assert.equal(byId.p3.periodsPlayed, 2);
  assert.equal(byId.p4.periodsPlayed, 2);
});

test('position variety is spread rather than fixed', () => {
  const r = buildFairLineup({
    players: squad(7),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 12,
  });
  const stuck = r.fairness.filter(
    (f) => Object.values(f.positions).some((c) => c === 4) && f.keeperPeriods < 4,
  );
  assert.equal(stuck.length, 0, 'no outfielder spends all four periods in one spot');
});

/* -------------------------------------------------------------- helpers */

test('removeUnavailable clears only the absent', () => {
  const r = buildFairLineup({
    players: squad(10),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 9,
  });
  const { assignments, removed } = removeUnavailable(r.assignments, ['p1', 'p2']);
  assert.ok(removed > 0);
  const used = new Set(Object.values(assignments).flatMap((s) => Object.values(s)));
  assert.equal(used.has('p1'), false);
  assert.equal(used.has('p2'), false);
});

test('copyLineup drops ineligible players and invalid slots', () => {
  const source = {
    '0': { GK: 'p1', DEF1: 'p2', DEF2: 'p3', MID1: 'p4', MID2: 'p5', MID3: 'p6', FWD1: 'p7' },
    '1': { GK: 'p2', DEF1: 'p1', DEF2: 'p3', MID1: 'p4', MID2: 'p5', MID3: 'p6', FWD1: 'p8' },
  };
  const { assignments, dropped } = copyLineup(source, {
    format: '7v7',
    formations: ['3-2-1'],
    periods: 2,
    eligiblePlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
  });
  assert.ok(dropped.includes('p7'));
  assert.ok(dropped.includes('p8'));
  // MID3 does not exist in 3-2-1, so that slot is gone.
  assert.equal('MID3' in assignments['0'], false);
  assert.equal(assignments['0'].GK, 'p1');
});

test('minutes are computed from assignments', () => {
  const r = buildFairLineup({
    players: squad(8),
    format: '7v7',
    periods: 4,
    formations: ['2-3-1'],
    seed: 13,
  });
  const mins = minutesFromAssignments(r.assignments, 600);
  const total = Object.values(mins).reduce((a, b) => a + b, 0);
  assert.equal(total, 7 * 4 * 600);
});

test('only past or scored games count as played', () => {
  const today = '2026-10-15';
  assert.equal(isGamePlayed('2026-10-10', 0, 0, today), true);
  assert.equal(isGamePlayed('2026-10-10', 2, 1, today), true);
  assert.equal(isGamePlayed('2026-10-15', 0, 0, today), false);
  assert.equal(isGamePlayed('2026-10-15', 1, 0, today), true);
  assert.equal(isGamePlayed('2026-10-24', 0, 0, today), false);
  assert.equal(isGamePlayed(null, 0, 0, today), false);
  assert.equal(isGamePlayed(null, 0, 3, today), true);
});

test('11v11 full squad works end to end', () => {
  const r = buildFairLineup({
    players: squad(18),
    format: '11v11',
    periods: 2,
    formations: ['4-3-3'],
    seed: 21,
  });
  assert.equal(r.onPitch, 11);
  assert.ok(r.spread <= 1);
  for (const slots of Object.values(r.assignments)) {
    assert.equal(Object.keys(slots).length, 11);
  }
});

import { dueSubs } from '../dist/index.js';

test('a sub during a period moves the rest of it to the player coming on', () => {
  const assignments = { 0: { gk: 'a', d1: 'b' }, 1: { gk: 'a', d1: 'c' } };
  const plain = minutesFromAssignments(assignments, 600);
  assert.deepEqual(plain, { a: 1200, b: 600, c: 600 });
  const subbed = minutesFromAssignments(assignments, 600, [{ periodIndex: 0, atSec: 200, offPlayerId: 'b', onPlayerId: 'c' }]);
  assert.deepEqual(subbed, { a: 1200, b: 200, c: 1000 });
  // A sub for someone who was not on the pitch, or onto someone already on, changes nothing.
  assert.deepEqual(minutesFromAssignments(assignments, 600, [{ periodIndex: 1, atSec: 100, offPlayerId: 'b', onPlayerId: 'd' }]), plain);
  assert.deepEqual(minutesFromAssignments(assignments, 600, [{ periodIndex: 0, atSec: 100, offPlayerId: 'b', onPlayerId: 'a' }]), plain);
});

test('planned subs are due once the clock reaches them', () => {
  const subs = [
    { id: 1, periodIndex: 0, atSec: 300, done: false, skipped: false },
    { id: 2, periodIndex: 0, atSec: 500, done: false, skipped: false },
    { id: 3, periodIndex: 0, atSec: 100, done: true, skipped: false },
    { id: 4, periodIndex: 1, atSec: 0, done: false, skipped: false },
  ];
  assert.deepEqual(dueSubs(subs, 0, 320).map((s) => s.id), [1]);
  assert.deepEqual(dueSubs(subs, 1, 0).map((s) => s.id), [4]);
});
