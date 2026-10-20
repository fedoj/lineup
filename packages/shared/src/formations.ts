/**
 * Formations — the catalog of playable shapes and the pitch geometry used to
 * render them.
 *
 * Ported from the v1 Apps Script app, with the slot generator rewritten so
 * positions are deterministic and addressable by id. The v1 version keyed
 * slots by array index, which breaks the moment a formation changes between
 * periods; here every slot carries a stable id so assignments survive a shape
 * change and can be diffed.
 */

export type Format = '5v5' | '7v7' | '9v9' | '11v11';
export type Periods = 'quarters' | 'halves';

export interface FormatSpec {
  /** Players on the pitch including the keeper. */
  onPitch: number;
  label: string;
  /** Formation name -> outfield line counts, back to front. */
  formations: Record<string, readonly number[]>;
  /** Shape a new team in this format starts with. */
  defaultFormation: string;
}

export const FORMATS: Record<Format, FormatSpec> = {
  '5v5': {
    onPitch: 5,
    label: '5 v 5',
    defaultFormation: '2-1-1',
    formations: {
      '2-1-1': [2, 1, 1],
      '1-2-1': [1, 2, 1],
      '2-2': [2, 2],
      '1-1-2': [1, 1, 2],
    },
  },
  '7v7': {
    onPitch: 7,
    label: '7 v 7',
    defaultFormation: '2-3-1',
    formations: {
      '2-3-1': [2, 3, 1],
      '3-2-1': [3, 2, 1],
      '2-1-2-1': [2, 1, 2, 1],
      '3-1-2': [3, 1, 2],
      '1-3-2': [1, 3, 2],
      '2-2-2': [2, 2, 2],
    },
  },
  '9v9': {
    onPitch: 9,
    label: '9 v 9',
    defaultFormation: '3-3-2',
    formations: {
      '3-3-2': [3, 3, 2],
      '3-2-3': [3, 2, 3],
      '2-3-3': [2, 3, 3],
      '3-4-1': [3, 4, 1],
      '4-3-1': [4, 3, 1],
      '3-1-3-1': [3, 1, 3, 1],
    },
  },
  '11v11': {
    onPitch: 11,
    label: '11 v 11',
    defaultFormation: '4-4-2',
    formations: {
      '4-4-2': [4, 4, 2],
      '4-3-3': [4, 3, 3],
      '3-5-2': [3, 5, 2],
      '4-2-3-1': [4, 2, 3, 1],
      '5-3-2': [5, 3, 2],
      '4-5-1': [4, 5, 1],
    },
  },
};

export const FORMAT_IDS = Object.keys(FORMATS) as Format[];

/** Line labels for a shape with n outfield lines. */
export function lineNames(n: number): string[] {
  if (n === 2) return ['DEF', 'FWD'];
  if (n === 3) return ['DEF', 'MID', 'FWD'];
  if (n === 4) return ['DEF', 'DM', 'MID', 'FWD'];
  if (n === 5) return ['DEF', 'DM', 'MID', 'AM', 'FWD'];
  return Array.from({ length: n }, (_, i) => `L${i + 1}`);
}

/** One position on the pitch. `x`/`y` are percentages: y=90 is our own goal. */
export interface Slot {
  /** Stable across formations: 'GK', 'DEF1', 'MID2'. */
  id: string;
  pos: string;
  isKeeper: boolean;
  lineIndex: number;
  x: number;
  y: number;
}

export function parseFormation(name: string): number[] {
  return name
    .split('-')
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Pitch coordinates for a formation. Keeper at the back, lines spread evenly
 * between y=76 (defence) and y=16 (attack), players spread across x=18..82.
 */
export function slotsFor(lines: readonly number[]): Slot[] {
  const out: Slot[] = [
    { id: 'GK', pos: 'GK', isKeeper: true, lineIndex: -1, x: 50, y: 90 },
  ];
  const names = lineNames(lines.length);
  const rows = lines.length;

  lines.forEach((count, li) => {
    const y = rows === 1 ? 50 : 76 - li * (60 / Math.max(1, rows - 1));
    for (let i = 0; i < count; i++) {
      const x = count === 1 ? 50 : 18 + i * (64 / (count - 1));
      out.push({
        id: `${names[li]}${i + 1}`,
        pos: names[li],
        isKeeper: false,
        lineIndex: li,
        x,
        y,
      });
    }
  });
  return out;
}

/** Slots for a named formation within a format. Falls back to the default. */
export function slotsForFormation(format: Format, formation: string): Slot[] {
  const spec = FORMATS[format];
  const lines = spec.formations[formation] ?? spec.formations[spec.defaultFormation];
  return slotsFor(lines);
}

export function formationNames(format: Format): string[] {
  return Object.keys(FORMATS[format].formations);
}

export function isValidFormation(format: Format, formation: string): boolean {
  return formation in FORMATS[format].formations;
}

/** Outfield total plus keeper must equal the format's on-pitch count. */
export function formationFits(format: Format, formation: string): boolean {
  const lines = FORMATS[format].formations[formation];
  if (!lines) return false;
  return lines.reduce((a, b) => a + b, 0) + 1 === FORMATS[format].onPitch;
}

export function periodCount(periods: Periods): number {
  return periods === 'halves' ? 2 : 4;
}

export function periodLabels(periods: Periods): string[] {
  return periods === 'halves'
    ? ['1st half', '2nd half']
    : ['Q1', 'Q2', 'Q3', 'Q4'];
}
