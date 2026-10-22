import { Fragment, useEffect, useState } from 'react';
import { api, type AnnouncementList } from '../lib/api';

/** Roles staff can send an announcement to (Shadi, 10/21). */
const ROLE_CHOICES: Array<[string, string]> = [
  ['coach', 'Coaches'],
  ['assistant', 'Assistant coaches'],
  ['team_parent', 'Team parents'],
  ['parent', 'Parents'],
  ['staff', 'Region & organization staff'],
];

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

/** A message with its web links clickable; everything else stays plain text. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Announcements (Shadi, 10/21): what organization and region staff sent you,
 * and for staff a form to post one to everyone, chosen roles or referees,
 * across the whole organization or region, chosen regions, or chosen teams.
 * Links in the message open in a new tab. Everyone it goes to gets a
 * notification on their phone.
 */
export default function Announcements() {
  const [data, setData] = useState<AnnouncementList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [scopeKey, setScopeKey] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'everyone' | 'roles' | 'referees'>('everyone');
  const [roles, setRoles] = useState<string[]>(['coach']);
  const [where, setWhere] = useState<'all' | 'regions' | 'teams'>('all');
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const focus = new URLSearchParams(location.search).get('id');

  const load = () =>
    api
      .announcements()
      .then((d) => {
        setData(d);
        setScopeKey((k) => k || (d.scopes[0] ? `${d.scopes[0].scope}:${d.scopes[0].id}` : ''));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load announcements'));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (focus && data) document.getElementById(`ann-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus, data]);

  if (error) return <section className="card err">{error}</section>;
  if (!data) return <section className="card">Loading…</section>;

  const scope = data.scopes.find((s) => `${s.scope}:${s.id}` === scopeKey) ?? data.scopes[0];
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function post() {
    if (!scope) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.postAnnouncement({
        scope: scope.scope,
        scopeId: scope.id,
        title: title.trim(),
        body: body.trim(),
        audience,
        roles: audience === 'roles' ? roles : undefined,
        regionIds: audience !== 'referees' && where === 'regions' ? regionIds : undefined,
        teamIds: audience !== 'referees' && where === 'teams' ? teamIds : undefined,
      });
      setMsg(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}. They get a notification on their phone.`);
      setTitle('');
      setBody('');
      setWriting(false);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>📣 Announcements</h2>
          {data.canPost && !writing && (
            <button type="button" className="btn btn-sm" onClick={() => setWriting(true)}>
              ＋ New announcement
            </button>
          )}
        </div>
        {msg && (
          <p className="note" role="status">
            {msg}
          </p>
        )}
        {writing && scope && (
          <div className="comp-form">
            <div className="field-grid">
              {data.scopes.length > 1 && (
                <label>
                  From
                  <select
                    value={scopeKey}
                    onChange={(e) => {
                      setScopeKey(e.target.value);
                      setRegionIds([]);
                      setTeamIds([]);
                    }}
                  >
                    {data.scopes.map((s) => (
                      <option key={`${s.scope}:${s.id}`} value={`${s.scope}:${s.id}`}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Who gets it
                <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
                  <option value="everyone">Everyone</option>
                  <option value="roles">Chosen roles</option>
                  {scope.scope === 'org' && <option value="referees">Referees only</option>}
                </select>
              </label>
              {audience !== 'referees' && (
                <label>
                  Where
                  <select value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
                    <option value="all">{scope.scope === 'org' ? 'All regions and teams' : 'All teams in the region'}</option>
                    {scope.scope === 'org' && scope.regions.length > 0 && <option value="regions">Chosen regions</option>}
                    <option value="teams">Chosen teams</option>
                  </select>
                </label>
              )}
            </div>
            {audience === 'roles' && (
              <div className="chips" role="group" aria-label="Roles">
                {ROLE_CHOICES.map(([v, label]) => (
                  <button key={v} type="button" className={`chip${roles.includes(v) ? ' on' : ''}`} onClick={() => setRoles((r) => toggle(r, v))}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {audience === 'referees' && <p className="note">Goes to the referees who signed up with this organization.</p>}
            {audience !== 'referees' && where === 'regions' && (
              <div className="chips" role="group" aria-label="Regions">
                {scope.regions.map((r) => (
                  <button key={r.id} type="button" className={`chip${regionIds.includes(r.id) ? ' on' : ''}`} onClick={() => setRegionIds((x) => toggle(x, r.id))}>
                    {r.name}
                  </button>
                ))}
              </div>
            )}
            {audience !== 'referees' && where === 'teams' && (
              <div className="chips" role="group" aria-label="Teams">
                {scope.teams.map((t) => (
                  <button key={t.id} type="button" className={`chip${teamIds.includes(t.id) ? ' on' : ''}`} onClick={() => setTeamIds((x) => toggle(x, t.id))}>
                    {t.name}
                    {t.regionName && scope.scope === 'org' ? ` · ${t.regionName}` : ''}
                  </button>
                ))}
              </div>
            )}
            <label>
              Title
              <input value={title} maxLength={120} placeholder="e.g. Picture day moved to Saturday" onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Message
              <textarea
                value={body}
                maxLength={2000}
                rows={5}
                placeholder="Write your message. Paste a link (https://…) and it becomes clickable."
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={
                  busy ||
                  !title.trim() ||
                  !body.trim() ||
                  (audience === 'roles' && roles.length === 0) ||
                  (audience !== 'referees' && where === 'regions' && regionIds.length === 0) ||
                  (audience !== 'referees' && where === 'teams' && teamIds.length === 0)
                }
                onClick={() => void post()}
              >
                {busy ? 'Sending…' : 'Send announcement'}
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => setWriting(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {data.announcements.length === 0 && !writing && (
          <p className="note">
            {data.canPost ? 'Nothing posted yet. Share news with your teams, parents or referees here.' : 'No announcements yet. When your region or organization posts one, it shows here.'}
          </p>
        )}
      </section>

      {data.announcements.map((a) => (
        <section key={a.id} id={`ann-${a.id}`} className={`card announcement${a.id === focus ? ' focus' : ''}`}>
          <div className="card-head">
            <h3>{a.title}</h3>
            {a.canDelete && (
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={() => {
                  if (confirm('Delete this announcement for everyone?')) void api.deleteAnnouncement(a.id).then(load);
                }}
              >
                Delete
              </button>
            )}
          </div>
          <p className="sub">
            {a.from}
            {a.author ? ` · ${a.author}` : ''} · {when(a.createdAt)}
          </p>
          <p className="announcement-body">
            <Linkified text={a.body} />
          </p>
          {a.audience && (
            <p className="sub">
              Sent to{' '}
              {a.audience.who === 'referees'
                ? 'referees'
                : a.audience.who === 'roles'
                  ? a.audience.roles.map((r) => ROLE_CHOICES.find(([v]) => v === r)?.[1] ?? r).join(', ').toLowerCase()
                  : 'everyone'}
              {a.audience.teams.length ? ` on ${a.audience.teams.join(', ')}` : a.audience.regions.length ? ` in ${a.audience.regions.join(', ')}` : ''} ·{' '}
              {a.audience.recipients} {a.audience.recipients === 1 ? 'person' : 'people'}
            </p>
          )}
        </section>
      ))}
    </>
  );
}
