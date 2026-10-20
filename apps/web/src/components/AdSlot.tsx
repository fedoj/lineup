import { useEffect, useRef, useState } from 'react';
import { ADMOB, ADSENSE, ADS_ENABLED, NON_PERSONALIZED, adsLive, isNativeAndroid, loadAdSense, webAdsLive } from '../lib/ads';

type AdMobModule = typeof import('@capacitor-community/admob');

let ready: Promise<AdMobModule> | null = null;

/**
 * Load and initialise AdMob once per app session, including the consent
 * prompt that Google requires for users in the EEA and UK.
 */
function admob(): Promise<AdMobModule> {
  if (!ready) {
    ready = (async () => {
      const mod = await import('@capacitor-community/admob');
      await mod.AdMob.initialize({ initializeForTesting: !adsLive() });
      try {
        const info = await mod.AdMob.requestConsentInfo();
        if (info.status === mod.AdmobConsentStatus.REQUIRED && info.isConsentFormAvailable) {
          await mod.AdMob.showConsentForm();
        }
      } catch {
        /* consent is best effort; ads still load as non-personalised */
      }
      return mod;
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

/**
 * An ad placement.
 *
 * Android app: the bottom slot shows an AdMob banner pinned to the bottom of
 * the screen, and the top slot is dropped so there is only ever one banner.
 *
 * Website: AdSense. A placement shows its fixed-size unit when the screen is
 * wide enough to hold it (Google does not allow resizing a fixed unit) and its
 * responsive unit otherwise; with neither configured the slot stays empty.
 */
export default function AdSlot({ show: wanted, position }: { show: boolean; position: 'top' | 'bottom' }) {
  const show = ADS_ENABLED && wanted;
  const native = isNativeAndroid();
  const placement = ADSENSE.slots[position];
  const unitRef = useRef<HTMLModElement>(null);
  const query = placement?.wide?.width ? `(min-width: ${placement.wide.width + 32}px)` : null;
  const [wide, setWide] = useState(() =>
    query && typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (!query) return;
    const mq = window.matchMedia(query);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  const unit = (wide ? placement?.wide : placement?.narrow) ?? null;

  useEffect(() => {
    if (native || !show) return;
    loadAdSense();
    if (!unit || !unitRef.current || unitRef.current.dataset.adsbygoogleStatus) return;
    try {
      const w = window as unknown as { adsbygoogle?: unknown[] };
      (w.adsbygoogle = w.adsbygoogle || []).push({});
    } catch {
      /* ad blockers make this throw; the page carries on */
    }
  }, [native, show, unit]);

  useEffect(() => {
    if (!native || !show || position !== 'bottom') return;
    let cancelled = false;
    let removeListener: (() => void) | null = null;
    const root = document.documentElement;

    (async () => {
      const { AdMob, BannerAdPluginEvents, BannerAdPosition, BannerAdSize } = await admob();
      if (cancelled) return;
      const handle = await AdMob.addListener(BannerAdPluginEvents.SizeChanged, (size) => {
        // Keep the page's last rows clear of the banner.
        root.style.setProperty('--ad-inset', `${Math.round(size.height)}px`);
      });
      removeListener = () => void handle.remove();
      const live = adsLive();
      await AdMob.showBanner({
        adId: live ? ADMOB.androidBanner : ADMOB.testBanner,
        adSize: BannerAdSize.ADAPTIVE_BANNER,
        position: BannerAdPosition.BOTTOM_CENTER,
        margin: 0,
        isTesting: !live,
        npa: NON_PERSONALIZED,
      });
    })().catch(() => {
      /* no ad is better than a broken page */
    });

    return () => {
      cancelled = true;
      removeListener?.();
      root.style.setProperty('--ad-inset', '0px');
      void admob()
        .then(({ AdMob }) => AdMob.removeBanner())
        .catch(() => undefined);
    };
  }, [native, show, position]);

  if (!show || native || !unit) return null;
  const fixed = Boolean(unit.width && unit.height);
  return (
    <div className={`ad-slot${position === 'bottom' ? ' bottom' : ''}`}>
      <ins
        key={unit.id}
        ref={unitRef}
        className="adsbygoogle"
        style={fixed ? { display: 'inline-block', width: `${unit.width}px`, height: `${unit.height}px` } : { display: 'block', width: '100%' }}
        data-ad-client={ADSENSE.client}
        data-ad-slot={unit.id}
        {...(fixed ? {} : { 'data-ad-format': 'horizontal', 'data-full-width-responsive': 'true' })}
        {...(webAdsLive() ? {} : { 'data-adtest': 'on' })}
      />
    </div>
  );
}
