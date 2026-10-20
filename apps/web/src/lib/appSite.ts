import { isNativeApp } from './native';

/**
 * Test mode for the Android app (Fady, 10/16). The store app loads the live
 * site; a platform admin can switch that phone's app to the test site
 * (lineup-dev) from the admin console, and back from a banner on the test
 * site. The choice is kept on the phone, so the app reopens where it was left.
 * Nothing changes on the website, where the switch is never offered.
 */

export const LIVE_ORIGIN = 'https://lineup.mahoul.io';
export const TEST_ORIGIN = 'https://lineup-dev.mahoul.io';
const KEY = 'lineup.appSite';

/** The app is showing the test site. */
export function onTestSite(): boolean {
  return typeof location !== 'undefined' && location.origin === TEST_ORIGIN;
}

/**
 * Run before the app draws: on the live site inside the Android app, go to
 * the test site when the switch is on; "?appSite=live" (from the test site's
 * banner) turns it off.
 */
export function applyAppSite(): boolean {
  if (!isNativeApp() || location.origin !== LIVE_ORIGIN) return false;
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('appSite') === 'live') {
      localStorage.removeItem(KEY);
      params.delete('appSite');
      history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : '') + location.hash);
      return false;
    }
    if (localStorage.getItem(KEY) === 'test') {
      location.replace(`${TEST_ORIGIN}/`);
      return true;
    }
  } catch {
    /* storage unavailable: stay on the live site */
  }
  return false;
}

/** Admin console: switch this phone's app to the test site. */
export function switchAppToTestSite() {
  try {
    localStorage.setItem(KEY, 'test');
  } catch {
    /* storage unavailable */
  }
  location.href = `${TEST_ORIGIN}/`;
}

/** Test site banner: back to the live site, turning the switch off there. */
export function switchAppToLiveSite() {
  location.href = `${LIVE_ORIGIN}/?appSite=live`;
}
