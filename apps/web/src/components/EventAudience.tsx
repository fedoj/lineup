import { useEffect, useMemo, useState } from 'react';
import { api, type EventAudienceEntry, type EventAudienceOptions } from '../lib/api';

type Scope = 'org' | 'region' | 'team';

const SCOPE_WORD: Record<Scope, string> = { org: 'organization', region: 'region', team: 'team' };

/**
 * Who sees an event (Fady, 10/17): everyone in the team, region or
 * organization, or only chosen regions, age groups, teams and people, such
 * as a BU10 tryout or an all-star tryout for invited players. People who are
 * picked see it on their own team's calendar and RSVP there.
 */
export default function EventAudience({
  scope,
  id,
  value,
  onChange,
  onLimitedChange,
}: {
  scope: Scope;
  id: string;
  value: EventAudienceEntry[];
  onChange: (next: EventAudienceEntry[]) => void;
  /** "Only who I choose" is picked, so an empty choice must not save as everyone. */
  onLimitedChange?: (limited: boolean) => void;
}) {
  const [limited, setLimitedState] = useState(value.length > 0);
  const setLimited = (v: boolean) => {
    setLimitedState(v);
    onLimitedChange?.(v);
  };
  const [options, setOptions] = useState<EventAudienceOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [teamSearch, setTeamSearch] = useState('');
  const [personSearch, setPersonSearch] = useState('');

  useEffect(() => {
    if (!limited || options) return;
    let live = true;
    api
      .eventAudienceOptions(scope, id)
      .then((o) => live && setOptions(o))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the choices.'));
    return () => {
      live = false;
    };
  }, [limited, options, scope, id]);

  const has = (kind: EventAudienceEntry['kind'], ref: string) => value.some((a) => a.kind === kind && a.ref === ref);
  const toggle = (kind: EventAudienceEntry['kind'], ref: string) =>
    onChange(has(kind, ref) ? value.filter((a) => !(a.kind === kind && a.ref === ref)) : [...value, { kind, ref }]);

  const teams = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    const all = options?.teams ?? [];
    return q ? all.filter((t) => `${t.name} ${t.regionName ?? ''} ${t.division ?? ''}`.toLowerCase().includes(q)) : all;
  }, [options, teamSearch]);

  const people = useMemo(() => {
    const q = personSearch.trim().toLowerCase();
    const all = options?.people ?? [];
    if (!q) return all.filter((p) => has('user', p.id));
    return all.filter((p) => `${p.name ?? ''} ${p.email ?? ''} ${p.teams.join(' ')}`.toLowerCase().includes(q)).slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, personSearch, value]);

  const count = (kind: EventAudienceEntry['kind']) => value.filter((a) => a.kind === kind).length;
  const summary = [
    count('region') && `${count('region')} region${count('region') === 1 ? '' : 's'}`,
    count('division') && `${count('division')} age group${count('division') === 1 ? '' : 's'}`,
    count('team') && `${count('team')} team${count('team') === 1 ? '' : 's'}`,
    count('user') && `${count('user')} ${count('user') === 1 ? 'person' : 'people'}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <fieldset className="event-audience">
      <legend>Who sees this event</legend>
      <label className="check">
        <input
          type="radio"
          name={`aud-${id}`}
          checked={!limited}
          onChange={() => {
            setLimited(false);
            onChange([]);
          }}
        />{' '}
        Everyone in the {SCOPE_WORD[scope]}
      </label>
      <label className="check">
        <input type="radio" name={`aud-${id}`} checked={limited} onChange={() => setLimited(true)} /> Only{' '}
        {scope === 'team' ? 'people I choose' : 'the regions, age groups, teams or people I choose'}
      </label>

      {limited && (
        <div className="event-audience-pick">
          {error && <p className="danger-text">{error}</p>}
          {!options && !error && <p className="note">Loading…</p>}
          {options && (
            <>
              {options.regions.length > 0 && (
                <div className="aud-group">
                  <span className="aud-label">Regions</span>
                  <div className="chips">
                    {options.regions.map((r) => (
                      <button key={r.id} type="button" className={`chip${has('region', r.id) ? ' on' : ''}`} aria-pressed={has('region', r.id)} onClick={() => toggle('region', r.id)}>
                        {r.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {options.divisions.length > 0 && (
                <div className="aud-group">
                  <span className="aud-label">Age groups</span>
                  <div className="chips">
                    {options.divisions.map((d) => (
                      <button key={d.code} type="button" className={`chip${has('division', d.code) ? ' on' : ''}`} aria-pressed={has('division', d.code)} title={d.label} onClick={() => toggle('division', d.code)}>
                        {d.code}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {options.teams.length > 0 && (
                <div className="aud-group">
                  <span className="aud-label">Teams</span>
                  {options.teams.length > 12 && (
                    <input type="search" placeholder="Find a team" value={teamSearch} onChange={(e) => setTeamSearch(e.target.value)} />
                  )}
                  <div className="chips">
                    {teams.map((t) => (
                      <button key={t.id} type="button" className={`chip${has('team', t.id) ? ' on' : ''}`} aria-pressed={has('team', t.id)} onClick={() => toggle('team', t.id)}>
                        {t.name}
                        {t.division ? ` · ${t.division}` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="aud-group">
                <span className="aud-label">People</span>
                <input
                  type="search"
                  placeholder="Find a person by name, email or team"
                  value={personSearch}
                  onChange={(e) => setPersonSearch(e.target.value)}
                />
                {people.length === 0 && personSearch.trim() && <p className="note">Nobody matches.</p>}
                <ul className="aud-people">
                  {people.map((p) => (
                    <li key={p.id}>
                      <label className="check">
                        <input type="checkbox" checked={has('user', p.id)} onChange={() => toggle('user', p.id)} />{' '}
                        <span>
                          {p.name ?? p.email ?? 'Someone'}
                          <span className="sub">
                            {p.name && p.email ? ` · ${p.email}` : ''}
                            {p.teams.length ? ` · ${p.teams.join(', ')}` : ''}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="note">
                {summary ? `Shows for: ${summary}.` : 'Pick at least one, or choose Everyone.'} People you pick see it on their own
                team's calendar and can RSVP there. Whoever runs the event always sees it.
              </p>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
