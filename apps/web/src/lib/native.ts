/**
 * Are we inside the Android app? The app's native shell defines
 * window.Capacitor before the page runs, so asking it directly avoids loading
 * the whole Capacitor library on the website, where the answer is always no.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: { PushNotifications?: NativePush };
}

/** The parts of @capacitor/push-notifications the app uses, reached through the native shell. */
export interface NativePush {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  createChannel?(channel: { id: string; name: string; description?: string; importance?: number; visibility?: number }): Promise<void>;
  addListener(event: 'registration', cb: (token: { value: string }) => void): Promise<{ remove(): void }>;
  addListener(event: 'registrationError', cb: (err: unknown) => void): Promise<{ remove(): void }>;
  addListener(
    event: 'pushNotificationActionPerformed',
    cb: (action: { notification: { data?: Record<string, string> } }) => void,
  ): Promise<{ remove(): void }>;
}

function capacitor(): CapacitorGlobal | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** The Android app's push plugin, when this build of the app has it. */
export function nativePush(): NativePush | null {
  return isNativeApp() ? (capacitor()?.Plugins?.PushNotifications ?? null) : null;
}

export function isNativeApp(): boolean {
  return capacitor()?.isNativePlatform?.() ?? false;
}

/** 'android', 'ios' or 'web'. */
export function platform(): string {
  return capacitor()?.getPlatform?.() ?? 'web';
}
