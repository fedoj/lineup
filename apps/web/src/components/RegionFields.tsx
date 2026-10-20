import { useCallback, useEffect, useState } from 'react';
import { api, type RegionField } from '../lib/api';
import { shrinkPhoto } from '../lib/image';
import LocationInput from './LocationInput';

/**
 * A region's fields and field maps (Fady, 10/17): up to 10, each a name, a
 * location found with "Find" (so the map link goes to the right place) and a
 * field map picture. Game forms offer these as quick picks, and a game at one
 * of them shows "Field map".
 */
export default function RegionFields({ regionId }: { regionId: string }) {
  const [fields, setFields] = useState<RegionField[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [max, setMax] = useState(10);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [map, setMap] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .regionFields({ regionId })
      .then((r) => {
        setFields(r.fields);
        setCanManage(r.canManage);
        setMax(r.max);
      })
      .catch(() => setFields([]));
  }, [regionId]);
  useEffect(load, [load]);

  function start(f: RegionField | null) {
    setEditing(f ? f.id : 'new');
    setName(f?.name ?? '');
    setLocation(f?.location ?? '');
    setMap(null);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r =
        editing === 'new'
          ? await api.regionFieldAction({ action: 'add', regionId, name: name.trim(), location: location.trim(), map })
          : await api.regionFieldAction({ action: 'update', id: editing!, name: name.trim(), location: location.trim(), map });
      setFields(r.fields);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (!fields || (!canManage && fields.length === 0)) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          Fields &amp; maps <span className="count">{fields.length}</span>
        </h2>
        {canManage && editing === null && fields.length < max && (
          <button type="button" className="btn btn-sm ghost" onClick={() => start(null)}>
            ＋ Add a field
          </button>
        )}
      </div>
      <p className="note">
        Up to {max} fields, each with its location and a field map picture. When you schedule a game, pick one of these as
        the location, and families see “🗺️ Field map” on the game.
      </p>
      {fields.length > 0 && (
        <ul className="field-list">
          {fields.map((f) => (
            <li key={f.id}>
              {f.hasMap ? (
                <a href={`/api/region-fields/map?id=${encodeURIComponent(f.id)}&v=${f.version}`} target="_blank" rel="noopener noreferrer">
                  <img className="field-thumb" src={`/api/region-fields/map?id=${encodeURIComponent(f.id)}&v=${f.version}`} alt={`${f.name} field map`} />
                </a>
              ) : (
                <span className="field-thumb none" aria-hidden="true">
                  🗺️
                </span>
              )}
              <div className="field-info">
                <strong>{f.name}</strong>
                <span className="sub">{f.location}</span>
              </div>
              {canManage && editing === null && (
                <span className="row">
                  <button type="button" className="linkish" onClick={() => start(f)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={async () => {
                      if (!confirm(`Remove ${f.name}?`)) return;
                      setBusy(true);
                      try {
                        setFields((await api.regionFieldAction({ action: 'remove', id: f.id })).fields);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing !== null && (
        <div className="comp-form">
          <label>
            Name
            <input value={name} maxLength={80} placeholder="e.g. Central Park fields" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Location
            <LocationInput value={location} onChange={setLocation} label="Field location" placeholder="Address or place, then Find" />
          </label>
          <label>
            Field map picture{editing !== 'new' ? ' (leave empty to keep the current one)' : ''}
            <input
              type="file"
              accept="image/*"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  setMap(await shrinkPhoto(file, { maxSide: 1600, maxBytes: 550 * 1024 }));
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not read that picture');
                }
              }}
            />
          </label>
          {map && <img className="field-preview" src={map} alt="Field map preview" />}
          {error && <p className="danger-text">{error}</p>}
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={busy || !name.trim() || !location.trim()} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save field'}
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** A region's fields for a game form's location quick picks. */
export function useRegionFields(q: { teamId?: string; competitionId?: string } | null): RegionField[] {
  const [fields, setFields] = useState<RegionField[]>([]);
  const key = q ? `${q.teamId ?? ''}|${q.competitionId ?? ''}` : '';
  useEffect(() => {
    if (!q || (!q.teamId && !q.competitionId)) return;
    let live = true;
    api
      .regionFields(q)
      .then((r) => live && setFields(r.fields))
      .catch(() => live && setFields([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fields;
}
