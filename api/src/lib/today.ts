/**
 * Today's date for the app, as YYYY-MM-DD.
 *
 * The database's current_date and toISOString() are UTC, which turns over
 * at 5 PM in California: a game today would close for RSVP and show as
 * played that evening. Games are local, so "today" is Pacific time, where
 * US games end last (a game today never looks past anywhere in the US).
 */
export function appToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Minutes since midnight in the app's time zone (Pacific). */
export function appMinutesNow(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}
