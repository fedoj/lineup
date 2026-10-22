import { useEffect, useState } from 'react';
import { CHAT_NOTIFY_LABEL, DEFAULT_NOTIFY_PREFS, type ChatNotify, type NotifyPrefs } from '@lineup/shared';
import { api } from '../lib/api';

/**
 * Account › Notifications (Shadi, 10/21): what is pushed to this person's
 * phones and computers. Games, practices and team events on or off, and chat
 * for every message, only @mentions, or never. The 🔔 bell keeps everything;
 * sign-ups, placements and approvals always come through.
 */
export default function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .push()
      .then((r) => setPrefs(r.prefs ?? DEFAULT_NOTIFY_PREFS))
      .catch(() => setPrefs(DEFAULT_NOTIFY_PREFS));
  }, []);

  async function save(change: Partial<NotifyPrefs>) {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, ...change });
    setSaving(true);
    setMsg(null);
    try {
      const r = await api.savePushPrefs(change);
      setPrefs(r.prefs);
      setMsg('Saved.');
    } catch (e) {
      setPrefs(before);
      setMsg(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  if (!prefs) return null;
  const toggles: Array<[keyof Pick<NotifyPrefs, 'games' | 'practices' | 'events'>, string, string]> = [
    ['games', '⚽ Games', 'Reminders, new games and friendlies, changes and lineups'],
    ['practices', '🏃 Practices', 'Reminders and schedule changes'],
    ['events', '🎉 Team events', 'Reminders and new events'],
  ];

  return (
    <section className="card" id="notifications">
      <h2>What to get notified about</h2>
      <p className="note">
        Choose what pops up on your phone or computer. Everything still shows under the 🔔 bell in Lineup, and sign-ups,
        placements and approvals always come through.
      </p>
      <div className="notify-prefs">
        {toggles.map(([key, label, hint]) => (
          <label key={key} className="check notify-pref">
            <input type="checkbox" checked={prefs[key]} disabled={saving} onChange={(e) => void save({ [key]: e.target.checked })} />
            <span>
              <strong>{label}</strong>
              <span className="sub">{hint}</span>
            </span>
          </label>
        ))}
        <label className="notify-pref">
          <span>
            <strong>💬 Chat messages</strong>
            <span className="sub">Type @ and a name in a team chat to mention someone. Staff can mention @everyone.</span>
          </span>
          <select value={prefs.chat} disabled={saving} onChange={(e) => void save({ chat: e.target.value as ChatNotify })}>
            {(Object.keys(CHAT_NOTIFY_LABEL) as ChatNotify[]).map((k) => (
              <option key={k} value={k}>
                {CHAT_NOTIFY_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
