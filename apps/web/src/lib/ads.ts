import { isNativeApp, platform } from './native';

/**
 * Google AdMob, Android app "Lineup".
 *
 * The Android app is a Capacitor shell around the live site, so this code runs
 * on the web too; everything here is a no-op unless the page is inside the
 * native Android app.
 */
export const ADMOB = {
  appId: 'ca-app-pub-6869341797976525~4032285289',
  androidBanner: 'ca-app-pub-6869341797976525/4158162386',
  /** Google's published sample banner unit. Always safe to load. */
  testBanner: 'ca-app-pub-3940256099942544/6300978111',
} as const;

/** Production host. Every other host (dev, local) gets Google test ads only. */
const LIVE_HOST = 'lineup.mahoul.io';

/**
 * Ads are switched off for now (Fady, 10/14/2026): no ad slot renders and the
 * AdSense and AdMob scripts are never loaded, on the website or in the app.
 * Flip back to true to bring them back; everything else is unchanged.
 */
export const ADS_ENABLED = false;

/**
 * Request non-personalised ads. The app is used by coaches and parents of
 * youth teams, so ads are kept free of interest-based targeting.
 */
export const NON_PERSONALIZED = true;

export function isNativeAndroid(): boolean {
  return platform() === 'android';
}

/**
 * Google AdSense, website only. Google does not allow AdSense inside an app's
 * web view, so the Android app uses AdMob instead and never loads this.
 */
export const ADSENSE = {
  client: 'ca-pub-6869341797976525',
  /**
   * Ad units from the AdSense console, per placement. A placement uses its
   * fixed-size unit where the screen is wide enough to hold it, and its
   * responsive unit everywhere else (phones). A null placement stays empty.
   */
  slots: {
    top: {
      // "mobile", responsive, created 10/11/2026. Used on every screen as a
      // horizontal banner that fills the page width: Google picks the banner
      // size that fits the space, from phone to laptop.
      narrow: { id: '5115326306' },
      // The fixed 728x50 unit "fixed banner adds" (8029797086, 10/10/2026) is
      // not used: Google does not allow stretching a fixed unit to the page
      // width, and it left empty space on wide screens.
    } as AdPlacement | null,
    bottom: null as AdPlacement | null,
  },
} as const;

export interface AdUnit {
  id: string;
  /** Fixed-size units only; a responsive unit sizes itself. */
  width?: number;
  height?: number;
}

export interface AdPlacement {
  /** Fixed unit for screens at least its width (plus page padding). */
  wide?: AdUnit;
  /** Responsive unit for everything narrower. */
  narrow?: AdUnit;
}

/**
 * Real AdSense ads only on the production website. Every other host asks for
 * test ads (data-adtest), so development never counts as ad traffic.
 */
export function webAdsLive(): boolean {
  return typeof location !== 'undefined' && location.hostname === LIVE_HOST;
}

let adsenseRequested = false;

/** Load the AdSense script once, on the website, for people who see ads. */
export function loadAdSense(): void {
  if (!ADS_ENABLED || adsenseRequested || isNativeApp() || typeof document === 'undefined') return;
  adsenseRequested = true;
  // Non-personalised ads, matching the Android app. Must be set before the
  // first ad request.
  const w = window as unknown as { adsbygoogle?: unknown[] & { requestNonPersonalizedAds?: number } };
  w.adsbygoogle = w.adsbygoogle || [];
  if (NON_PERSONALIZED) w.adsbygoogle.requestNonPersonalizedAds = 1;
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE.client}`;
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
}

/**
 * Real ad units only in the production Android app. Serving live ads to
 * development builds generates invalid traffic and can get the account
 * suspended, so anything else uses Google's test units.
 */
export function adsLive(): boolean {
  return isNativeAndroid() && typeof location !== 'undefined' && location.hostname === LIVE_HOST;
}
