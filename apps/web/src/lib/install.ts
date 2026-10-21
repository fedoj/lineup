import { isNativeApp } from './native';

/**
 * Installing Lineup on the home screen, and notifications (Fady, 10/19).
 *
 * - Chrome, Edge and Android offer an install prompt; we keep it and show our
 *   own "Install the app" button.
 * - iPhone and iPad have no prompt: Safari's Share › "Add to Home Screen" is
 *   the way, so we explain it.
 * - The Android app from the store (Capacitor) is already installed.
 * - Notifications use the service worker and the browser's push service. On
 *   iPhone they only work once Lineup is on the home screen (an Apple rule).
 * - Lineup never asks for location.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Start listening for the browser's install prompt and register the worker. */
export function startInstallSupport() {
  if (typeof window === 'undefined' || isNativeApp()) return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
  if ('serviceWorker' in navigator) {
    // After the page has loaded, so it never slows the first screen.
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
  }
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type Platform = 'ios' | 'android' | 'desktop';

export function platform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac with touch.
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** Running from the home screen (or the store app), not in a browser tab. */
export function isInstalled(): boolean {
  if (isNativeApp()) return true;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** Show the browser's own install prompt. True when the person installed it. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
  notify();
  return choice.outcome === 'accepted';
}

/* --------------------------------------------------------- notifications */

export type NotifyState = 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied';

export function notificationState(): NotifyState {
  if (isNativeApp()) return 'unsupported';
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return platform() === 'ios' && !isInstalled() ? 'needs-install' : 'unsupported';
  }
  return Notification.permission as NotifyState;
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Which step of turning notifications on went wrong, with the browser's reason. */
export class PushSetupError extends Error {
  constructor(
    public step: 'worker' | 'subscribe' | 'save',
    public reason: string,
  ) {
    super(reason);
  }
}

/** A plain-language explanation of why notifications aren't on, and what to do. */
export function pushProblemText(problem: NotifyState | PushSetupError | Error): string {
  if (problem instanceof PushSetupError) {
    if (problem.step === 'subscribe') {
      return /push service|AbortError|NotAllowedError|InvalidStateError/i.test(problem.reason)
        ? 'Your phone allowed notifications, but its browser could not reach the notification service. Use Chrome (in Brave, turn on Settings › Privacy › "Use Google services for push messaging"). Phones without Google Play services can’t get web notifications.'
        : `Your phone allowed notifications, but signing this device up failed (${problem.reason}).`;
    }
    if (problem.step === 'worker') return `Lineup’s notification helper didn’t start on this device (${problem.reason}). Close Lineup fully and open it again.`;
    return 'This device is ready, but saving it to Lineup failed. Check your connection and try again.';
  }
  if (problem === 'denied') {
    return platform() === 'android'
      ? 'Notifications are blocked for Lineup. Hold the Lineup icon › App info › Notifications, and turn them on (in Chrome: Settings › Site settings › Notifications). Then come back here.'
      : 'Notifications are blocked for Lineup. Allow them in your browser or phone settings for this site, then come back here.';
  }
  if (problem === 'default') {
    return 'Your phone didn’t show the “Allow notifications” question, or it was closed. Tap the button again; if nothing appears, check Chrome › Settings › Site settings › Notifications for Lineup.';
  }
  if (problem === 'needs-install') return 'On iPhone and iPad, add Lineup to your home screen first, then open it from there.';
  if (problem === 'unsupported') return 'This browser can’t show notifications. You’ll still see them under the 🔔 bell.';
  return problem instanceof Error ? problem.message : 'Could not turn notifications on.';
}

/**
 * Ask permission, then subscribe this device to push and give the
 * subscription to the server. Returns the resulting permission; throws a
 * PushSetupError when a later step fails.
 */
export async function turnOnNotifications(publicKey: string, save: (sub: PushSubscriptionJSON) => Promise<unknown>): Promise<NotifyState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission as NotifyState;
  await subscribeThisDevice(publicKey, save);
  return 'granted';
}

async function subscribeThisDevice(publicKey: string, save: (sub: PushSubscriptionJSON) => Promise<unknown>) {
  const reason = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
  let reg: ServiceWorkerRegistration;
  try {
    reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
    // `ready` can wait forever if the worker never activates; give up after 10 s.
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, no) => setTimeout(() => no(new Error('the helper did not activate within 10 seconds')), 10000)),
    ]);
  } catch (e) {
    throw new PushSetupError('worker', reason(e));
  }
  let sub: PushSubscription;
  try {
    sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
  } catch (e) {
    throw new PushSetupError('subscribe', reason(e));
  }
  try {
    await save(sub.toJSON());
  } catch (e) {
    throw new PushSetupError('save', reason(e));
  }
}

/** Tell the server how turning notifications on went on this device. */
export function reportPushSetup(
  send: (r: { outcome: string; step?: string; detail?: string; permission?: string; installed?: boolean }) => Promise<unknown>,
  outcome: NotifyState | PushSetupError | Error,
) {
  const permission = typeof Notification === 'undefined' ? 'none' : Notification.permission;
  const r =
    outcome instanceof PushSetupError
      ? { outcome: 'failed', step: outcome.step, detail: outcome.reason }
      : outcome instanceof Error
        ? { outcome: 'failed', step: 'other', detail: `${outcome.name}: ${outcome.message}`.slice(0, 300) }
        : { outcome: outcome === 'granted' ? 'on' : outcome };
  void send({ ...r, permission, installed: isInstalled() }).catch(() => undefined);
}

/** Stop push on this device. */
export async function turnOffNotifications(remove: (endpoint: string) => Promise<unknown>): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await remove(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
}

/** Whether this device is subscribed to push right now. */
export async function pushSubscribed(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(await reg?.pushManager.getSubscription());
}

/**
 * When this device already allowed notifications, make sure the server has
 * its subscription (subscribing again if the browser dropped it). Needs no
 * tap, so it runs once on every app start. True when push is on.
 */
export async function refreshPushSubscription(
  publicKey: string,
  save: (sub: PushSubscriptionJSON) => Promise<unknown>,
): Promise<boolean> {
  if (notificationState() !== 'granted') return false;
  await subscribeThisDevice(publicKey, save);
  return true;
}

const ASK_KEY = 'lineup.notifyAskClosed';

/**
 * Whether to ask "Turn on notifications?" when Lineup opens: on phones and
 * installed apps where the person hasn't been asked yet, and not again for
 * two weeks after "Not now". Browsers only show their own permission prompt
 * after a tap, so we ask first and the tap brings up the phone's prompt.
 */
export function shouldAskForNotifications(): boolean {
  if (isNativeApp() || notificationState() !== 'default') return false;
  if (!isInstalled() && platform() !== 'android') return false;
  const closed = Number(localStorage.getItem(ASK_KEY) ?? 0);
  return !closed || Date.now() - closed > 14 * 24 * 3600 * 1000;
}

export function closeNotificationAsk() {
  localStorage.setItem(ASK_KEY, String(Date.now()));
}
