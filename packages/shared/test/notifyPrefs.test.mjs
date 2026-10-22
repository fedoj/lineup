/**
 * Push settings and chat @mentions. Run with: node --test packages/shared/test/notifyPrefs.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanNotifyPrefs, DEFAULT_NOTIFY_PREFS, findMentions, notifyCategory, pushAllowed } from '../dist/notifyPrefs.js';

test('notifications are sorted by link and group', () => {
  assert.equal(notifyCategory('/calendar?team=t&focus=game:g1', null), 'game');
  assert.equal(notifyCategory('/calendar?team=t&focus=game%3Ag1', null), 'game');
  assert.equal(notifyCategory('/calendar?team=t&focus=practice:p1', null), 'practice');
  assert.equal(notifyCategory('/calendar?team=t&focus=practices', null), 'practice');
  assert.equal(notifyCategory('/calendar?team=t&focus=event:e1', null), 'event');
  assert.equal(notifyCategory('/chat?team=t&channel=all', 'chat:t:all'), 'chat');
  assert.equal(notifyCategory('/chat?team=t&channel=all', 'mention:t:all'), 'mention');
  assert.equal(notifyCategory('/calendar?team=t&focus=game:g1', 'lineup:g1'), 'game');
  assert.equal(notifyCategory('/calendar?team=t&focus=snacks', null), 'other');
  assert.equal(notifyCategory('/account', null), 'other');
});

test('settings decide what is pushed; other notices always are', () => {
  assert.equal(pushAllowed('game', null), true);
  const p = { games: false, practices: true, events: false, chat: 'mentions' };
  assert.equal(pushAllowed('game', p), false);
  assert.equal(pushAllowed('practice', p), true);
  assert.equal(pushAllowed('event', p), false);
  assert.equal(pushAllowed('chat', p), false);
  assert.equal(pushAllowed('mention', p), true);
  assert.equal(pushAllowed('other', p), true);
  assert.equal(pushAllowed('mention', { ...p, chat: 'off' }), false);
  assert.equal(pushAllowed('chat', { ...p, chat: 'all' }), true);
});

test('settings from a request keep what was not sent and reject junk', () => {
  assert.deepEqual(cleanNotifyPrefs({ games: false }), { ...DEFAULT_NOTIFY_PREFS, games: false });
  assert.deepEqual(cleanNotifyPrefs({ chat: 'mentions', events: 'no' }), { ...DEFAULT_NOTIFY_PREFS, chat: 'mentions' });
  assert.deepEqual(cleanNotifyPrefs({ chat: 'loud' }, { ...DEFAULT_NOTIFY_PREFS, chat: 'off' }).chat, 'off');
  assert.deepEqual(cleanNotifyPrefs(null), DEFAULT_NOTIFY_PREFS);
});

test('@mentions match people in the chat by name', () => {
  const people = [
    { id: 'a', name: 'Ann' },
    { id: 'b', name: 'Ann Lee' },
    { id: 'c', name: 'Coach Shadi' },
  ];
  assert.deepEqual(findMentions('Hi @Ann Lee, see you', people, false), { ids: ['b'], all: false });
  assert.deepEqual(findMentions('@ann and @Ann Lee', people, false).ids.sort(), ['a', 'b']);
  assert.deepEqual(findMentions('thanks @coach shadi!', people, false), { ids: ['c'], all: false });
  assert.deepEqual(findMentions('email ann@Ann.com', people, false), { ids: [], all: false });
  assert.deepEqual(findMentions('@Annie is here', people, false), { ids: [], all: false });
});

test('only staff can mention everyone', () => {
  assert.equal(findMentions('@everyone practice moved', [], true).all, true);
  assert.equal(findMentions('@everyone practice moved', [], false).all, false);
  assert.equal(findMentions('no one@everyone', [], true).all, false);
});
