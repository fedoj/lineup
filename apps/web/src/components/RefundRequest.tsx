import { useEffect, useState } from 'react';
import { api, type RefundRequest as RefundRequestRow } from '../lib/api';

const REFUND_STATUS: Record<string, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  declined: 'Declined',
  refunded: 'Refunded',
};

/** Ask for a refund of your own plan, and see how earlier requests went (Help & support, Refund). */
export function RefundRequest({ startOpen = false }: { startOpen?: boolean }) {
  const [history, setHistory] = useState<RefundRequestRow[] | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.refunds().then(setHistory).catch(() => setHistory([]));
  };
  useEffect(load, []);

  const pending = history?.some((r) => r.status === 'pending');

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.requestRefund(reason.trim());
      setOpen(false);
      setReason('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="refund">
      {history && history.length > 0 && (
        <p className="note">
          Refund request from {new Date(history[0].createdAt).toLocaleDateString()}:{' '}
          <strong>{REFUND_STATUS[history[0].status] ?? history[0].status}</strong>
          {history[0].adminNote ? ` · ${history[0].adminNote}` : ''}
        </p>
      )}
      {!pending && !open && (
        <button type="button" className="linkish" onClick={() => setOpen(true)}>
          Request a refund
        </button>
      )}
      {open && (
        <>
          <label>
            Why would you like a refund?
            <textarea value={reason} rows={3} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <p className="danger-text">{error}</p>}
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={busy || reason.trim().length < 5} onClick={submit}>
              Send request
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
