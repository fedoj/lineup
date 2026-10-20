import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  canPromptInstall,
  closeNotificationAsk,
  isInstalled,
  notificationState,
  onInstallChange,
  platform,
  promptInstall,
  pushSubscribed,
  refreshPushSubscription,
  shouldAskForNotifications,
  turnOffNotifications,
  turnOnNotifications,
  type NotifyState,
} from '../lib/install';
import { isNativeApp } from '../lib/native';

/**
 * Account › The Lineup app (Fady, 10/19): install it on the home screen, and
 * turn notifications on for this device. Never asks for location.
 */
export default function InstallCard() {
  const [installed, setInstalled] = useState(isInstalled());
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [notify, setNotify] = useState<NotifyState>(notificationState());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const os = platform();

  useEffect(
    () =>
      onInstallChange(() => {
        setInstalled(isInstalled());
        setCanPrompt(canPromptInstall());
      }),
    [],
  );
  useEffect(() => {
    void pushSubscribed().then(setSubscribed);
  }, []);

  if (isNativeApp()) return null;

  async function install() {
    setError(null);
    const ok = await promptInstall();
    setInstalled(isInstalled() || ok);
    setCanPrompt(canPromptInstall());
    if (ok) setMsg('Lineup is on your home screen. Open it from there next time.');
  }

  async function enableNotifications() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const info = await api.push();
      if (!info.available || !info.publicKey) {
        setError('Notifications are not set up on this site yet.');
        return;
      }
      const state = await turnOnNotifications(info.publicKey, (sub) => api.savePush(sub));
      setNotify(state);
      setSubscribed(state === 'granted');
      if (state === 'granted') void api.testPush().catch(() => undefined);
      setMsg(
        state === 'granted'
          ? 'Notifications are on for this device. A test one is on its way.'
          : state === 'denied'
            ? 'Notifications are blocked. You can allow them in your browser or phone settings for this site.'
            : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn notifications on');
    } finally {
      setBusy(false);
    }
  }

  async function disableNotifications() {
    setBusy(true);
    setError(null);
    try {
      await turnOffNotifications((endpoint) => api.removePush(endpoint));
      setSubscribed(false);
      setMsg('Notifications are off for this device.');
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.testPush();
      setMsg(r.sent > 0 ? 'Test sent. It should pop up in a few seconds.' : 'No device got it. Turn notifications off and on again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send a test');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" id="install">
      <h2>The Lineup app</h2>

      <h3 className="group-title">On your home screen</h3>
      {installed ? (
        <p className="note">✓ You’re using Lineup from your home screen.</p>
      ) : canPrompt ? (
        <>
          <p className="note">Add Lineup to your home screen or desktop, so it opens like an app, full screen, with one tap.</p>
          <button type="button" className="btn btn-sm" onClick={() => void install()}>
            📲 Install the app
          </button>
        </>
      ) : os === 'ios' ? (
        <ol className="install-steps">
          <li>
            In Safari, tap the <strong>Share</strong> button <span aria-hidden="true">⬆️</span> at the bottom (on iPad, at the top).
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
          <li>Open Lineup from the new icon on your home screen.</li>
        </ol>
      ) : os === 'android' ? (
        <ol className="install-steps">
          <li>
            In Chrome, tap the menu <span aria-hidden="true">⋮</span> at the top right.
          </li>
          <li>
            Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>).
          </li>
        </ol>
      ) : (
        <p className="note">
          In Chrome or Edge, use the install icon in the address bar, or the menu › <strong>Install Lineup</strong>.
        </p>
      )}

      <h3 className="group-title">Notifications</h3>
      {notify === 'needs-install' ? (
        <p className="note">On iPhone and iPad, add Lineup to your home screen first (above), then open it from there to turn on notifications.</p>
      ) : notify === 'unsupported' ? (
        <p className="note">This browser can’t show notifications. You’ll still see them under the 🔔 bell in Lineup.</p>
      ) : notify === 'denied' ? (
        <p className="note">Notifications are blocked for Lineup. Allow them in your browser or phone settings for this site, then come back here.</p>
      ) : subscribed && notify === 'granted' ? (
        <div className="row">
          <span className="note">✓ Notifications are on for this device: game changes, messages, sign-ups and reminders.</span>
          <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void sendTest()}>
            Send a test
          </button>
          <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void disableNotifications()}>
            Turn off
          </button>
        </div>
      ) : (
        <>
          <p className="note">
            Get a notification on this device when a game changes, someone messages the team, or it’s time to say if you’re
            going. Your phone asks you to allow it.
          </p>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void enableNotifications()}>
            {busy ? 'Turning on…' : '🔔 Turn on notifications'}
          </button>
        </>
      )}
      <p className="sub">Lineup never asks for your location.</p>
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}

/**
 * A small banner for phone browsers where Lineup isn't installed yet, until
 * the person installs it or closes the banner (Fady, 10/19).
 */
export function InstallBanner({ onOpen }: { onOpen: () => void }) {
  const KEY = 'lineup.installBannerClosed';
  const [hidden, setHidden] = useState(() => isNativeApp() || isInstalled() || platform() === 'desktop' || Boolean(localStorage.getItem(KEY)));
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  useEffect(() => onInstallChange(() => {
    setCanPrompt(canPromptInstall());
    if (isInstalled()) setHidden(true);
  }), []);
  if (hidden) return null;
  return (
    <div className="install-banner" role="region" aria-label="Install the app">
      <span>📲 Get Lineup on your home screen</span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          if (canPrompt) void promptInstall();
          else onOpen();
        }}
      >
        {canPrompt ? 'Install' : 'How'}
      </button>
      <button
        type="button"
        className="chip-x"
        aria-label="Close"
        onClick={() => {
          localStorage.setItem(KEY, String(Date.now()));
          setHidden(true);
        }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * "Turn on notifications?" when Lineup opens on a phone or as an installed
 * app, until the person answers (Fady, 10/20). Phones only show their own
 * "Allow notifications" prompt after a tap, so this asks first; "Allow" then
 * brings up the phone's prompt. Where notifications were already allowed it
 * quietly makes sure this device is registered.
 */
export function NotifyAsk() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (isNativeApp()) return;
    let alive = true;
    const t = window.setTimeout(() => {
      if (notificationState() === 'granted') {
        void api
          .push()
          .then((info) => (info.available && info.publicKey ? refreshPushSubscription(info.publicKey, (sub) => api.savePush(sub)) : false))
          .catch(() => undefined);
      } else if (alive && shouldAskForNotifications()) {
        void api
          .push()
          .then((info) => alive && info.available && setShow(true))
          .catch(() => undefined);
      }
    }, 1500);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, []);

  if (!show) return null;

  async function allow() {
    setBusy(true);
    try {
      const info = await api.push();
      if (!info.publicKey) return setShow(false);
      const state = await turnOnNotifications(info.publicKey, (sub) => api.savePush(sub));
      closeNotificationAsk();
      if (state === 'granted') {
        void api.testPush().catch(() => undefined);
        setDone('✓ Notifications are on. You’ll get a test one now.');
      } else if (state === 'denied') {
        setDone('Notifications are blocked. You can allow them later in your phone settings for Lineup.');
      } else {
        setShow(false);
      }
      window.setTimeout(() => setShow(false), 5000);
    } catch {
      setDone('Could not turn notifications on. Try Account › The Lineup app.');
      window.setTimeout(() => setShow(false), 5000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="install-banner notify-ask" role="region" aria-label="Notifications">
      {done ? (
        <span>{done}</span>
      ) : (
        <>
          <span>🔔 Get a notification when a game changes or the team messages you?</span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void allow()}>
            {busy ? '…' : 'Allow'}
          </button>
          <button
            type="button"
            className="btn ghost btn-sm"
            onClick={() => {
              closeNotificationAsk();
              setShow(false);
            }}
          >
            Not now
          </button>
        </>
      )}
    </div>
  );
}