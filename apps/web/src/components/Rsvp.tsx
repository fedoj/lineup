import { useState } from 'react';
import { RSVP_REASONS, buildIcs, buildIcsCalendar, nameWithReason, type IcsEvent, type RsvpReason } from '@lineup/shared';
import { api, type RsvpChild } from '../lib/api';
import { useFeature } from '../lib/features';
import RsvpTally, { RsvpIcon, type TallyCounts, type TallyNames } from './RsvpTally';

type RsvpBucket = 'going' | 'out';

export type RsvpKind = 'game' | 'practice' | 'event';

const GOING: Record<RsvpKind, string[]> = {
  game: ['available', 'late'],
  practice: ['present', 'late'],
  event: ['going'],
};

/** A stored answer as going, not going, or none yet. */
export function rsvpState(kind: RsvpKind, status: string | null | undefined): 'going' | 'not_going' | null {
  if (!status) return null;
  return GOING[kind].includes(status) ? 'going' : 'not_going';
}

function save(kind: RsvpKind, itemId: string, teamId: string, playerId: string, going: boolean, reason?: RsvpReason, note?: string) {
  if (kind === 'game') {
    return api.checkIn({ gameId: itemId, playerId, status: going ? 'available' : 'absent', reason, note });
  }
  if (kind === 'practice') {
    return api.practiceAction({ action: 'checkin', practiceId: itemId, playerId, status: going ? 'present' : 'absent', reason, note });
  }
  return api.eventCheckIn({ eventId: itemId, teamId, playerId, status: going ? 'going' : 'not_going', reason, note });
}

const REASON_ICON: Record<RsvpReason, string> = { sick: '🤒', injured: '🩹', other: '📝' };

/**
 * One RSVP button for a game, practice or event. It opens a small panel with
 * each of the caller's children: Going, or Not going with a reason (sick,
 * injured, or other with an optional comment). Nothing shows for someone with
 * no linked child.
 */
export function RsvpButton({
  kind,
  itemId,
  teamId,
  kids,
  onSaved,
  big = false,
}: {
  kind: RsvpKind;
  itemId: string;
  teamId: string;
  kids: RsvpChild[];
  onSaved: () => void;
  big?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [other, setOther] = useState<Record<string, string>>({});
  const [askWhy, setAskWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (kids.length === 0) return null;

  const states = kids.map((k) => rsvpState(kind, k.status));
  const answeredAll = states.every((s) => s);
  const [labelIcon, label]: [RsvpBucket | null, string] = states.every((s) => s === 'going')
    ? ['going', 'Going']
    : states.every((s) => s === 'not_going')
      ? ['out', 'Not going']
      : states.some((s) => s)
        ? [null, 'RSVP · some answered']
        : [null, 'RSVP'];
  const tone = !answeredAll ? '' : labelIcon === 'going' ? ' going' : labelIcon === 'out' ? ' out' : ' mixed';

  async function answer(k: RsvpChild, going: boolean, reason?: RsvpReason, note?: string) {
    setBusy(true);
    setPending(k.playerId);
    setError(null);
    try {
      await save(kind, itemId, teamId, k.playerId, going, reason, note);
      setAskWhy(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your RSVP.');
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="rsvp">
      <button
        type="button"
        className={`btn ${big ? '' : 'btn-sm'} rsvp-btn${tone}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {labelIcon ? <RsvpIcon kind={labelIcon} /> : <span aria-hidden="true">🙋</span>}
        {label}
        <svg className={`rt-chev${open ? ' up' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="rsvp-panel">
          {kids.map((k) => {
            const state = rsvpState(kind, k.status);
            return (
              <div key={k.playerId} className="rsvp-kid">
                <div className="rsvp-kid-head">
                  <span className="person-name">{k.name}</span>
                  {state === 'not_going' && k.reason && (
                    <span className="sub">{nameWithReason('', k.reason, k.note).replace(/^ \(|\)$/g, '')}</span>
                  )}
                </div>
                <div className="rsvp-choice" role="group" aria-label={`${k.name}: going or not going`}>
                  <button
                    type="button"
                    className={`rsvp-opt going${state === 'going' ? ' on' : ''}`}
                    aria-pressed={state === 'going'}
                    disabled={busy}
                    onClick={() => void answer(k, true)}
                  >
                    <RsvpIcon kind="going" /> Going
                  </button>
                  <button
                    type="button"
                    className={`rsvp-opt out${state === 'not_going' ? ' on' : ''}`}
                    aria-pressed={state === 'not_going'}
                    disabled={busy}
                    onClick={() => setAskWhy(askWhy === k.playerId ? null : k.playerId)}
                  >
                    <RsvpIcon kind="out" /> Not going
                  </button>
                </div>
                {askWhy === k.playerId && (
                  <div className="rsvp-why">
                    <span className="sub">Why not?</span>
                    <div className="checkin-buttons">
                      {RSVP_REASONS.filter(([r]) => r !== 'other').map(([r, text]) => (
                        <button
                          key={r}
                          type="button"
                          className="btn btn-sm ghost"
                          disabled={busy}
                          onClick={() => void answer(k, false, r)}
                        >
                          {REASON_ICON[r]} {text}
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <input
                        style={{ flex: '1 1 180px' }}
                        maxLength={200}
                        placeholder="Other: add a comment (optional)"
                        value={other[k.playerId] ?? ''}
                        onChange={(e) => setOther((p) => ({ ...p, [k.playerId]: e.target.value }))}
                        aria-label="Other reason, optional comment"
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void answer(k, false, 'other', other[k.playerId])}
                      >
                        {REASON_ICON.other} Other
                      </button>
                    </div>
                  </div>
                )}
                {pending === k.playerId && <span className="sub">Saving…</span>}
              </div>
            );
          })}
          {error && <p className="danger-text">{error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Who is coming. Staff see names (and why someone is not coming) on tap;
 * everyone else sees the team totals only.
 */
export function RsvpSummary({ counts, summary }: { counts?: TallyCounts | null; summary?: TallyNames | null }) {
  return <RsvpTally counts={counts} names={summary} />;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lineup';
}

function download(ics: string, filename: string) {
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * "Add to your own calendar" for a whole category (games, practices, team
 * events): every upcoming item in it as one .ics file. A premium feature: on
 * the free plan it is the one lock per category that opens the plans.
 */
export function AddCategoryToCalendar({ label, items }: { label: string; items: IcsEvent[] }) {
  const allowed = useFeature('addToCalendar');
  if (!allowed) {
    return (
      <a className="add-cal-cat locked" href="/account#plans" title="See plans">
        <span aria-hidden="true">🔒</span> Add {label.toLowerCase()} to your own calendar · Premium feature
      </a>
    );
  }
  if (items.length === 0) return null;
  return (
    <button
      type="button"
      className="add-cal-cat"
      onClick={() => download(buildIcsCalendar(items), `${slug(label)}.ics`)}
    >
      ＋ Add {items.length} {label.toLowerCase()} to your own calendar
    </button>
  );
}

/**
 * "＋" adds one game, practice or event to the person's own calendar (an
 * .ics file their phone or computer opens). A premium feature: on the free
 * plan nothing shows here; the lock is offered once per category instead.
 */
export function AddToCalendar({
  uid,
  title,
  date,
  time,
  durationMinutes,
  location,
  description,
}: {
  uid: string;
  title: string;
  date: string;
  time?: string | null;
  durationMinutes?: number;
  location?: string | null;
  description?: string | null;
}) {
  const allowed = useFeature('addToCalendar');
  if (!allowed) return null;
  return (
    <button
      type="button"
      className="btn ghost btn-sm add-cal"
      title="Add to my calendar"
      aria-label="Add to my calendar"
      onClick={() => download(buildIcs({ uid, title, date, time, durationMinutes, location, description }), `${slug(title)}-${date}.ics`)}
    >
      <svg className="cal-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
        <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3M8 8.5v3M6.5 10h3" />
      </svg>
      <span>Add to calendar</span>
    </button>
  );
}
