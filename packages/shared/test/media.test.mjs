/**
 * Upload limits. Run: node --test packages/shared/test/media.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_IMAGE_MAX_BYTES, FLYER_MAX_BYTES, parseChatImage, sizeLabel } from '../dist/index.js';

test('photos and flyers are a quarter of what they were', () => {
  assert.equal(CHAT_IMAGE_MAX_BYTES, 256 * 1024);
  assert.equal(FLYER_MAX_BYTES, 512 * 1024);
});

test('size limits read the way people say them', () => {
  assert.equal(sizeLabel(256 * 1024), '0.25 MB');
  assert.equal(sizeLabel(512 * 1024), '0.5 MB');
  assert.equal(sizeLabel(3 * 1024 * 1024), '3 MB');
  assert.equal(sizeLabel(200 * 1024), '200 KB');
});

test('a chat photo over the limit is refused with the limit in the message', () => {
  const over = 'A'.repeat(Math.ceil((CHAT_IMAGE_MAX_BYTES + 3) / 3) * 4);
  const r = parseChatImage('data:image/jpeg;base64,' + over);
  assert.ok('error' in r);
  assert.match(r.error, /0\.25 MB/);
  const under = 'A'.repeat(Math.floor((CHAT_IMAGE_MAX_BYTES - 3) / 3) * 4);
  assert.ok(!('error' in parseChatImage('data:image/jpeg;base64,' + under)));
});
