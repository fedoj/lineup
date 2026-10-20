import { useEffect, useRef, useState } from 'react';
import { api, type SearchHit } from '../lib/api';

const ICON: Record<SearchHit['kind'], string> = {
  team: '🛡️',
  player: '👤',
  game: '📅',
};

interface Props {
  onPick: (hit: SearchHit) => void;
}

/**
 * One box that searches teams, players and fixtures.
 *
 * Queries the API rather than filtering in the browser, because the app only
 * holds the selected team's roster and games — searching locally would quietly
 * miss everything on your other teams.
 */
export default function GlobalSearch({ onPick }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced so a fast typist fires one request, not one per keystroke.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    let cancelled = false;
    const id = setTimeout(() => {
      api
        .search(term)
        .then((r) => {
          if (cancelled) return;
          setHits(r.results);
          setActive(0);
          setOpen(true);
        })
        .catch(() => !cancelled && setHits([]))
        .finally(() => !cancelled && setBusy(false));
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [q]);

  // Close when focus or a click lands outside the control.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // "/" focuses search the way it does in most tools, but never while the
  // user is already typing into something else.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function choose(hit: SearchHit) {
    onPick(hit);
    setOpen(false);
    setQ('');
    setHits([]);
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(hits[active]);
    }
  }

  const showPanel = open && q.trim().length >= 2;

  return (
    <div className="gsearch" ref={boxRef}>
      <input
        ref={inputRef}
        type="search"
        value={q}
        placeholder="Search players, teams, games…"
        aria-label="Search"
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {showPanel && (
        <ul className="gsearch-results" role="listbox">
          {hits.length === 0 ? (
            <li className="gsearch-empty">{busy ? 'Searching…' : `Nothing matches “${q}”`}</li>
          ) : (
            hits.map((h, i) => (
              <li key={`${h.kind}-${h.id}`}>
                <button
                  type="button"
                  className={i === active ? 'on' : ''}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(h)}
                >
                  <span className="gs-icon" aria-hidden="true">
                    {ICON[h.kind]}
                  </span>
                  <span className="gs-text">
                    <strong>{h.title}</strong>
                    <span className="gs-sub">{h.subtitle}</span>
                  </span>
                  <span className="gs-kind">{h.kind}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
