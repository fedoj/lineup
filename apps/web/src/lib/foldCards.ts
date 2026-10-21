import { useLayoutEffect } from 'react';

/**
 * Cleaner pages (Fady, 10/20): on settings-style pages each card shows only
 * its title until it is tapped, so options and sub-items stay out of the way.
 *
 * It works on the cards already on those pages: a `section.card` whose first
 * child is an h2, or a `.card-head` holding one (its buttons hide too while
 * folded). A card with `data-fold-open` starts open (the roster), so does a
 * card a link points at (#plans), and whatever the person opened stays open
 * for the rest of the visit.
 */

const STORE = 'lineup.foldOpen';

function headOf(card: HTMLElement): { head: HTMLElement; title: HTMLElement } | null {
  const first = card.firstElementChild as HTMLElement | null;
  if (!first) return null;
  if (first.tagName === 'H2') return { head: first, title: first };
  if (first.classList.contains('card-head')) {
    const h2 = first.querySelector<HTMLElement>(':scope > h2');
    if (h2) return { head: first, title: h2 };
  }
  return null;
}

function remembered(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function remember(key: string, open: boolean) {
  const s = remembered();
  if (open) s.add(key);
  else s.delete(key);
  try {
    sessionStorage.setItem(STORE, JSON.stringify([...s]));
  } catch {
    /* private mode: just not remembered */
  }
}

function setOpen(card: HTMLElement, open: boolean) {
  card.toggleAttribute('data-open', open);
  headOf(card)?.title.setAttribute('aria-expanded', String(open));
}

/** Open the folded cards around (or at) an element, e.g. before scrolling to it. */
export function revealInFold(el: Element | null | undefined) {
  for (let n: Element | null = el ?? null; n; n = n.parentElement) {
    if (n instanceof HTMLElement && n.dataset.fold) setOpen(n, true);
  }
}

/**
 * Fold the cards inside `el` while `enabled` (one page = one `page` name).
 * A layout effect, so a page never flashes open before it folds.
 */
export function useFoldCards(el: HTMLElement | null, page: string, enabled: boolean) {
  useLayoutEffect(() => {
    if (!el || !enabled) return;
    const open = remembered();
    const linked = location.hash.slice(1) || (new URLSearchParams(location.search).get('to') ?? '');

    const setup = () => {
      el.querySelectorAll<HTMLElement>('section.card:not([data-fold])').forEach((card) => {
        const h = headOf(card);
        if (!h) return;
        const key = `${page}:${card.id || h.title.textContent?.trim() || ''}`;
        card.dataset.fold = key;
        h.title.setAttribute('role', 'button');
        h.title.tabIndex = 0;
        setOpen(card, card.hasAttribute('data-fold-open') || open.has(key) || (Boolean(card.id) && card.id === linked) || (Boolean(linked) && Boolean(card.querySelector(`#${CSS.escape(linked)}`))));
      });
    };
    setup();

    // Cards that arrive later (screens load on demand, data loads) fold as they appear.
    const watch = new MutationObserver(setup);
    watch.observe(el, { childList: true, subtree: true });

    const toggle = (card: HTMLElement) => {
      const next = !card.hasAttribute('data-open');
      setOpen(card, next);
      remember(card.dataset.fold ?? '', next);
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      const head = t?.closest<HTMLElement>('section.card[data-fold] > h2, section.card[data-fold] > .card-head');
      if (!head) return;
      // Buttons and links in the title row do their own thing.
      const control = t?.closest('button, a, input, select, textarea, label');
      if (control && head.contains(control)) return;
      toggle(head.parentElement as HTMLElement);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      if (t?.getAttribute('role') !== 'button' || t.tagName !== 'H2') return;
      const card = t.closest<HTMLElement>('section.card[data-fold]');
      if (!card || headOf(card)?.title !== t) return;
      e.preventDefault();
      toggle(card);
    };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);

    return () => {
      watch.disconnect();
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
      // Leaving the page: unfold, so a page that doesn't fold shows everything.
      el.querySelectorAll<HTMLElement>('section.card[data-fold]').forEach((card) => {
        delete card.dataset.fold;
        card.removeAttribute('data-open');
        const h = headOf(card);
        h?.title.removeAttribute('role');
        h?.title.removeAttribute('tabindex');
        h?.title.removeAttribute('aria-expanded');
      });
    };
  }, [el, page, enabled]);
}
