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

/** The U-age of an age group such as 'BU10' or 'CU8' (null when there is none). */
export function divisionAge(division: string | null | undefined): number | null {
  const m = /U(\d{1,2})$/i.exec(division ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The age groups offered when setting up a team (Shadi, 10/21), as AYSO
 * leagues on MatchTrak run them: region play in two-year bands (U6, U8, U10,
 * U12, U14, U16, U19) and the single years U9, U11 and U13 that Extra and
 * Section play adds. A child can always play up into an older group.
 */
export const TEAM_AGE_GROUPS: readonly number[] = [6, 8, 9, 10, 11, 12, 13, 14, 16, 19];

/** Is this age group one teams are set up with? (Teams already on another keep it.) */
export function isTeamAgeGroup(ageU: number): boolean {
  return TEAM_AGE_GROUPS.includes(ageU);
}

/** A team's gender: its own, else its age group's letter (B, G or C), else unknown. */
export function teamGender(team: { gender?: string | null; division?: string | null }): 'boys' | 'girls' | 'coed' | null {
  if (team.gender === 'boys' || team.gender === 'girls' || team.gender === 'coed') return team.gender;
  const letter = (team.division ?? '').charAt(0).toUpperCase();
  return letter === 'B' ? 'boys' : letter === 'G' ? 'girls' : letter === 'C' ? 'coed' : null;
}

/**
 * May a signed-up child go on this team (Shadi, 10/21)? A boys' team takes
 * boys and a girls' team girls; a coed team (or one with no gender) takes
 * both. A child plays in their own age group or older ("play up"): a U9 can
 * go on a U9 or a U10 team, since leagues often have only U8, U10 and U12;
 * never younger. A team with no age group takes any age.
 */
export function placementCheck(
  child: { gender: 'boys' | 'girls'; division: string },
  team: { gender?: string | null; division?: string | null },
): { ok: true; playsUp: boolean } | { ok: false; reason: string } {
  const g = teamGender(team);
  if (g === 'boys' && child.gender !== 'boys') return { ok: false, reason: 'boys only' };
  if (g === 'girls' && child.gender !== 'girls') return { ok: false, reason: 'girls only' };
  const teamU = divisionAge(team.division);
  const childU = divisionAge(child.division);
  if (teamU !== null && childU !== null && teamU < childU) return { ok: false, reason: `a U${childU} can't play down` };
  return { ok: true, playsUp: teamU !== null && childU !== null && teamU > childU };
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

/**
 * Team types (Shadi, 10/21): a league's teams are not all alike, so a team can
 * carry a type, picked from these or typed in.
 */
export const TEAM_TYPE_SUGGESTIONS: readonly string[] = [
  'Core', 'Extra', 'All Stars', 'Select', 'Academy', 'MLS Next', 'MLS Next 2', 'NCL', 'ECNL', 'ECNL RL', 'Futsal',
];

/** A team type from a request: trimmed, at most 30 characters, or null for none. */
export function cleanTeamType(raw: unknown): string | null {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return v || null;
}