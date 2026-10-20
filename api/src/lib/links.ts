/**
 * Links inside notifications. The app opens them in place: the right team,
 * the right screen, and on the Calendar the right item, which is shown and
 * scrolled to.
 *
 *   /calendar?team=<id>&focus=game:<id> | practice:<id> | event:<id> | snacks | practices
 *   /chat?team=<id>&channel=all | staff | coaches
 *   /?team=<id>            a team's home (standings)
 *   /settings?region=<id>  a region's settings, or org=<id>
 *   /signups?region=<id>   a region's sign-ups: join code, players to place, invites
 */

export function calendarLink(teamId: string, focus?: string | null): string {
  const q = new URLSearchParams({ team: teamId });
  if (focus) q.set('focus', focus);
  return `/calendar?${q.toString()}`;
}

export function chatLink(teamId: string, channel: string): string {
  return `/chat?${new URLSearchParams({ team: teamId, channel }).toString()}`;
}

export function teamLink(teamId: string): string {
  return `/?${new URLSearchParams({ team: teamId }).toString()}`;
}

/**
 * The same calendar link built in SQL, for notifications sent to several
 * teams at once: pass the expression holding each row's team id.
 */
export function calendarLinkSql(teamIdExpr: string, focus: string): string {
  return `('/calendar?team=' || ${teamIdExpr} || '&focus=' || ${focus})`;
}
