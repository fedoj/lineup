/**
 * Are we inside the Android app? The app's native shell defines
 * window.Capacitor before the page runs, so asking it directly avoids loading
 * the whole Capacitor library on the website, where the answer is always no.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitor(): CapacitorGlobal | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNativeApp(): boolean {
  return capacitor()?.isNativePlatform?.() ?? false;
}

/** 'android', 'ios' or 'web'. */
export function platform(): string {
  return capacitor()?.getPlatform?.() ?? 'web';
}
