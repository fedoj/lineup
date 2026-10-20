/**
 * Team chat rules. Run with: node --test packages/shared/test/chat.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPollVote, canDeleteChatMessage, canEditChatMessage, chatChannelsForRole, cleanChatPoll, cleanChatVote } from '../dist/chat.js';
import { hasFeature } from '../dist/entitlements.js';

test('each role sees only its chats', () => {
  assert.deepEqual(chatChannelsForRole('coach'), ['all', 'staff', 'coaches']);
  assert.deepEqual(chatChannelsForRole('assistant'), ['all', 'staff', 'coaches']);
  assert.deepEqual(chatChannelsForRole('team_parent'), ['all', 'staff']);
  assert.deepEqual(chatChannelsForRole('parent'), ['all']);
  assert.deepEqual(chatChannelsForRole('viewer'), []);
  // Organization and region staff drop in rather than belong.
  assert.deepEqual(chatChannelsForRole('region_admin'), []);
});

test('edit for 10 minutes, own messages, paid plans only', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const sent = (min) => new Date(now.getTime() - min * 60_000);
  assert.equal(canEditChatMessage({ isAuthor: true, paid: true, createdAt: sent(9), now }), true);
  assert.equal(canEditChatMessage({ isAuthor: true, paid: true, createdAt: sent(11), now }), false);
  assert.equal(canEditChatMessage({ isAuthor: false, paid: true, createdAt: sent(1), now }), false);
  assert.equal(canEditChatMessage({ isAuthor: true, paid: false, createdAt: sent(1), now }), false);
});

test('delete only until someone reacts or replies, paid plans only', () => {
  assert.equal(canDeleteChatMessage({ isAuthor: true, paid: true, reactions: 0, replies: 0 }), true);
  assert.equal(canDeleteChatMessage({ isAuthor: true, paid: true, reactions: 1, replies: 0 }), false);
  assert.equal(canDeleteChatMessage({ isAuthor: true, paid: true, reactions: 0, replies: 1 }), false);
  assert.equal(canDeleteChatMessage({ isAuthor: true, paid: false, reactions: 0, replies: 0 }), false);
  assert.equal(canDeleteChatMessage({ isAuthor: false, paid: true, reactions: 0, replies: 0 }), false);
});

test('editing and deleting chat messages is on every paid plan, not free', () => {
  assert.equal(hasFeature('free', 'chatEditing'), false);
  for (const tier of ['parent', 'teamParent', 'coach', 'region', 'organization', 'organizationPlus']) {
    assert.equal(hasFeature(tier, 'chatEditing'), true, tier);
  }
});

test('creating chat polls is on every paid plan, not free', () => {
  assert.equal(hasFeature('free', 'chatPolls'), false);
  for (const tier of ['parent', 'teamParent', 'coach', 'region', 'organization', 'organizationPlus']) {
    assert.equal(hasFeature(tier, 'chatPolls'), true, tier);
  }
});

test('a poll needs a question and 2 to 6 different answers', () => {
  assert.deepEqual(cleanChatPoll({ question: '  Who can drive  Saturday? ', options: ['Me', ' ', 'Not me'] }), {
    question: 'Who can drive Saturday?',
    options: ['Me', 'Not me'],
    multi: false,
  });
  assert.equal(cleanChatPoll({ question: 'Q', options: ['A', 'B'], multi: true }).multi, true);
  assert.ok('error' in cleanChatPoll({ question: '', options: ['A', 'B'] }));
  assert.ok('error' in cleanChatPoll({ question: 'Q', options: ['A'] }));
  assert.ok('error' in cleanChatPoll({ question: 'Q', options: ['A', 'a'] }));
  assert.ok('error' in cleanChatPoll({ question: 'Q', options: ['1', '2', '3', '4', '5', '6', '7'] }));
  assert.ok('error' in cleanChatPoll({ question: 'x'.repeat(201), options: ['A', 'B'] }));
});

test('a vote picks existing answers, one unless the poll allows several', () => {
  assert.deepEqual(cleanChatVote([1], { options: 3, multi: false }), [1]);
  assert.deepEqual(cleanChatVote(2, { options: 3, multi: false }), [2]);
  assert.deepEqual(cleanChatVote([], { options: 3, multi: false }), []);
  assert.deepEqual(cleanChatVote([2, 0, 2], { options: 3, multi: true }), [0, 2]);
  assert.ok('error' in cleanChatVote([0, 1], { options: 3, multi: false }));
  assert.ok('error' in cleanChatVote([3], { options: 3, multi: true }));
});

test('photos in chat are on the family, coach and staff plans, not free', async () => {
  assert.equal(hasFeature('free', 'chatAttachments'), false);
  for (const tier of ['parent', 'teamParent', 'coach', 'region', 'organization', 'organizationPlus']) {
    assert.equal(hasFeature(tier, 'chatAttachments'), true, tier);
  }
});

test('a chat photo must be a small JPEG, PNG, WebP or GIF', async () => {
  const { parseChatImage, CHAT_IMAGE_MAX_BYTES } = await import('../dist/chat.js');
  assert.equal(parseChatImage(undefined), null);
  assert.deepEqual(parseChatImage('data:image/jpeg;base64,AAAA'), { mime: 'image/jpeg', base64: 'AAAA' });
  assert.ok('error' in parseChatImage('data:application/pdf;base64,AAAA'));
  assert.ok('error' in parseChatImage('data:image/svg+xml;base64,AAAA'));
  assert.ok('error' in parseChatImage('not a photo'));
  const big = 'A'.repeat(Math.ceil((CHAT_IMAGE_MAX_BYTES + 10) / 3) * 4);
  assert.ok('error' in parseChatImage('data:image/png;base64,' + big));
});

test('a vote shows at once: counts, ticks and voters move with it', () => {
  const poll = {
    options: [
      { text: 'Yes', votes: 2, voters: ['Ana', 'Ben'], mine: false },
      { text: 'No', votes: 1, voters: ['You'], mine: true },
    ],
    multi: false,
    voters: 3,
  };
  const yes = applyPollVote(poll, [0]);
  assert.deepEqual(yes.options.map((o) => [o.votes, o.mine]), [[3, true], [0, false]]);
  assert.deepEqual(yes.options[0].voters, ['Ana', 'Ben', 'You']);
  assert.deepEqual(yes.options[1].voters, []);
  assert.equal(yes.voters, 3);
  assert.equal(yes.multi, false);

  const none = applyPollVote(yes, []);
  assert.deepEqual(none.options.map((o) => o.votes), [2, 0]);
  assert.equal(none.voters, 2);

  const back = applyPollVote(none, [1]);
  assert.deepEqual(back.options.map((o) => [o.votes, o.mine]), [[2, false], [1, true]]);
  assert.equal(back.voters, 3);
  assert.equal(poll.options[1].votes, 1, 'the original poll is not changed');
});

test('a busy chat refreshes every 3 s and a quiet one slows to 30 s', async () => {
  const { chatRefreshDelay, CHAT_PHOTOS_PER_SEND } = await import('../dist/chat.js');
  assert.equal(chatRefreshDelay(0), 3000);
  assert.equal(chatRefreshDelay(59_000), 3000);
  assert.equal(chatRefreshDelay(61_000), 10_000);
  assert.equal(chatRefreshDelay(4 * 60_000), 20_000);
  assert.equal(chatRefreshDelay(60 * 60_000), 30_000);
  assert.equal(CHAT_PHOTOS_PER_SEND, 4);
});