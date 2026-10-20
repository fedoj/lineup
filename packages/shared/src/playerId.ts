/**
 * Player IDs in organizations and regions: "AvaG001". The child's first name,
 * the initial of the last name of the parent who signed the child up, and a
 * number counting up from 001 for that name, unique within the organization.
 * Without a parent's last name it is just the first name: "Ava001".
 */

/** The first word of a name, capitalised: "ava marie" -> "Ava". */
export function firstNameOf(name: string | null | undefined): string {
  const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? first.charAt(0).toLocaleUpperCase() + first.slice(1) : '';
}

/** The initial of the last word of a full name, or '' for a single word. */
export function lastInitialOf(fullName: string | null | undefined): string {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return '';
  const last = words[words.length - 1].replace(/[^\p{L}]/gu, '');
  return last ? last.charAt(0).toLocaleUpperCase() : '';
}

/** The parent's last initial ("Maria Garcia" -> "G"); '' when unknown or an email. */
export function parentInitial(parentName: string | null | undefined): string {
  return parentName && !parentName.includes('@') ? lastInitialOf(parentName) : '';
}

/** The letters an ID starts with: "AvaG", or "Ava" without a parent's last name. */
export function playerIdBase(playerName: string, parentName?: string | null): string {
  const first = firstNameOf(playerName).replace(/[^\p{L}]/gu, '') || 'Player';
  return first + parentInitial(parentName);
}

export function formatPlayerId(base: string, num: number): string {
  return `${base}${String(num).padStart(3, '0')}`;
}

/** One more than the highest number already used with this base (any case), from 1. */
export function nextPlayerNumber(base: string, taken: Iterable<string>): number {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{3,})$`, 'iu');
  let max = 0;
  for (const id of taken) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}