import { lazy, type ComponentType } from 'react';

/**
 * A screen in its own file, loaded the first time it is shown, that can also
 * be loaded ahead of time (preload) while the app is idle. Once loaded it
 * renders straight away, without a "Loading…" flash: React.lazy accepts a
 * thenable, and a module already in hand is handed over synchronously.
 */
export function lazyScreen<P extends object>(factory: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: { default: ComponentType<P> } | null = null;
  let loading: Promise<{ default: ComponentType<P> }> | null = null;
  const load = () =>
    (loading ??= factory().then(
      (m) => (loaded = m),
      (e) => {
        loading = null;
        throw e;
      },
    ));
  const Component = lazy(() =>
    loaded
      ? ({ then: (resolve: (m: { default: ComponentType<P> }) => void) => resolve(loaded!) } as unknown as Promise<{
          default: ComponentType<P>;
        }>)
      : load(),
  );
  return Object.assign(Component, { preload: () => load().then(() => undefined, () => undefined) });
}
