import { useState } from 'react';
import { api } from '../lib/api';
import { mapUrl } from './MapLink';

/**
 * A location box with "Find": type a place or address, tap Find, and pick
 * the right match to fill in the full address, so the map link it becomes
 * goes to the right place. "Check on map" opens what is typed in Apple or
 * Google Maps before saving. Typing anything by hand still works.
 */
export default function LocationInput({
  value,
  onChange,
  placeholder,
  label,
  maxLength = 160,
  presets = [],
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  maxLength?: number;
  /** The region's fields, offered as one-tap picks (Fady, 10/17). */
  presets?: Array<{ name: string; location: string; hasMap?: boolean }>;
}) {
  const [busy, setBusy] = useState(false);
  const [places, setPlaces] = useState<Array<{ label: string; name: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    setPlaces(null);
    try {
      const r = await api.findPlaces(value.trim(), navigator.language || 'en');
      setPlaces(r.places);
      if (r.places.length === 0) setError('No match found. Try adding the street or city.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not search right now.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="location-input">
      {presets.length > 0 && (
        <div className="row location-presets" role="group" aria-label="Region fields">
          {presets.map((p) => (
            <button
              key={`${p.name}-${p.location}`}
              type="button"
              className={`chip${value.trim().toLowerCase() === p.location.trim().toLowerCase() ? ' on' : ''}`}
              title={p.location}
              onClick={() => {
                onChange(p.location);
                setPlaces(null);
                setError(null);
              }}
            >
              📌 {p.name}
              {p.hasMap ? ' 🗺️' : ''}
            </button>
          ))}
        </div>
      )}
      <div className="row location-row">
        <input
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={label ?? 'Location'}
          onChange={(e) => {
            onChange(e.target.value);
            setPlaces(null);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim().length >= 3) {
              e.preventDefault();
              void find();
            }
          }}
        />
        <button type="button" className="btn ghost btn-sm" disabled={busy || value.trim().length < 3} onClick={() => void find()}>
          {busy ? 'Finding…' : '🔎 Find'}
        </button>
      </div>
      {value.trim() && (
        <a className="sub check-map" href={mapUrl(value)} target="_blank" rel="noopener noreferrer">
          📍 Check on map
        </a>
      )}
      {places && places.length > 0 && (
        <ul className="place-picks" role="listbox" aria-label="Matching places">
          {places.map((p) => (
            <li key={p.label}>
              <button
                type="button"
                className="place-pick"
                onClick={() => {
                  onChange(p.label);
                  setPlaces(null);
                }}
              >
                <strong>{p.name}</strong>
                <span className="sub">{p.label}</span>
              </button>
            </li>
          ))}
          <li className="sub place-credit">Addresses © OpenStreetMap contributors</li>
        </ul>
      )}
      {error && <span className="sub warn-text">{error}</span>}
    </div>
  );
}
