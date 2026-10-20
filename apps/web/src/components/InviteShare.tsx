import { useState } from 'react';
import type { InviteCreated } from '../lib/api';

/**
 * Shown after an invite is created. Says whether the email went out and
 * always offers the link too, so an invite never depends on email alone.
 */
export default function InviteShare({
  invite,
  onClose,
}: {
  invite: InviteCreated;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(invite.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const subject = `Join ${invite.scopeName} on Lineup`;
  const mailto = `mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(invite.shareText)}`;
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(invite.shareText)}`;

  return (
    <section className="card invite-share" role="status">
      <div className="card-head">
        <h2>Invite ready</h2>
        <button type="button" className="chip-x" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="note">
        {invite.emailed
          ? `Emailed to ${invite.email}. You can also send the link yourself:`
          : `Send this link to ${invite.email}. It works once and expires on ${new Date(
              invite.expiresAt,
            ).toLocaleDateString()}.`}
      </p>
      <input className="search" readOnly value={invite.link} onFocus={(e) => e.target.select()} />
      <div className="row">
        <button type="button" className="btn ghost btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a className="btn ghost btn-sm" href={whatsapp} target="_blank" rel="noopener noreferrer">
          WhatsApp
        </a>
        <a className="btn ghost btn-sm" href={mailto}>
          Email
        </a>
      </div>
      {invite.emailStatus === 'failed' && (
        <p className="note warn">The automatic email did not go through, so use the link.</p>
      )}
    </section>
  );
}
