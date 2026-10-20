import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppNotification } from '../lib/api';

const POLL_MS = 60_000;

/**
 * The bell in the header: unread count, and a panel of the latest messages.
 * Opening the panel marks everything read. Polls once a minute while the tab
 * is visible, so a broadcast shows up without a reload.
 */
export default function NotificationBell({ onOpen }: { onOpen?: (link: string) => void }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .notifications()
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      // Items keep their unread styling for this viewing, so new ones stand out.
      api
        .markNotificationsRead({ all: true })
        .then((r) => setUnread(r.unread))
        .catch(() => undefined);
    }
  }

  return (
    <div className="bell" ref={ref}>
      <button
        type="button"
        className="btn ghost bell-btn"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={toggle}
      >
        🔔
        {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <h3>Notifications</h3>
          {items.length === 0 ? (
            <p className="note">Nothing yet.</p>
          ) : (
            <ul className="bell-list">
              {items.map((n) => {
                // Links inside the app open in place (the right team, screen
                // and item); anything else opens in a new tab.
                const inApp = Boolean(n.link && n.link.startsWith('/') && onOpen);
                const open = () => {
                  if (!n.link) return;
                  setOpen(false);
                  if (inApp) onOpen!(n.link);
                  else window.open(n.link, '_blank', 'noopener,noreferrer');
                };
                const more = (n.batch ?? 1) - 1;
                // A chat notification: who wrote first (their child lighter), then "and N more".
                const text = n.fromName ? (
                  <>
                    <p>
                      <span className="bell-from">{n.fromName}</span>
                      {n.fromDetail && <span className="bell-from-detail"> – {n.fromDetail}</span>}: {n.body}
                    </p>
                    {more > 0 && (
                      <p className="bell-more">
                        and {more} more {more === 1 ? 'message' : 'messages'}
                      </p>
                    )}
                  </>
                ) : (
                  <p>{n.body}</p>
                );
                return (
                  <li key={n.id} className={`${n.readAt ? '' : 'unread'}${n.link ? ' has-link' : ''}`}>
                    {n.link ? (
                      <button type="button" className="bell-item" onClick={open}>
                        <strong>{n.title}</strong>
                        {text}
                        <span className="sub">
                          {new Date(n.createdAt).toLocaleString()} · <span className="bell-open">Open ›</span>
                        </span>
                      </button>
                    ) : (
                      <>
                        <strong>{n.title}</strong>
                        {text}
                        <span className="sub">{new Date(n.createdAt).toLocaleString()}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
