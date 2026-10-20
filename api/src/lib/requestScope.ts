import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request memo. A request asks "who is this, what plan, which teams" in
 * several places (the guard, feature checks, the handler); each answer is
 * looked up once per request instead of once per question.
 *
 * Only reads are remembered, and any write in the request forgets them all
 * (see db.ts), so a request that changes a plan or membership and reads it
 * back sees the new value. Nothing is shared between requests.
 */
const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** Run fn inside a fresh request scope. */
export function withRequestScope<T>(fn: () => T): T {
  return scope.run(new Map(), fn);
}

/** Run fn outside any request scope (background jobs started by a request). */
export function outsideRequestScope<T>(fn: () => T): T {
  return scope.exit(fn);
}

/** The value for key in this request, computing it once. Outside a request it just computes. */
export function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const store = scope.getStore();
  if (!store) return fn();
  const hit = store.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const p = fn();
  store.set(key, p);
  // A failed lookup is not remembered, so a retry in the same request can succeed.
  p.catch(() => {
    if (store.get(key) === p) store.delete(key);
  });
  return p;
}

/** Seed a value already known (for example read with the caller's account row). */
export function prime<T>(key: string, value: T): void {
  scope.getStore()?.set(key, Promise.resolve(value));
}

/** Forget everything remembered in this request (after a write). */
export function forgetRequestMemo(): void {
  scope.getStore()?.clear();
}
