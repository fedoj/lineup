import { useEffect, useMemo, useState } from 'react';
import { revealInFold } from '../lib/foldCards';

/**
 * Getting started (Fady, 10/17): a checklist for a new organization (or
 * region) admin and for a coach with their own team. Each step has "Show me",
 * which opens the right page and points at the button to press with a pop-up
 * tip. Steps tick themselves off when the app can tell they are done; the
 * rest are ticked by hand. Hidden once closed; the ? in the header brings it
 * back.
 */

export interface GuideStep {
  id: string;
  title: string;
  hint: string;
  /** Known from the app's data; undefined when only the person can say. */
  done?: boolean;
  /** Opens the right page and points at the target. */
  show: () => void;
}

/** A tip pointing at an element: CSS selector and what to do there. */
export interface TourTarget {
  selector: string;
  text: string;
}

/** Paste a video link here when there is one; the guide shows it. */
export const GUIDE_VIDEO_URL = '';

const key = (userId: string, what: string) => `lineup.guide.${userId}.${what}`;

export function guideHidden(userId: string): boolean {
  try {
    return localStorage.getItem(key(userId, 'hidden')) === '1';
  } catch {
    return false;
  }
}

export function setGuideHidden(userId: string, hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(key(userId, 'hidden'), '1');
    else localStorage.removeItem(key(userId, 'hidden'));
  } catch {
    /* private mode */
  }
}

export default function GettingStarted({
  userId,
  title,
  steps,
  onClose,
}: {
  userId: string;
  title: string;
  steps: GuideStep[];
  onClose: () => void;
}) {
  const [ticked, setTicked] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key(userId, 'done')) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const save = (next: string[]) => {
    setTicked(next);
    try {
      localStorage.setItem(key(userId, 'done'), JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  const isDone = (s: GuideStep) => s.done === true || ticked.includes(s.id);
  const doneCount = steps.filter(isDone).length;
  const next = steps.find((s) => !isDone(s));

  return (
    <section className="card guide" aria-label="Getting started">
      <div className="card-head">
        <h2>🚀 {title}</h2>
        <button type="button" className="chip-x" title="Close the guide (the ? at the top brings it back)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="guide-progress" aria-label={`${doneCount} of ${steps.length} done`}>
        <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <p className="sub">
        {doneCount === steps.length
          ? 'All done. You are set up.'
          : `${doneCount} of ${steps.length} done. Tap “Show me” and Lineup points at what to press.`}
        {GUIDE_VIDEO_URL && (
          <>
            {' '}
            <a href={GUIDE_VIDEO_URL} target="_blank" rel="noopener noreferrer">
              ▶ Watch the video
            </a>
          </>
        )}
      </p>
      <ol className="guide-steps">
        {steps.map((s) => {
          const done = isDone(s);
          return (
            <li key={s.id} className={`${done ? 'done' : ''}${next?.id === s.id ? ' next' : ''}`}>
              <span className="guide-check" aria-hidden="true">
                {done ? '✓' : ''}
              </span>
              <div className="guide-text">
                <strong>{s.title}</strong>
                <span className="sub">{s.hint}</span>
              </div>
              <div className="row guide-actions">
                <button type="button" className={`btn btn-sm${next?.id === s.id ? '' : ' ghost'}`} onClick={s.show}>
                  Show me
                </button>
                {s.done === undefined && (
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => save(done ? ticked.filter((x) => x !== s.id) : [...ticked, s.id])}
                  >
                    {done ? 'Undo' : 'Mark done'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The pop-up tip: waits for the target to appear (the page may still be
 * loading), scrolls to it, outlines it, and shows the tip next to it.
 */
export function TourTip({ target, onClose }: { target: TourTarget | null; onClose: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [missing, setMissing] = useState(false);
  const selector = target?.selector ?? null;

  useEffect(() => {
    setRect(null);
    setMissing(false);
    if (!selector) return;
    let el: Element | null = null;
    let tries = 0;
    const find = window.setInterval(() => {
      el = document.querySelector(selector);
      tries += 1;
      if (el) {
        window.clearInterval(find);
        revealInFold(el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('tour-highlight');
        window.setTimeout(() => el && setRect(el.getBoundingClientRect()), 450);
      } else if (tries > 30) {
        window.clearInterval(find);
        setMissing(true);
      }
    }, 150);
    const follow = () => el && setRect(el.getBoundingClientRect());
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.clearInterval(find);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      el?.classList.remove('tour-highlight');
    };
  }, [selector]);

  // Keep the tip on screen: below the target, or above it near the bottom.
  const style = useMemo(() => {
    if (!rect) return undefined;
    const below = rect.bottom + 12;
    const top = below + 140 > window.innerHeight ? Math.max(8, rect.top - 140) : below;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 300));
    return { top, left };
  }, [rect]);

  if (!target) return null;
  if (missing) {
    return (
      <div className="tour-tip floating" role="dialog" aria-label="Tip">
        <p>{target.text}</p>
        <p className="sub">This page doesn’t show that button for your role yet.</p>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Got it
        </button>
      </div>
    );
  }
  if (!style) return null;
  return (
    <div className="tour-tip" role="dialog" aria-label="Tip" style={style}>
      <p>👉 {target.text}</p>
      <button type="button" className="btn btn-sm" onClick={onClose}>
        Got it
      </button>
    </div>
  );
}
