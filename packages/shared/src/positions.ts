/**
 * Positions — the real-world position vocabulary a coach actually uses, and
 * how it maps onto the abstract pitch slots the formation engine generates.
 *
 * The formation engine only knows generic lines (GK, DEF, DM, MID, AM, FWD)
 * plus a lateral coordinate. A coach thinks in CB, LB, RW, ST. This module is
 * the translation layer: every position declares which line(s) it belongs to
 * and where across the pitch it prefers to sit, which lets us score how well a
 * player's stated position fits a given slot.
 *
 * Affinity is deliberately a SOFT signal. If a whole squad declares itself
 * centre-forward, every striker slot ties and the ordinary fairness rules take
 * over — nobody is benched for picking an unhelpful position, and no slot is
 * left empty because no "qualified" player existed.
 */

export type PositionId =
  | 'GK'
  | 'CB' | 'LB' | 'RB' | 'LWB' | 'RWB'
  | 'CDM' | 'CM' | 'CAM' | 'LM' | 'RM'
  | 'LW' | 'RW' | 'CF' | 'ST';

export interface PositionSpec {
  id: PositionId;
  /** Shown in the picker. */
  label: string;
  /** Coarse grouping for the picker's option groups. */
  group: 'Goalkeeper' | 'Defence' | 'Midfield' | 'Attack';
  /** Slot lines this position is at home in, best first. */
  lines: readonly string[];
  /**
   * Preferred lateral position, 0 = far left, 50 = centre, 100 = far right.
   * `null` means no lateral preference (a keeper).
   */
  x: number | null;
}

export const POSITIONS: readonly PositionSpec[] = [
  { id: 'GK',  label: 'Goalkeeper',          group: 'Goalkeeper', lines: ['GK'],                 x: null },

  { id: 'CB',  label: 'Centre back',         group: 'Defence',    lines: ['DEF'],                x: 50 },
  { id: 'LB',  label: 'Left back',           group: 'Defence',    lines: ['DEF'],                x: 10 },
  { id: 'RB',  label: 'Right back',          group: 'Defence',    lines: ['DEF'],                x: 90 },
  { id: 'LWB', label: 'Left wing back',      group: 'Defence',    lines: ['DEF', 'MID'],         x: 8 },
  { id: 'RWB', label: 'Right wing back',     group: 'Defence',    lines: ['DEF', 'MID'],         x: 92 },

  { id: 'CDM', label: 'Defensive midfield',  group: 'Midfield',   lines: ['DM', 'MID', 'DEF'],   x: 50 },
  { id: 'CM',  label: 'Centre midfield',     group: 'Midfield',   lines: ['MID', 'DM', 'AM'],    x: 50 },
  { id: 'CAM', label: 'Attacking midfield',  group: 'Midfield',   lines: ['AM', 'MID', 'FWD'],   x: 50 },
  { id: 'LM',  label: 'Left midfield',       group: 'Midfield',   lines: ['MID', 'AM'],          x: 10 },
  { id: 'RM',  label: 'Right midfield',      group: 'Midfield',   lines: ['MID', 'AM'],          x: 90 },

  { id: 'LW',  label: 'Left wing',           group: 'Attack',     lines: ['FWD', 'AM', 'MID'],   x: 10 },
  { id: 'RW',  label: 'Right wing',          group: 'Attack',     lines: ['FWD', 'AM', 'MID'],   x: 90 },
  { id: 'CF',  label: 'Centre forward',      group: 'Attack',     lines: ['FWD', 'AM'],          x: 50 },
  { id: 'ST',  label: 'Striker',             group: 'Attack',     lines: ['FWD'],                x: 50 },
];

const BY_ID = new Map<string, PositionSpec>(POSITIONS.map((p) => [p.id, p]));

export function positionSpec(id: string | null | undefined): PositionSpec | null {
  return id ? BY_ID.get(id) ?? null : null;
}

export function isPositionId(v: unknown): v is PositionId {
  return typeof v === 'string' && BY_ID.has(v);
}

export function positionLabel(id: string | null | undefined): string {
  return positionSpec(id)?.label ?? '';
}

/** Positions grouped for an optgroup-style picker. */
export function positionGroups(): Array<{ group: string; items: readonly PositionSpec[] }> {
  const order: PositionSpec['group'][] = ['Goalkeeper', 'Defence', 'Midfield', 'Attack'];
  return order.map((group) => ({
    group,
    items: POSITIONS.filter((p) => p.group === group),
  }));
}

/** Slot shape this module needs — kept structural to avoid a circular import. */
export interface SlotLike {
  pos: string;
  isKeeper: boolean;
  x: number;
}

/**
 * How well a stated position fits a slot, from 0 (no signal) to 1 (ideal).
 *
 * Line match dominates, because playing a winger centrally is a smaller error
 * than playing a centre back up front. Lateral fit then separates LB from RB
 * within the same defensive line.
 */
export function positionAffinity(position: string | null | undefined, slot: SlotLike): number {
  const spec = positionSpec(position);
  if (!spec) return 0;

  // A keeper slot is all-or-nothing: only a declared keeper has any affinity.
  if (slot.isKeeper) return spec.id === 'GK' ? 1 : 0;
  if (spec.id === 'GK') return 0;

  const rank = spec.lines.indexOf(slot.pos);
  if (rank === -1) return 0;

  // 1.0 for the primary line, decaying for the fallbacks.
  const lineScore = 1 - rank * 0.3;

  // Lateral agreement, 1 when exactly on the preferred side.
  const lateral = spec.x === null ? 1 : 1 - Math.abs(spec.x - slot.x) / 100;

  return Math.max(0, lineScore * 0.7 + lateral * 0.3);
}

/**
 * Combined affinity for a player's primary and secondary position.
 * The secondary counts for less, so it breaks ties without competing with a
 * player who named that position first.
 */
export function playerSlotAffinity(
  primary: string | null | undefined,
  secondary: string | null | undefined,
  slot: SlotLike,
): number {
  return Math.max(positionAffinity(primary, slot), positionAffinity(secondary, slot) * 0.6);
}
