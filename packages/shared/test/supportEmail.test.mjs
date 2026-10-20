/**
 * Email to support. Run: node --test packages/shared/test/supportEmail.test.mjs
 * (build the package first so dist/ is current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEmailSubject, findTicketTag, isAutomatedSender, newPartOfEmail, ticketTag } from '../dist/index.js';

test('a ticket is tagged by the first 8 characters of its id', () => {
  assert.equal(ticketTag('7DE1C4B6-332b-498d-9ce6-c7f62b16917a'), '[#7de1c4b6]');
  assert.equal(findTicketTag('Re: App is slow [#7de1c4b6]'), '7de1c4b6');
  assert.equal(findTicketTag('RE: [#ABCDEF12] hello'), 'abcdef12');
  assert.equal(findTicketTag('No tag here [#123]'), null);
  assert.equal(findTicketTag(undefined), null);
});

test('subjects lose Re:, Fwd: and the tag', () => {
  assert.equal(cleanEmailSubject('Re: Fwd: RE: Calendar is slow [#7de1c4b6]'), 'Calendar is slow');
  assert.equal(cleanEmailSubject(''), 'Email to support');
  assert.equal(cleanEmailSubject('x'.repeat(200)).length, 120);
});

test('only the new part of a reply is kept', () => {
  const gmail = 'Thanks, that worked!\n\nOn Fri, Oct 16, 2026 at 9:00 AM Lineup <noreply@mahoul.io> wrote:\n> Hi there\n> old text';
  assert.equal(newPartOfEmail(gmail), 'Thanks, that worked!');
  const outlook = 'Still broken.\r\n\r\nFrom: Lineup <noreply@mahoul.io>\r\nSent: Friday, October 16, 2026 9:00 AM\r\nTo: me\r\nOld';
  assert.equal(newPartOfEmail(outlook), 'Still broken.');
  assert.equal(newPartOfEmail('Line one\n> quoted\nLine two\n-- \nSignature'), 'Line one\nLine two');
  assert.equal(newPartOfEmail('a'.repeat(5000)).length, 4000);
});

test('robots, bounces and our own addresses never get an automatic reply', () => {
  assert.equal(isAutomatedSender('coach@example.com'), false);
  for (const a of ['noreply@example.com', 'no-reply@x.org', 'MAILER-DAEMON@mail.example.com', 'postmaster@x.org', 'support@mahoul.io', 'not an email']) {
    assert.equal(isAutomatedSender(a), true, a);
  }
  assert.equal(isAutomatedSender('coach@example.com', { autoSubmitted: 'auto-replied' }), true);
  assert.equal(isAutomatedSender('coach@example.com', { autoSubmitted: 'no' }), false);
  assert.equal(isAutomatedSender('coach@example.com', { precedence: 'bulk' }), true);
});
