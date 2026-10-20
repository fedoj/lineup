/**
 * Player avatars (Fady, 10/16): a cartoon a parent designs for their child,
 * drawn by the app (never a photo of a child). It shows on the player card.
 * Only a parent linked to the player (player_guardian) changes it, whatever
 * other role they hold on the team.
 */

export const AVATAR_OPTIONS = {
  skin: ['s1', 's2', 's3', 's4', 's5', 's6'],
  face: ['oval', 'round', 'square', 'heart'],
  hair: ['short', 'buzz', 'curly', 'long', 'ponytail', 'afro', 'spiky', 'bald'],
  hairColor: ['black', 'brown', 'blonde', 'red', 'auburn', 'gray', 'blue', 'pink'],
  eyes: ['round', 'almond', 'smile'],
  eyeColor: ['brown', 'blue', 'green', 'hazel', 'gray'],
  glasses: ['none', 'round', 'square', 'sport'],
} as const;

export type AvatarPart = keyof typeof AVATAR_OPTIONS;

export type Avatar = { [K in AvatarPart]: (typeof AVATAR_OPTIONS)[K][number] };

export const AVATAR_LABELS: Record<AvatarPart, string> = {
  skin: 'Skin tone',
  face: 'Face shape',
  hair: 'Hairstyle',
  hairColor: 'Hair color',
  eyes: 'Eyes',
  eyeColor: 'Eye color',
  glasses: 'Glasses',
};

export const DEFAULT_AVATAR: Avatar = {
  skin: 's2',
  face: 'oval',
  hair: 'short',
  hairColor: 'brown',
  eyes: 'round',
  eyeColor: 'brown',
  glasses: 'none',
};

/** A saved avatar with every part valid; unknown or missing parts fall back to the default. */
export function cleanAvatar(raw: unknown): Avatar {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_AVATAR } as Record<AvatarPart, string>;
  for (const part of Object.keys(AVATAR_OPTIONS) as AvatarPart[]) {
    const v = src[part];
    if (typeof v === 'string' && (AVATAR_OPTIONS[part] as readonly string[]).includes(v)) out[part] = v;
  }
  return out as Avatar;
}
