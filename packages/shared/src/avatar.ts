/**
 * Player avatars (Fady, 10/16): a cartoon a parent designs for their child,
 * drawn by the app (never a photo of a child). It shows on the player card.
 * Only a parent linked to the player (player_guardian) changes it, whatever
 * other role they hold on the team.
 *
 * Drawn with the Lorelei avatar art (DiceBear, by Lisa Wischofsky, CC0) since
 * 10/20: the hairstyles are its 48 (h01..h48), recolored with the hair color.
 */

export const AVATAR_OPTIONS = {
  skin: ['s1', 's2', 's3', 's4', 's5', 's6'],
  face: ['oval', 'round', 'square', 'heart'],
  // prettier-ignore
  hair: ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19', 'h20', 'h21', 'h22', 'h23', 'h24', 'h25', 'h26', 'h27', 'h28', 'h29', 'h30', 'h31', 'h32', 'h33', 'h34', 'h35', 'h36', 'h37', 'h38', 'h39', 'h40', 'h41', 'h42', 'h43', 'h44', 'h45', 'h46', 'h47', 'h48'],
  hairColor: ['black', 'brown', 'blonde', 'red', 'auburn', 'gray', 'blue', 'pink'],
  eyes: ['round', 'almond', 'smile'],
  eyeColor: ['brown', 'blue', 'green', 'hazel', 'gray'],
  glasses: ['none', 'round', 'square', 'sport'],
  /** Girls only (Fady, 10/20): sparkles in the hair, and rosier cheeks. */
  glitter: ['none', 'glitter'],
  cheeks: ['natural', 'rosy'],
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
  glitter: 'Hair glitter',
  cheeks: 'Cheeks',
};

/** Choices only girls get; a boy's are always the plain ones (Fady, 10/20). */
export const GIRL_ONLY_PARTS: readonly AvatarPart[] = ['glitter', 'cheeks'];

export const DEFAULT_AVATAR: Avatar = {
  skin: 's2',
  face: 'oval',
  hair: 'h03',
  hairColor: 'brown',
  eyes: 'round',
  eyeColor: 'brown',
  glasses: 'none',
  glitter: 'none',
  cheeks: 'natural',
};

/** Hairstyles saved before 10/20, by name, and the Lorelei hairstyle closest to each. */
export const LEGACY_HAIR: Readonly<Record<string, Avatar['hair']>> = {
  short: 'h03',
  buzz: 'h47',
  curly: 'h39',
  long: 'h21',
  ponytail: 'h29',
  afro: 'h24',
  spiky: 'h20',
  bald: 'h25',
};

/** The avatar shown until a parent designs one: girls start with long hair and a slimmer face (Fady, 10/20). */
export function defaultAvatarFor(gender?: string | null): Avatar {
  return gender === 'girl' ? { ...DEFAULT_AVATAR, hair: 'h35', face: 'heart' } : DEFAULT_AVATAR;
}

/** Girls-only choices back to plain for anyone who is not a girl. */
export function avatarForGender(a: Avatar, gender?: string | null): Avatar {
  if (gender === 'girl') return a;
  const out = { ...a } as Record<AvatarPart, string>;
  for (const part of GIRL_ONLY_PARTS) out[part] = DEFAULT_AVATAR[part];
  return out as Avatar;
}

/** A saved avatar with every part valid; unknown or missing parts fall back to the default. */
export function cleanAvatar(raw: unknown): Avatar {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_AVATAR } as Record<AvatarPart, string>;
  for (const part of Object.keys(AVATAR_OPTIONS) as AvatarPart[]) {
    const v = part === 'hair' && typeof src.hair === 'string' ? (LEGACY_HAIR[src.hair] ?? src.hair) : src[part];
    if (typeof v === 'string' && (AVATAR_OPTIONS[part] as readonly string[]).includes(v)) out[part] = v;
  }
  return out as Avatar;
}
