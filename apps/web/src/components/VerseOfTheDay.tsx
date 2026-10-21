import { useEffect, useState } from 'react';

/**
 * A Bible verse at the bottom of every page, a new one each day (Fady,
 * 10/20): love, peace, forgiveness and the fruit of the Spirit, American
 * Standard Version only. Each page shows its own verse, and they all move on
 * each day (Pacific time); everyone sees the same verse on the same page that
 * day. The verses ship with the app and load after the page, so this costs the
 * platform nothing.
 */
type Verse = { ref: string; text: string };

let list: ReadonlyArray<Verse> | null = null;

function pacificDay(): number {
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
}

/** A small number per page name, so each page lands on a different verse. */
function pageOffset(page: string): number {
  let h = 0;
  for (const ch of page) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function verseFor(all: ReadonlyArray<Verse>, day: number, page: string): Verse {
  // Stepping by a prime visits every verse once before any repeats, without
  // neighbouring days landing on neighbouring verses.
  return all[(day * 7919 + pageOffset(page) * 104729) % all.length];
}

export default function VerseOfTheDay({ page = '' }: { page?: string }) {
  const day = pacificDay();
  const [loaded, setLoaded] = useState<ReadonlyArray<Verse> | null>(list);

  useEffect(() => {
    if (loaded) return;
    let alive = true;
    void import('../data/asvVerses')
      .then(({ default: all }) => {
        list = all;
        if (alive) setLoaded(all);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [loaded]);

  if (!loaded) return null;
  const verse = verseFor(loaded, day, page);
  return (
    <aside className="verse-of-day" aria-label="Verse of the day">
      <p className="verse-text">“{verse.text}”</p>
      <p className="verse-ref">{verse.ref} (ASV)</p>
    </aside>
  );
}
