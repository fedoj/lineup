/**
 * Usage counts for the admin console (Fady, 10/19): which pages people open
 * and which buttons they tap. Only the page or button name is counted, never
 * who tapped it or anything they typed. Sent in small batches, straight to
 * /api/usage (not through the cached API client, so it never clears caches).
 */

type Kind = 'page' | 'click';

const queue = new Map<string, { kind: Kind; name: string; n: number }>();
let page = 'start';
let timer: number | null = null;
let started = false;

function add(kind: Kind, name: string) {
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return;
  const key = `${kind}|${clean}`;
  const cur = queue.get(key);
  if (cur) cur.n += 1;
  else queue.set(key, { kind, name: clean, n: 1 });
  if (timer === null) timer = window.setTimeout(flush, 30_000);
}

export function flush() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (queue.size === 0) return;
  const events = [...queue.values()].slice(0, 60);
  queue.clear();
  void fetch('/api/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => undefined);
}

/** A page was opened, e.g. "calendar (team)". */
export function trackPage(name: string) {
  page = name;
  add('page', name);
}

/** The words on a button, or what it's marked as, without anything typed. */
function labelOf(el: HTMLElement): string | null {
  const marked = el.dataset.track ?? el.getAttribute('aria-label') ?? el.getAttribute('title');
  const text = marked ?? el.textContent ?? '';
  const label = text.replace(/\s+/g, ' ').trim();
  return label && label.length <= 48 ? label : label ? `${label.slice(0, 45)}…` : null;
}

/**
 * Count taps on action buttons and tabs, with the page they were on. Menu
 * entries (team and player names) and form fields are left out.
 */
export function startUsageTracking() {
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest<HTMLElement>('[data-track], button.btn, a.btn, .seg button, [role="tab"], .tabs button');
      if (!el || el.closest('[data-no-track]')) return;
      const label = labelOf(el);
      if (label) add('click', `${page} · ${label}`);
    },
    { capture: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
