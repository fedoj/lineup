/**
 * Tournament brackets. Run: node --test packages/shared/test/bracket.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bracketSize, buildBracket, resolveBracket, roundName, seedOrder } from '../dist/index.js';

const team = (n) => ({ teamId: `t${n}`, name: `Team ${n}` });

test('seeds meet in the standard order', () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.equal(bracketSize(5), 8);
  assert.equal(bracketSize(2), 2);
  assert.equal(bracketSize(16), 16);
});

test('five teams: three byes go to the top seeds', () => {
  const b = buildBracket([1, 2, 3, 4, 5].map(team), true);
  const r1 = b.filter((m) => m.round === 1);
  assert.equal(r1.length, 4);
  assert.deepEqual(r1.map((m) => [m.home?.name ?? null, m.away?.name ?? null]), [
    ['Team 1', null],
    ['Team 4', 'Team 5'],
    ['Team 2', null],
    ['Team 3', null],
  ]);
  assert.equal(b.filter((m) => m.round === 2).length, 2);
  assert.equal(b.filter((m) => m.round === 3 && !m.thirdPlace).length, 1);
  assert.equal(b.filter((m) => m.thirdPlace).length, 1);
  assert.throws(() => buildBracket([team(1)], false));
});

test('winners move on, byes go through, draws wait for a winner by hand', () => {
  const built = buildBracket([1, 2, 3, 4, 5].map(team), true);
  const matches = built.map((m, i) => ({ ...m, id: `m${i}`, winnerOverride: null, result: null }));
  // Round one: 4 beats 5.
  matches.find((m) => m.round === 1 && m.slot === 1).result = { home: 2, away: 1 };
  let out = resolveBracket(matches);
  const semi0 = out.find((m) => m.round === 2 && m.slot === 0);
  assert.equal(semi0.home.name, 'Team 1');
  assert.equal(semi0.away.name, 'Team 4');
  assert.equal(out.find((m) => m.round === 1 && m.slot === 0).decidedBy, 'bye');

  // Semi-finals: 1 and 4 draw (needs a winner), 2 beats 3.
  matches.find((m) => m.round === 2 && m.slot === 0).result = { home: 1, away: 1 };
  matches.find((m) => m.round === 2 && m.slot === 1).result = { home: 0, away: 3 };
  out = resolveBracket(matches);
  const final = out.find((m) => m.round === 3 && !m.thirdPlace);
  assert.equal(final.home, null);
  assert.equal(final.away.name, 'Team 3');

  matches.find((m) => m.round === 2 && m.slot === 0).winnerOverride = 'away';
  out = resolveBracket(matches);
  const final2 = out.find((m) => m.round === 3 && !m.thirdPlace);
  assert.equal(final2.home.name, 'Team 4');
  const third = out.find((m) => m.thirdPlace);
  assert.equal(third.home.name, 'Team 1');
  assert.equal(third.away.name, 'Team 2');
  assert.equal(out.find((m) => m.round === 2 && m.slot === 0).decidedBy, 'hand');
});

test('round names', () => {
  assert.equal(roundName(3, 3), 'Final');
  assert.equal(roundName(2, 3), 'Semi-finals');
  assert.equal(roundName(1, 3), 'Quarter-finals');
  assert.equal(roundName(1, 4), 'Round of 16');
  assert.equal(roundName(3, 3, true), 'Third place');
});

import { groupPlaces, groupTable, makeGroups, placeName, roundRobin } from '../dist/index.js';

test('groups are filled snake style and never left with one team', () => {
  assert.deepEqual(makeGroups([1, 2, 3, 4, 5, 6, 7, 8], 4), [[1, 4, 5, 8], [2, 3, 6, 7]]);
  assert.deepEqual(makeGroups([1, 2, 3, 4, 5], 4), [[1, 4, 5], [2, 3]]);
  assert.deepEqual(makeGroups([1, 2, 3], 4), [[1, 2, 3]]);
  assert.equal(makeGroups(Array.from({ length: 12 }, (_, i) => i), 3).length, 4);
  assert.throws(() => makeGroups([1, 2], 4));
});

test('round robin: everyone plays everyone once', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    const games = roundRobin(n);
    assert.equal(games.length, (n * (n - 1)) / 2, `n=${n}`);
    const pairs = new Set(games.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join('-')));
    assert.equal(pairs.size, games.length);
    // Nobody plays twice on one matchday.
    const byDay = new Map();
    for (const [a, b, d] of games) {
      const seen = byDay.get(d) ?? new Set();
      assert.ok(!seen.has(a) && !seen.has(b));
      seen.add(a).add(b);
      byDay.set(d, seen);
    }
  }
});

test('group table: points, then goal difference; complete when every result is in', () => {
  const t = groupTable(['A', 'B', 'C'], [
    { home: 0, away: 1, result: { home: 2, away: 0 } },
    { home: 1, away: 2, result: { home: 1, away: 1 } },
    { home: 2, away: 0, result: { home: 0, away: 3 } },
  ]);
  assert.deepEqual(t.rows.map((r) => [r.entry, r.pts, r.gd]), [['A', 6, 5], ['B', 1, -2], ['C', 1, -3]]);
  assert.equal(t.complete, true);
  assert.equal(groupTable(['A', 'B'], [{ home: 0, away: 1, result: null }]).complete, false);
});

test('group places and names', () => {
  assert.deepEqual(groupPlaces(2, 2), ['A1', 'B1', 'A2', 'B2']);
  assert.equal(placeName('A1'), 'Winner Group A');
  assert.equal(placeName('B2'), '2nd Group B');
});
