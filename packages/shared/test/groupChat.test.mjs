/**
 * Group chats (Shadi, 10/21). Run with: node --test packages/shared/test/groupChat.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGroupChat, cleanEndDate, groupChatOpen, groupChatAudience } from '../dist/groupChat.js';

const TODAY = '2026-10-21';

test('cleanGroupChat tidies the form', () => {
  const ok = cleanGroupChat(
    {
      name: '  BU10   coaches ',
      roles: ['coach', 'assistant', 'bogus', 'coach'],
      divisions: ['bu10', 'nope'],
      teamIds: ['3C620B63-0000-4000-8000-000000000000', 'x'],
      customRoleIds: [],
      endsOn: '2026-11-30',
    },
    TODAY,
  );
  assert.deepEqual(ok, {
    name: 'BU10 coaches',
    roles: ['coach', 'assistant'],
    divisions: ['BU10'],
    teamIds: ['3c620b63-0000-4000-8000-000000000000'],
    customRoleIds: [],
    endsOn: '2026-11-30',
  });
});

test('a chat needs a name and people', () => {
  assert.ok('error' in cleanGroupChat({ name: '', roles: ['coach'] }, TODAY));
  assert.ok('error' in cleanGroupChat({ name: 'x', roles: [] }, TODAY));
  assert.ok('error' in cleanGroupChat({ name: 'x'.repeat(61), roles: ['coach'] }, TODAY));
  // A custom role alone is enough.
  const r = cleanGroupChat({ name: 'Directors', customRoleIds: ['3c620b63-0000-4000-8000-000000000000'] }, TODAY);
  assert.ok(!('error' in r));
});

test('end dates are optional, valid and not in the past', () => {
  assert.equal(cleanEndDate('', TODAY), null);
  assert.equal(cleanEndDate(null, TODAY), null);
  assert.equal(cleanEndDate(TODAY, TODAY), TODAY);
  assert.ok(typeof cleanEndDate('2026-10-20', TODAY) === 'object');
  assert.ok(typeof cleanEndDate('10/30/2026', TODAY) === 'object');
});

test('open until archived or past its last day', () => {
  assert.equal(groupChatOpen({ archivedAt: null, endsOn: null }, TODAY), true);
  assert.equal(groupChatOpen({ archivedAt: null, endsOn: TODAY }, TODAY), true);
  assert.equal(groupChatOpen({ archivedAt: null, endsOn: '2026-10-20' }, TODAY), false);
  assert.equal(groupChatOpen({ archivedAt: '2026-10-21T10:00:00Z', endsOn: null }, TODAY), false);
});

test('audience reads naturally', () => {
  assert.equal(groupChatAudience(['coach']), 'Coaches');
  assert.equal(groupChatAudience(['team_parent', 'coach'], ['BU10 Director']), 'Coaches, Team parents and BU10 Director');
  assert.equal(groupChatAudience(['admins']), 'Admins and directors');
});

test('parents are never a group chat role', () => {
  const r = cleanGroupChat({ name: 'x', roles: ['parent', 'coach'] }, TODAY);
  assert.deepEqual(r.roles, ['coach']);
  assert.ok('error' in cleanGroupChat({ name: 'x', roles: ['parent'] }, TODAY));
});
