import type { AuthedUser } from './auth.js';

/**
 * Configured lists of trusted accounts.
 *
 * Entries are Entra object ids (the stable `sub`) or email addresses. The CIAM
 * tenant does not emit an email claim, so object ids are the reliable form —
 * email only matches when a token happens to carry one. Lists come from Key
 * Vault via infra/set-settings.cjs and never live in source.
 */
function entries(settingName: string): string[] {
  return (process.env[settingName] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function onAllowlist(user: AuthedUser, settingName: string): boolean {
  const list = entries(settingName);
  if (list.length === 0) return false;
  const subject = user.subject?.toLowerCase();
  const email = user.email?.toLowerCase();
  return list.some((e) => e === subject || (Boolean(email) && e === email));
}

/**
 * Admin portal access. The same accounts are the testers whose support
 * requests Scout is allowed to pick up and remediate.
 */
export function isAdminAllowlisted(user: AuthedUser): boolean {
  return onAllowlist(user, 'ADMIN_ALLOWLIST');
}
