/**
 * Player IDs ("AvaG001"). Run with: node --test packages/shared/test/playerId.test.mjs
 * (build the package first).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstNameOf, formatPlayerId, lastInitialOf, nextPlayerNumber, parentInitial, playerIdBase } from '../dist/playerId.js';

test('first name and the parent last initial', () => {
  assert.equal(firstNameOf('ava marie'), 'Ava');
  assert.equal(firstNameOf('  Ben  '), 'Ben');
  assert.equal(lastInitialOf('Maria Garcia'), 'G');
  assert.equal(lastInitialOf('Maria'), '');
  assert.equal(parentInitial('Maria Garcia'), 'G');
  assert.equal(parentInitial('parent@example.com'), '');
  assert.equal(parentInitial(null), '');
});

test('the ID is the first name, the parent initial and 001', () => {
  assert.equal(playerIdBase('Ava', 'Maria Garcia'), 'AvaG');
  // No parent last name: just the first name, never the player's own last name.
  assert.equal(playerIdBase('Ava Lopez', null), 'Ava');
  assert.equal(playerIdBase('Ava', 'Maria'), 'Ava');
  assert.equal(playerIdBase('mary-jane', null), 'Maryjane');
  assert.equal(playerIdBase('', null), 'Player');
  assert.equal(formatPlayerId('AvaG', 1), 'AvaG001');
  assert.equal(formatPlayerId('Ava', 12), 'Ava012');
  assert.equal(formatPlayerId('Ava', 1000), 'Ava1000');
});

test('numbers count up from 001 for each name', () => {
  assert.equal(nextPlayerNumber('Ava', []), 1);
  assert.equal(nextPlayerNumber('Ava', ['Ava001', 'ava002', 'AvaG007', 'Ben001']), 3);
  assert.equal(nextPlayerNumber('AvaG', ['Ava001', 'AvaG001']), 2);
  // "Avag" and "AvaG" are the same ID in any case, so they share one count.
  assert.equal(nextPlayerNumber('Avag', ['AvaG001']), 2);
});
