import { useEffect, useState } from 'react';
import { FLYER_IMAGE_MAX_SIDE, FLYER_MAX_BYTES, sizeLabel, type Player } from '@lineup/shared';
import { api, type EventAudienceEntry, type SnackSlot, type TeamEvent, type TeamEventInput, type TeamEventKind, type TeamLife } from '../lib/api';
import { PaidLock } from '../lib/features';
import MapLink from './MapLink';
import LocationInput from './LocationInput';
import EventAudience from './EventAudience';
import { AddToCalendar, RsvpButton, RsvpSummary } from './Rsvp';
import { DateTile } from './DateTile';
import FilePick from './FilePick';
import { dataUrlBytes, readAsDataUrl, shrinkPhoto } from '../lib/image';

/** Minutes an event lasts, for "add to my calendar"; two hours by default. */
function eventMinutes(start: string | null, end: string | null): number {
  if (!start || !end) return 120;
  const [a, b] = start.split(':').map(Number);
  const [c, d] = end.split(':').map(Number);
  const m = c * 60 + d - (a * 60 + b);
  return m > 0 ? m : 120;
}

export const EVENT_KINDS: Array<[TeamEventKind, string, string]> = [
  ['party', 'Team party', '🎉'],
  ['picture_day', 'Picture day', '📸'],
  ['fundraiser', 'Fundraiser', '💵'],
  ['meeting', 'Parent meeting', '🗣️'],
  ['tournament', 'Tournament', '🏆'],
  ['tryout', 'Tryout', '🎯'],
  ['volunteer', 'Volunteer shift', '🙋'],
  ['other', 'Other', '📌'],
];

export function eventIcon(kind: TeamEventKind): string {
  return EVENT_KINDS.find(([k]) => k === kind)?.[2] ?? '📌';
}

function prettyDay(iso: string | null): string {
  if (!iso) return 'Date TBD';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function prettyClock(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Run = (fn: () => Promise<unknown>, done: string) => Promise<void>;

/**
 * Events: parties, picture day, fundraisers. Team parents run a team's own
 * events; organization and region staff run region-wide and organization-wide
 * ones, which also show on every team's calendar.
 */
export function TeamEvents({
  teamId,
  scope,
  life,
  busy,
  run,
}: {
  teamId?: string;
  scope?: { kind: 'org' | 'region'; id: string };
  life: TeamLife;
  busy: boolean;
  run: Run;
}) {
  const [showPast, setShowPast] = useState(false);
  const [adding, setAdding] = useState(false);
  const now = today();
  const upcoming = life.events.filter((e) => e.date >= now);
  const past = life.events.filter((e) => e.date < now).reverse();
  const heading = scope ? (scope.kind === 'region' ? 'Region events' : 'Organization events') : 'Team events';

  return (
    <section className="card">
      <div className="card-head">
        <h2>{heading}</h2>
        {life.canEditEvents && !adding && (
          <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
            Add event
          </button>
        )}
      </div>
      {adding && (
        <EventForm
          flyers={life.flyers}
          busy={busy}
          audienceFor={scope ? { scope: scope.kind, id: scope.id } : teamId ? { scope: 'team', id: teamId } : undefined}
          onCancel={() => setAdding(false)}
          onSave={(input) =>
            run(
              () =>
                scope
                  ? api.createScopeEvent({ ...input, scope: scope.kind, scopeId: scope.id })
                  : api.createTeamEvent({ ...input, teamId: teamId! }),
              scope
                ? 'Event added. Everyone on its teams has been notified, and it shows on their calendars.'
                : 'Event added. The team has been notified.',
            ).then(() => setAdding(false))
          }
        />
      )}
      {upcoming.length === 0 ? (
        <p className="note">
          No upcoming events.
          {life.canEditEvents
            ? scope
              ? ` Add a ${scope.kind === 'region' ? 'region' : 'organization'}-wide event, like a picture day or tournament, and every team sees it on its calendar.`
              : ' Add a team party, picture day or fundraiser and the team sees it here.'
            : ''}
        </p>
      ) : (
        <ul className="fixtures">
          {upcoming.map((e) => (
            <EventRow key={e.id} e={e} life={life} teamId={teamId} busy={busy} run={run} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <>
          <button type="button" className="linkish" onClick={() => setShowPast((v) => !v)}>
            {showPast ? 'Hide' : 'Show'} past events ({past.length})
          </button>
          {showPast && (
            <ul className="fixtures past">
              {past.map((e) => (
                <EventRow key={e.id} e={e} life={life} busy={busy} run={run} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function EventRow({
  e,
  life,
  teamId,
  busy,
  run,
}: {
  e: TeamEvent;
  life: TeamLife;
  /** The team whose calendar this is; check-ins are per team. */
  teamId?: string;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const kindLabel = EVENT_KINDS.find(([k]) => k === e.kind)?.[1] ?? 'Event';
  const time = [prettyClock(e.startTime), prettyClock(e.endTime)].filter(Boolean).join(' – ');
  const checkin = teamId ? e.checkin : null;

  if (editing) {
    const scopeKind = e.scope ?? (e.teamId ? 'team' : null);
    const scopeId = e.scopeId ?? e.teamId;
    return (
      <li className="fixture">
        <EventForm
          initial={e}
          flyers={life.flyers}
          busy={busy}
          audienceFor={scopeKind && scopeId ? { scope: scopeKind, id: scopeId } : undefined}
          onCancel={() => setEditing(false)}
          onSave={(input) =>
            run(() => api.updateTeamEvent({ ...input, id: e.id }), 'Event updated.').then(() => setEditing(false))
          }
        />
      </li>
    );
  }

  return (
    <li className="fixture team-event" id={`item-event-${e.id}`}>
      <div className="fixture-when">
        <DateTile date={e.date} />
        <strong>{prettyDay(e.date)}</strong>
        {time && <span>{time}</span>}
      </div>
      <div className="fixture-what">
        <div className="fixture-teams">
          <span aria-hidden="true">{eventIcon(e.kind)}</span>
          <span>{e.title}</span>
          <span className="pill-event">{kindLabel}</span>
          {e.scope && e.scope !== 'team' && (
            <span className="pill-event">
              {e.scope === 'region' ? 'Region' : 'Organization'}
              {e.scopeName ? `: ${e.scopeName}` : ''}
            </span>
          )}
          {e.restricted && (
            <span className="pill-event pill-invited" title="Only for chosen regions, age groups, teams or people">
              🔒 Invited only
            </span>
          )}
        </div>
        {e.maxGoing ? (
          <div className={`sub event-capacity${e.full ? ' full' : ''}`}>
            {e.goingTotal ?? 0} of {e.maxGoing} going{e.full ? ' · Full' : ''}
          </div>
        ) : null}
        {e.location && (
          <div className="sub">
            <MapLink place={e.location} />
          </div>
        )}
        {e.notes && <p className="event-notes">{e.notes}</p>}
        {checkin && (
          <>
            <div className="row item-actions">
              <RsvpButton kind="event" itemId={e.id} teamId={teamId!} kids={checkin.children} onSaved={() => void run(async () => undefined, `RSVP saved for ${e.title}.`)} />
              <AddToCalendar uid={`event-${e.id}`} title={e.title} date={e.date} time={e.startTime} durationMinutes={eventMinutes(e.startTime, e.endTime)} location={e.location} description={e.notes} />
            </div>
            {(checkin.summary || checkin.children.length > 0) && <RsvpSummary counts={checkin.counts} summary={checkin.summary} />}
          </>
        )}
        <div className="row fixture-actions">
          {e.flyer && (
            <a className="btn ghost btn-sm" href={e.flyer.url} target="_blank" rel="noopener noreferrer">
              View flyer
            </a>
          )}
          {(e.canEdit ?? life.canEditEvents) && (
            <>
              <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Remove "${e.title}" from the calendar?`)) {
                    void run(() => api.deleteTeamEvent(e.id), 'Event removed.');
                  }
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
        {e.createdBy && <span className="sub">Added by {e.createdBy}</span>}
      </div>
    </li>
  );
}

export function EventForm({
  initial,
  flyers,
  busy,
  onSave,
  onCancel,
  audienceFor,
}: {
  initial?: TeamEvent;
  flyers: boolean;
  busy: boolean;
  onSave: (input: TeamEventInput) => Promise<void>;
  onCancel: () => void;
  /** Where the event lives, so it can be limited to chosen teams or people. */
  audienceFor?: { scope: 'org' | 'region' | 'team'; id: string };
}) {
  const [kind, setKind] = useState<TeamEventKind>(initial?.kind ?? 'party');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? '');
  const [startTime, setStartTime] = useState(initial?.startTime ?? '');
  const [endTime, setEndTime] = useState(initial?.endTime ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [maxGoing, setMaxGoing] = useState(initial?.maxGoing ? String(initial.maxGoing) : '');
  const [audience, setAudience] = useState<EventAudienceEntry[]>(initial?.audience ?? []);
  const [audienceLimited, setAudienceLimited] = useState((initial?.audience ?? []).length > 0);
  const [flyer, setFlyer] = useState<{ dataUrl: string; name: string } | null | undefined>(undefined);
  const [fileError, setFileError] = useState<string | null>(null);

  async function pick(file: File) {
    setFileError(null);
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.type)) {
      setFileError('Use a PNG, JPEG, WebP image or a PDF.');
      return;
    }
    try {
      // Every flyer photo is shrunk to a small JPEG; a PDF must already be small.
      const dataUrl = file.type.startsWith('image/')
        ? await shrinkPhoto(file, { maxSide: FLYER_IMAGE_MAX_SIDE, maxBytes: FLYER_MAX_BYTES })
        : await readAsDataUrl(file);
      if (dataUrlBytes(dataUrl) > FLYER_MAX_BYTES) {
        setFileError(`A PDF flyer must be under ${sizeLabel(FLYER_MAX_BYTES)}. A photo or screenshot of it works too.`);
        return;
      }
      setFlyer({ dataUrl, name: file.name || 'Flyer photo.jpg' });
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Could not use that file.');
    }
  }

  const currentFlyer = flyer === undefined ? initial?.flyer ?? null : flyer;

  return (
    <div className="event-form">
      <div className="field-grid">
        <label>
          Type
          <select
            value={kind}
            onChange={(x) => {
              const next = x.target.value as TeamEventKind;
              const label = EVENT_KINDS.find(([k]) => k === next)?.[1] ?? '';
              if (!title.trim() || EVENT_KINDS.some(([, l]) => l === title)) setTitle(next === 'other' ? '' : label);
              setKind(next);
            }}
          >
            {EVENT_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input value={title} maxLength={120} placeholder="e.g. End of season party" onChange={(x) => setTitle(x.target.value)} />
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(x) => setDate(x.target.value)} />
        </label>
        <label>
          Starts (optional)
          <input type="time" value={startTime} onChange={(x) => setStartTime(x.target.value)} />
        </label>
        <label>
          Ends (optional)
          <input type="time" value={endTime} onChange={(x) => setEndTime(x.target.value)} />
        </label>
        <label>
          Where (optional)
          <LocationInput value={location} onChange={setLocation} label="Where" placeholder="e.g. Pizza Palace, Main St" />
        </label>
        <label>
          Most going (optional)
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            value={maxGoing}
            placeholder="No limit"
            onChange={(x) => setMaxGoing(x.target.value.replace(/[^\d]/g, ''))}
          />
        </label>
      </div>
      <label>
        Details (optional)
        <textarea
          value={notes}
          maxLength={2000}
          rows={3}
          placeholder="What to bring, cost, who to contact…"
          onChange={(x) => setNotes(x.target.value)}
        />
      </label>
      {flyers ? (
        <FilePick
          accept="image/png,image/jpeg,image/webp,application/pdf"
          onFile={(f) => void pick(f)}
          onReject={() => setFileError('Use a PNG, JPEG, WebP image or a PDF.')}
          chooseLabel={currentFlyer ? 'Replace flyer' : 'Choose file'}
          cameraLabel="Photo of a flyer"
          dropText={currentFlyer ? 'Drag a new flyer here' : 'Drag a flyer here'}
          hint={currentFlyer ? `Attached: ${currentFlyer.name}` : `A photo (we shrink it) or a PDF up to ${sizeLabel(FLYER_MAX_BYTES)}`}
          actions={
            currentFlyer ? (
              <button type="button" className="btn ghost btn-sm" onClick={() => setFlyer(null)}>
                Remove flyer
              </button>
            ) : null
          }
        />
      ) : (
        <PaidLock feature="eventFlyers" what="Event flyers" />
      )}
      {fileError && <p className="danger-text">{fileError}</p>}
      {audienceFor && (
        <EventAudience
          scope={audienceFor.scope}
          id={audienceFor.id}
          value={audience}
          onChange={setAudience}
          onLimitedChange={setAudienceLimited}
        />
      )}
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !title.trim() || !date || (audienceLimited && audience.length === 0)}
          onClick={() =>
            void onSave({
              kind,
              title: title.trim(),
              date,
              startTime: startTime || null,
              endTime: endTime || null,
              location: location.trim() || null,
              notes: notes.trim() || null,
              maxGoing: maxGoing ? Number(maxGoing) : null,
              ...(audienceFor ? { audience: audienceLimited ? audience : [] } : {}),
              ...(flyer !== undefined ? { flyer } : {}),
            })
          }
        >
          {initial ? 'Save' : 'Add event'}
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Who brings snacks to each game. Team parents and coaches fill it in. */
export function SnackSchedule({ teamId, life, busy, run }: { teamId: string; life: TeamLife; busy: boolean; run: Run }) {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [showPast, setShowPast] = useState(false);
  const now = today();

  useEffect(() => {
    if (!life.canEditSnacks) return;
    let cancelled = false;
    api
      .listPlayers(teamId)
      .then((p) => !cancelled && setPlayers(p.filter((x) => x.active !== false)))
      .catch(() => !cancelled && setPlayers([]));
    return () => {
      cancelled = true;
    };
  }, [teamId, life.canEditSnacks]);

  if (!life.canSeeSnacks) return null;

  const upcoming = life.snacks.filter((s) => !s.date || s.date >= now);
  const past = life.snacks.filter((s) => s.date && s.date < now).reverse();
  const open = upcoming.filter((s) => !s.playerId && !s.family).length;

  return (
    <section className="card" id="cal-snacks">
      <h2>Snack schedule</h2>
      <p className="note">
        {life.canEditSnacks
          ? 'Pick the family bringing snacks to each game. Everyone on the team sees this list.'
          : 'Which family brings snacks to each game.'}
        {open > 0 && ` ${open} upcoming ${open === 1 ? 'game still needs' : 'games still need'} a family.`}
      </p>
      {upcoming.length === 0 ? (
        <p className="note">No upcoming games yet.</p>
      ) : (
        <ul className="snack-list">
          {upcoming.map((s) => (
            <SnackRow key={s.gameId} s={s} players={players} canEdit={life.canEditSnacks} busy={busy} run={run} />
          ))}
        </ul>
      )}
      {past.length > 0 && (
        <>
          <button type="button" className="linkish" onClick={() => setShowPast((v) => !v)}>
            {showPast ? 'Hide' : 'Show'} past games ({past.length})
          </button>
          {showPast && (
            <ul className="snack-list past">
              {past.map((s) => (
                <SnackRow key={s.gameId} s={s} players={players} canEdit={false} busy={busy} run={run} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function SnackRow({
  s,
  players,
  canEdit,
  busy,
  run,
}: {
  s: SnackSlot;
  players: Player[] | null;
  canEdit: boolean;
  busy: boolean;
  run: Run;
}) {
  const [editing, setEditing] = useState(false);
  const [playerId, setPlayerId] = useState(s.playerId ?? '');
  const [family, setFamily] = useState(s.family ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');

  const who = s.playerName ? `${s.playerName}'s family` : s.family;
  const game = `${s.isHome ? 'vs' : 'at'} ${s.opponent || 'TBD'}`;

  return (
    <li className="snack-row">
      <div className="fixture-when">
        <DateTile date={s.date} />
        <strong>{prettyDay(s.date)}</strong>
        {s.kickoff && <span>{prettyClock(s.kickoff)}</span>}
      </div>
      <div className="fixture-what">
        <div>
          <span className="sub">Game {s.gameNo} · {game}</span>
        </div>
        {!editing && (
          <div className="row">
            {who ? <strong>🍊 {who}</strong> : <span className="note">No family yet</span>}
            {s.notes && <span className="sub">{s.notes}</span>}
            {canEdit && (
              <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(true)}>
                {who ? 'Change' : 'Assign'}
              </button>
            )}
          </div>
        )}
        {editing && (
          <div className="field-grid">
            <label>
              Family
              <select value={playerId} onChange={(x) => setPlayerId(x.target.value)}>
                <option value="">Someone else (type below)</option>
                {(players ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}'s family
                  </option>
                ))}
              </select>
            </label>
            {!playerId && (
              <label>
                Name
                <input value={family} maxLength={80} placeholder="e.g. Garcia family" onChange={(x) => setFamily(x.target.value)} />
              </label>
            )}
            <label>
              Note (optional)
              <input value={notes} maxLength={200} placeholder="e.g. orange slices and water" onChange={(x) => setNotes(x.target.value)} />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      api.setSnack({
                        gameId: s.gameId,
                        playerId: playerId || null,
                        family: playerId ? null : family.trim() || null,
                        notes: notes.trim() || null,
                      }),
                    'Snack schedule updated.',
                  ).then(() => setEditing(false))
                }
              >
                Save
              </button>
              {who && (
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.setSnack({ gameId: s.gameId }), 'Snack slot cleared.').then(() => setEditing(false))
                  }
                >
                  Clear
                </button>
              )}
              <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}
