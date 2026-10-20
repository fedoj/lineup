/**
 * Countries for the player card.
 * Run: node --test packages/shared/test/countries.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRY_CODES, HOME_COUNTRY, cleanCountry, flagEmoji } from '../dist/countries.js';

test('country codes are clean and unique', () => {
  assert.equal(new Set(COUNTRY_CODES).size, COUNTRY_CODES.length);
  assert.ok(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c)));
  assert.ok(COUNTRY_CODES.includes(HOME_COUNTRY));
});

test('cleanCountry accepts real codes only', () => {
  assert.equal(cleanCountry('eg'), 'EG');
  assert.equal(cleanCountry(' mx '), 'MX');
  assert.equal(cleanCountry('ZZ'), null);
  assert.equal(cleanCountry(''), null);
  assert.equal(cleanCountry(null), null);
});

test('flagEmoji builds the regional indicator pair', () => {
  assert.equal(flagEmoji('US'), '\u{1F1FA}\u{1F1F8}');
  assert.equal(flagEmoji('eg'), '\u{1F1EA}\u{1F1EC}');
  assert.equal(flagEmoji('nope'), '');
});
