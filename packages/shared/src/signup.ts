/**
 * Family sign-up helpers: seasons, age groups, and the sign-up codes of
 * leagues and tournaments. (Region-wide join codes are gone, Fady 10/17-19.)
 */

/** Letters and digits only, upper case; accents are dropped (é -> E). */
export function cleanCode(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Soccer seasons run August to July: "2026-27" from August 2026. */
export function currentSeason(now = new Date()): string {
  const y = now.getFullYear();
  const start = now.getMonth() >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Suggested age group from the birth year (US Soccer birth-year rule: the
 * U-age is the year the season ends minus the birth year), e.g. 'BU10'.
 */
export function suggestedDivision(birthYear: number, gender: 'boys' | 'girls', season: string): string {
  const endYear = Number(season.slice(0, 4)) + 1;
  const u = Math.max(4, Math.min(19, endYear - birthYear));
  return `${gender === 'girls' ? 'G' : 'B'}U${u}`;
}

/* ---------------------------------------- league and tournament sign-ups */

export type RegistrationStatus = 'upcoming' | 'open' | 'closed';

/**
 * Sign-ups for a league or tournament (Fady, 10/17) take place between its
 * registration dates (YYYY-MM-DD, both days included). With no opening date
 * it is open straight away; with no closing date it closes when the league or
 * tournament ends.
 */
export function registrationStatus(
  opensOn: string | null | undefined,
  closesOn: string | null | undefined,
  endsOn: string,
  today: string,
): RegistrationStatus {
  if (opensOn && today < opensOn) return 'upcoming';
  const closes = closesOn || endsOn;
  return today > closes ? 'closed' : 'open';
}

/** Characters for sign-up codes: no 0/O or 1/I, so they read aloud cleanly. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A league's or tournament's sign-up code: a few letters of its name and four
 * random characters, e.g. "FALL-7KQ2".
 */
export function suggestCompetitionCode(name: string, random: () => number = Math.random): string {
  const head = cleanCode(name).replace(/\d+/g, '').slice(0, 6) || 'LEAGUE';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return `${head}-${tail}`;
}

/** A sign-up code as typed: upper case, letters, digits and one dash. */
export function cleanCompetitionCode(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24);
}
