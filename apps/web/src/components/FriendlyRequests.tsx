import { useCallback, useEffect, useState } from 'react';
import { api, type FriendlyRequest } from '../lib/api';
import { prettyDate, prettyTime } from '../screens/Calendar';

/**
 * Friendly requests between teams of one organization (Shadi, 10/20). On a
 * team's calendar: the ones it asked for or was asked to play, waiting for
 * approval (or not approved). On a region's or organization's Games tab:
 * the ones its staff approve or decline.
 */
export default function FriendlyRequests({
  query,
  onChanged,
}: {
  query: { teamId: string } | { scope: 'region' | 'org'; id: string };
  /** A request was approved: the calendars changed. */
  onChanged?: () => void;
}) {
  const [list, setList] = useState<FriendlyRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const key = 'teamId' in query ? `t:${query.teamId}` : `${query.scope}:${query.id}`;
  const staff = !('teamId' in query);

  const load = useCallback(() => {
    api
      .friendlyRequests(query)
      .then((r) => setList(r.requests))
      .catch(() => setList([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(load, [load]);

  async function act(r: FriendlyRequest, action: 'approve' | 'decline' | 'cancel') {
    setBusy(r.id);
    setMsg(null);
    try {
      const out = await api.friendlyRequestAction({ action, id: r.id, reason: action === 'decline' ? reason.trim() || undefined : undefined });
      setMsg(
        action === 'approve'
          ? out.status === 'approved'
            ? `Approved. ${r.teamName} v ${r.opponentName} is on both teams' calendars.`
            : `Approved for your side. Still waiting for ${out.waitingFor ?? 'the other region'}.`
          : action === 'decline'
            ? 'Declined. The coach who asked has been told.'
            : 'Request cancelled.',
      );
      setDeclining(null);
      setReason('');
      load();
      if (out.status === 'approved') onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  if (!list) return null;
  // A team sees what is waiting and what was not approved; staff see what is waiting and what they decided lately.
  const shown = staff ? list.filter((r) => r.status !== 'cancelled') : list.filter((r) => r.status === 'pending' || r.status === 'declined');
  if (shown.length === 0 && !staff) return null;

  return (
    <section className="card friendly-requests">
      <h2>Friendly requests</h2>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="note">
          No requests right now. When a coach asks to play a friendly against another team here, it shows up for you to
          approve.
        </p>
      ) : (
        <ul className="comp-list">
          {shown.map((r) => {
            const title = r.isHome ? `${r.teamName} v ${r.opponentName}` : `${r.opponentName} v ${r.teamName}`;
            const regions = [r.teamRegion, r.opponentRegion].filter(Boolean);
            const where = [prettyDate(r.date), prettyTime(r.kickoff), r.location].filter(Boolean).join(' · ');
            const state =
              r.status === 'pending'
                ? `Waiting for ${r.waitingFor ?? 'approval'}`
                : r.status === 'approved'
                  ? 'Approved'
                  : r.status === 'declined'
                    ? `Not approved${r.declineReason ? `: ${r.declineReason}` : ''}`
                    : 'Cancelled';
            return (
              <li key={r.id} className="friendly-request">
                <div className="comp-card upcoming" role="group" aria-label={title}>
                  <span className="comp-icon" aria-hidden="true">
                    🤝
                  </span>
                  <span className="comp-main">
                    <strong>{title}</strong>
                    <span className="sub">{where}</span>
                    <span className="sub">
                      {r.requestedBy ? `Asked by ${r.requestedBy} for ${r.teamName}` : `Asked for ${r.teamName}`}
                      {regions.length === 2 && regions[0] !== regions[1] ? ` · ${regions.join(' and ')}` : ''}
                    </span>
                    <span className="sub">{state}</span>
                  </span>
                </div>
                {(r.canApprove || r.canCancel) && (
                  <div className="row">
                    {r.canApprove && (
                      <>
                        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act(r, 'approve')}>
                          {busy === r.id ? 'Saving…' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          disabled={busy !== null}
                          onClick={() => setDeclining(declining === r.id ? null : r.id)}
                        >
                          Decline
                        </button>
                      </>
                    )}
                    {r.canCancel && !r.canApprove && (
                      <button type="button" className="btn ghost btn-sm" disabled={busy !== null} onClick={() => void act(r, 'cancel')}>
                        Cancel request
                      </button>
                    )}
                  </div>
                )}
                {declining === r.id && (
                  <div className="row">
                    <input
                      aria-label="Reason (optional)"
                      placeholder="Reason (optional), e.g. that field is booked"
                      maxLength={300}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <button type="button" className="btn btn-sm danger" disabled={busy !== null} onClick={() => void act(r, 'decline')}>
                      Decline request
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
