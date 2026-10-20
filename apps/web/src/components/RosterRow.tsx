import { positionGroups, type Player } from '@lineup/shared';

interface Props {
  player: Player;
  disabled: boolean;
  duplicate: boolean;
  onChange: (next: Player) => void;
  /** Omitted when the caller may not remove players. */
  onRemove?: () => void;
}

const GROUPS = positionGroups();

/**
 * One roster row.
 *
 * Laid out as a grid rather than a flex row: on a phone the number, name and
 * two position selects stack into two lines instead of overflowing sideways,
 * which is what pushed the inputs off screen before.
 */
export default function RosterRow({ player, disabled, duplicate, onChange, onRemove }: Props) {
  return (
    <div className="roster-row">
      <div className="rr-top">
        <input
          className={`num ${duplicate ? 'bad-input' : ''}`}
          value={player.number}
          disabled={disabled}
          placeholder="#"
          inputMode="numeric"
          aria-label="Shirt number"
          onChange={(e) => onChange({ ...player, number: e.target.value })}
        />
        <input
          className="rr-name"
          value={player.name}
          disabled={disabled}
          placeholder="Player name"
          aria-label="Player name"
          onChange={(e) => onChange({ ...player, name: e.target.value })}
        />
        {!disabled && onRemove && (
          <button type="button" className="chip-x" onClick={onRemove} title="Remove player">
            ✕
          </button>
        )}
      </div>
      {player.publicId && (
        <div className="rr-id sub" title="Player ID, unique in the organization">
          🆔 {player.publicId}
        </div>
      )}

      <div className="rr-pos">
        <label>
          <span>Boy or girl</span>
          <select
            value={player.gender ?? ''}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...player, gender: e.target.value === 'boy' || e.target.value === 'girl' ? e.target.value : null })
            }
          >
            <option value="">Team default</option>
            <option value="boy">Boy</option>
            <option value="girl">Girl</option>
          </select>
        </label>
        <span />
        <label>
          <span>Primary</span>
          <select
            value={player.primaryPos ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...player, primaryPos: e.target.value || null })}
          >
            <option value="">Any position</option>
            {GROUPS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} — {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label>
          <span>Secondary</span>
          <select
            value={player.secondaryPos ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...player, secondaryPos: e.target.value || null })}
          >
            <option value="">None</option>
            {GROUPS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items
                  .filter((p) => p.id !== player.primaryPos)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} — {p.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="rr-check">
          <input
            type="checkbox"
            checked={player.neverKeeper ?? false}
            disabled={disabled}
            onChange={(e) => onChange({ ...player, neverKeeper: e.target.checked })}
          />
          <span>Never in goal</span>
        </label>
      </div>
    </div>
  );
}
