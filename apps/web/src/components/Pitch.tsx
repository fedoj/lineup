import { slotsForFormation, type Format } from '@lineup/shared';
import type { Player } from '@lineup/shared';

export interface PitchProps {
  format: Format;
  formation: string;
  /** slotId -> playerId for the period being shown. */
  assignment: Record<string, string>;
  players: Player[];
  /** Player ids unavailable for this game. */
  absentIds: Set<string>;
  /** Currently picked-up player, or null. */
  selectedPlayerId: string | null;
  onSlotClick: (slotId: string, occupiedBy: string | null) => void;
  readOnly?: boolean;
}

/**
 * The pitch.
 *
 * Interaction is tap-to-select then tap-to-place — no drag and drop, which is
 * unreliable on a phone held in one hand on a touchline. Empty slots are
 * highlighted whenever a player is selected so the target is obvious.
 */
export default function Pitch({
  format,
  formation,
  assignment,
  players,
  absentIds,
  selectedPlayerId,
  onSlotClick,
  readOnly = false,
}: PitchProps) {
  const slots = slotsForFormation(format, formation);
  const byId = new Map(players.map((p) => [p.id, p]));

  return (
    <div className="pitch" role="group" aria-label="Formation">
      <div className="pitch-lines" aria-hidden="true">
        <div className="centre-circle" />
        <div className="halfway" />
        <div className="box box-top" />
        <div className="box box-bottom" />
      </div>

      {slots.map((slot) => {
        const playerId = assignment[slot.id] ?? null;
        const player = playerId ? byId.get(playerId) : undefined;
        const isAbsent = playerId ? absentIds.has(playerId) : false;
        const empty = !player;
        // Highlight open targets only while a player is in hand.
        const targetable = !readOnly && Boolean(selectedPlayerId) && empty;

        const classes = [
          'slot',
          empty ? 'empty' : 'filled',
          targetable ? 'targetable' : '',
          isAbsent ? 'absent' : '',
          slot.isKeeper ? 'keeper' : '',
          selectedPlayerId && playerId === selectedPlayerId ? 'selected' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <button
            key={slot.id}
            type="button"
            className={classes}
            style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
            disabled={readOnly}
            onClick={() => onSlotClick(slot.id, playerId)}
            aria-label={
              player
                ? `${slot.pos}: ${player.name}${isAbsent ? ' (absent)' : ''}`
                : `${slot.pos}: empty`
            }
          >
            <span className="slot-pos">{slot.pos}</span>
            {player ? (
              <>
                <span className="slot-num">{player.number || '—'}</span>
                <span className="slot-name">{player.name.split(' ')[0]}</span>
              </>
            ) : (
              <span className="slot-plus" aria-hidden="true">
                +
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
