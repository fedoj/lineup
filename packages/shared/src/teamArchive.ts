/**
 * Team archive (Fady, 10/16): a team is archived whenever its coach or staff
 * like, which makes it read-only; it can be brought back for 1 month.
 */

/** How long an archived team can be brought back. */
export const TEAM_RESTORE_DAYS = 30;

/** The last moment an archived team can be brought back, as an ISO timestamp. */
export function teamRestoreUntil(archivedAt: string | Date): string {
  const at = typeof archivedAt === 'string' ? new Date(archivedAt) : archivedAt;
  return new Date(at.getTime() + TEAM_RESTORE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Can a team archived at `archivedAt` still be brought back at `now`? */
export function canRestoreTeam(archivedAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!archivedAt) return false;
  return now.getTime() <= new Date(teamRestoreUntil(archivedAt)).getTime();
}
