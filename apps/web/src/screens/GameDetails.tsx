import { useEffect, useState } from 'react';
import { FORMATS, formationNames, type Format, type Game, type Periods } from '@lineup/shared';
import { api } from '../lib/api';
import MapLink from '../components/MapLink';
import LocationInput from '../components/LocationInput';

const FORMAT_IDS = Object.keys(FORMATS) as Format[];

interface Props {
  game: Game;
  canEdit: boolean;
  onSaved: (g: Game) => void;
  onClose: () => void;
}

/**
 * Edit everything about a fixture. Only changed fields are sent, because the
 * API treats an omitted field as "leave it alone" — that is what keeps a
 * detail edit from wiping the saved lineup.
 */
export default function GameDetails({ game, canEdit, onSaved, onClose }: Props) {
  const [opponent, setOpponent] = useState(game.opponent);
  const [date, setDate] = useState(game.date ?? '');
  const [isHome, setIsHome] = useState(game.isHome);
  const [format, setFormat] = useState<Format>(game.format);
  const [periods, setPeriods] = useState<Periods>(game.periods);
  const [formation, setFormation] = useState(game.formation);
  const [us, setUs] = useState(String(game.us));
  const [them, setThem] = useState(String(game.them));
  const [notes, setNotes] = useState(game.notes ?? '');
  const [kickoff, setKickoff] = useState(game.kickoff ?? '');
  const [location, setLocation] = useState(game.location ?? '');
  const [field, setField] = useState(game.field ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOpponent(game.opponent);
    setDate(game.date ?? '');
    setIsHome(game.isHome);
    setFormat(game.format);
    setPeriods(game.periods);
    setFormation(game.formation);
    setUs(String(game.us));
    setThem(String(game.them));
    setNotes(game.notes ?? '');
    setKickoff(game.kickoff ?? '');
    setLocation(game.location ?? '');
    setField(game.field ?? '');
  }, [game]);

  // A shape from the old format cannot be played in the new one.
  const shapes = formationNames(format);
  useEffect(() => {
    if (!shapes.includes(formation)) setFormation(FORMATS[format].defaultFormation);
  }, [format, formation, shapes]);

  const formatChanged = format !== game.format;
  // League games are scheduled by the org or region; the team runs the rest.
  const league = Boolean(game.fixtureId);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const saved = await api.saveGame({
        teamId: game.teamId,
        gameNo: game.gameNo,
        ...(league ? {} : { opponent, date, isHome, kickoff, location, field }),
        format,
        periods,
        formation,
        us: Number(us) || 0,
        them: Number(them) || 0,
        notes,
      });
      onSaved(saved);
      if (saved.proposalPending) {
        window.alert('Your formation change was sent to the coach for approval. It shows on match day until the coach decides.');
      }
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card game-details">
      <div className="card-head">
        <h2>Game #{game.gameNo}</h2>
        <button type="button" className="chip-x" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      {error && <p className="danger-text">{error}</p>}

      {league && (
        <p className="note">
          <span className="pill-league">League</span> Scheduled by your organization or region
          {game.kickoff ? ` · kick-off ${game.kickoff}` : ''}
          {game.location && (
            <>
              {' · '}
              <MapLink place={game.location} />
            </>
          )}
          {game.field ? ` · Field ${game.field}` : ''}. Date, opponent and venue are set there.
        </p>
      )}

      <div className="field-grid">
        <label>
          Opponent
          <input
            value={opponent}
            disabled={!canEdit || league}
            placeholder="Opponent name"
            onChange={(e) => setOpponent(e.target.value)}
          />
        </label>

        <label>
          Date
          <input
            type="date"
            value={date}
            disabled={!canEdit || league}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>

        <label>
          Venue
          <select
            value={isHome ? 'home' : 'away'}
            disabled={!canEdit || league}
            onChange={(e) => setIsHome(e.target.value === 'home')}
          >
            <option value="home">Home</option>
            <option value="away">Away</option>
          </select>
        </label>

        {!league && (
          <>
            <label>
              Kick-off
              <input
                type="time"
                value={kickoff}
                disabled={!canEdit}
                onChange={(e) => setKickoff(e.target.value)}
              />
            </label>
            <label>
              Location
              {canEdit ? (
                <LocationInput value={location} onChange={setLocation} label="Location" placeholder="Optional" />
              ) : (
                <input value={location} disabled placeholder="Optional" />
              )}
            </label>
            <label>
              Field
              <input
                value={field}
                maxLength={40}
                disabled={!canEdit}
                placeholder="Optional"
                onChange={(e) => setField(e.target.value)}
              />
            </label>
          </>
        )}

        <label>
          Format
          <select
            value={format}
            disabled={!canEdit}
            onChange={(e) => setFormat(e.target.value as Format)}
          >
            {FORMAT_IDS.map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Periods
          <select
            value={periods}
            disabled={!canEdit}
            onChange={(e) => setPeriods(e.target.value as Periods)}
          >
            <option value="quarters">Quarters</option>
            <option value="halves">Halves</option>
          </select>
        </label>

        <label>
          Formation
          <select
            value={formation}
            disabled={!canEdit}
            onChange={(e) => setFormation(e.target.value)}
          >
            {shapes.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>

        <label>
          Our score
          <input
            type="number"
            min="0"
            value={us}
            disabled={!canEdit}
            onChange={(e) => setUs(e.target.value)}
          />
        </label>

        <label>
          Their score
          <input
            type="number"
            min="0"
            value={them}
            disabled={!canEdit}
            onChange={(e) => setThem(e.target.value)}
          />
        </label>
      </div>

      <label>
        Notes
        <input
          value={notes}
          disabled={!canEdit}
          placeholder="Anything worth remembering"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      {formatChanged && (
        <p className="note warn">
          Changing the format resets the shape to {FORMATS[format].defaultFormation} and may leave
          players off the pitch — check the lineup afterwards.
        </p>
      )}

      <p className="note">Scores update automatically as you log goals on match day.</p>

      {canEdit && (
        <div className="row">
          <button type="button" className="btn" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save game'}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
