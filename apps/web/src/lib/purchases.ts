import { LIVE_ORIGIN, TEST_ORIGIN } from './appSite';
import { isNativeApp, platform } from './native';

/**
 * Where plans are bought (Fady, 10/16: option A).
 *
 * On the website people subscribe with Stripe. The store apps (Google Play
 * now, the App Store later) sell nothing themselves: the premium locks and the
 * plan table stay, and Subscribe, Manage billing and Resume open the website in
 * the phone's browser, where people sign in with the same account. A plan
 * belongs to the account, so it shows in the app as soon as they come back.
 * Both stores allow such links on their US storefronts. Selling inside the
 * apps later (Google Play Billing, Apple in-app purchase) would plug in here
 * and turn on the same plan on the server.
 */
export function buysOnWebsite(): boolean {
  return isNativeApp();
}

/** "Google Play" or "the App Store", for wording. */
export function storeName(): string {
  return platform() === 'ios' ? 'the App Store' : 'Google Play';
}

/** The website the app shows (the live site, or the test site in a test app). */
export function websiteOrigin(): string {
  return location.origin === TEST_ORIGIN ? TEST_ORIGIN : LIVE_ORIGIN;
}

/** "lineup.mahoul.io", for wording. */
export function websiteHost(): string {
  return new URL(websiteOrigin()).host;
}

/** Marks a website visit that started in the app, so Account can say "go back to the app". */
export const FROM_APP_KEY = 'lineup.fromApp';

/**
 * Open a page of the website in the phone's browser (not inside the app), or
 * just go there on the website itself.
 */
export async function openWebsite(path: string): Promise<void> {
  const url = new URL(path, websiteOrigin()).toString();
  if (!isNativeApp()) {
    location.href = url;
    return;
  }
  try {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } catch {
    // An app built before the browser plugin: the system decides where it opens.
    window.open(url, '_system');
  }
}
