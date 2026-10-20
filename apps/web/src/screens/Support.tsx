import { useEffect, useState } from 'react';
import { api, type MeResponse, type SupportComment, type SupportRequest } from '../lib/api';
import { RefundRequest } from '../components/RefundRequest';

const STATUS_LABEL: Record<SupportRequest['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Closed',
};

/** The conversation on one request, oldest first, with the request itself on top. */
export function SupportThread({
  request,
  comments,
  requesterLabel = 'You',
}: {
  request: Pick<SupportRequest, 'body' | 'createdAt'>;
  comments: SupportComment[];
  requesterLabel?: string;
}) {
  return (
    <ol className="thread">
      <li className="msg mine">
        <div className="msg-meta">
          {requesterLabel} · {new Date(request.createdAt).toLocaleString()}
        </div>
        <div className="msg-body">{request.body}</div>
      </li>
      {comments.map((c) => (
        <li key={c.id} className={`msg ${c.authorKind === 'user' ? 'mine' : 'theirs'}`}>
          <div className="msg-meta">
            {c.authorKind === 'user' ? requesterLabel : c.authorName} ·{' '}
            {new Date(c.createdAt).toLocaleString()}
          </div>
          <div className="msg-body">{c.body}</div>
        </li>
      ))}
    </ol>
  );
}

export default function Support({ subscription = null }: { subscription?: MeResponse['subscription'] }) {
  const [kind, setKind] = useState<'help' | 'refund'>('help');
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Only the person paying for their own plan asks for a refund, after cancelling it.
  const hasPaidPlan = Boolean(subscription && subscription.scope === 'personal' && subscription.status !== 'expired');
  const canRefund = Boolean(hasPaidPlan && subscription?.status === 'cancelled');

  useEffect(() => {
    let cancelled = false;
    api
      .supportRequests()
      .then((rows) => !cancelled && setRequests(rows))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const created = await api.createSupportRequest({ subject, body: details });
      setRequests((prev) => [{ ...created, comments: created.comments ?? [] }, ...prev]);
      setSubject('');
      setDetails('');
      setMsg(
        created.scoutEligible
          ? 'Support request submitted. Scout can pick this up for remediation.'
          : 'Support request submitted.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to submit support request');
    } finally {
      setSaving(false);
    }
  }

  async function sendReply(r: SupportRequest) {
    const text = (reply[r.id] ?? '').trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    try {
      const c = await api.addSupportComment(r.id, text);
      setRequests((prev) =>
        prev.map((x) =>
          x.id === r.id
            ? {
                ...x,
                comments: [...x.comments, c],
                // A reply on a closed request reopens it on the server too.
                status: x.status === 'resolved' || x.status === 'dismissed' ? 'open' : x.status,
              }
            : x,
        ),
      );
      setReply((p) => ({ ...p, [r.id]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send reply');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {error && <section className="card err">{error}</section>}

      <section className="card">
        <h2>Help & support</h2>
        <p className="note">
          Tell us what went wrong or what you need changed. Include the team,
          game or player name when it helps us find the issue. To see what each
          role can do, read <a href="/help/roles" target="_blank" rel="noopener noreferrer">Who does what</a>.
        </p>
        {/* A refund is its own kind of request, open only once the paid plan
            is cancelled (Account, Manage billing). */}
        <label>
          What is this about?
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="help">Help, a problem or an idea</option>
            <option value="refund" disabled={!canRefund}>
              {canRefund ? 'Refund' : 'Refund (you must cancel your subscription first)'}
            </option>
          </select>
        </label>
        {!canRefund && hasPaidPlan && (
          <p className="note">To ask for a refund, cancel your subscription first: Account, Manage billing.</p>
        )}
        {kind === 'refund' && canRefund ? (
          <RefundRequest startOpen />
        ) : (
          <>
        <label>
          Subject
          <input
            value={subject}
            maxLength={120}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What do you need help with?"
          />
        </label>
        <label>
          Details
          <textarea
            value={details}
            maxLength={4000}
            rows={7}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Describe the request, bug or data fix."
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={saving || !subject.trim() || !details.trim()}
          onClick={submit}
        >
          {saving ? 'Submitting…' : 'Submit support request'}
        </button>
          </>
        )}
      </section>

      <section className="card">
        <h2>Your requests</h2>
        {requests.length === 0 ? (
          <p className="note">No support requests yet.</p>
        ) : (
          <ul className="tickets">
            {requests.map((r) => {
              const open = openId === r.id;
              const replies = r.comments.filter((c) => c.authorKind !== 'user').length;
              return (
                <li key={r.id} className={`ticket ${open ? 'open' : ''}`}>
                  <button
                    type="button"
                    className="ticket-head"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : r.id)}
                  >
                    <span className="ticket-subject">{r.subject}</span>
                    <span className={`status-pill s-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    <span className="sub">
                      {new Date(r.createdAt).toLocaleDateString()}
                      {replies > 0 && ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}`}
                    </span>
                  </button>
                  {open && (
                    <div className="ticket-body">
                      <SupportThread request={r} comments={r.comments} />
                      <label>
                        Reply
                        <textarea
                          rows={3}
                          maxLength={4000}
                          value={reply[r.id] ?? ''}
                          placeholder={
                            r.status === 'resolved' || r.status === 'dismissed'
                              ? 'Replying reopens this request.'
                              : 'Add details or answer a question from support.'
                          }
                          onChange={(e) => setReply((p) => ({ ...p, [r.id]: e.target.value }))}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={saving || !(reply[r.id] ?? '').trim()}
                        onClick={() => sendReply(r)}
                      >
                        Send reply
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
