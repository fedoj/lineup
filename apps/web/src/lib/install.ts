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

/**
 * Ask permission, then subscribe this device to push and give the
 * subscription to the server. Returns the resulting permission.
 */
export async function turnOnNotifications(publicKey: string, save: (sub: PushSubscriptionJSON) => Promise<unknown>): Promise<NotifyState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission as NotifyState;
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
  await save(sub.toJSON());
  return 'granted';
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
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
  await save(sub.toJSON());
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
