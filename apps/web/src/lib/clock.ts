import { useEffect, useState } from 'react';
import type { GamePeriod } from './api';

/**
 * Live elapsed seconds for a period.
 *
 * The server owns the truth — it stores accrued seconds plus the moment the
 * clock was started — and the API response already folds those together. This
 * only advances the display between reads, so every device agrees after a
 * refresh.
 *
 * Shared by the clock and the event logger so a goal is stamped with exactly
 * the time shown on screen when it was tapped.
 */
export function useLiveClock(period: GamePeriod | undefined): {
  elapsed: number;
  started: boolean;
} {
  const [tick, setTick] = useState(0);

  const running = Boolean(period?.running);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running, period?.id]);

  // Reset the local offset whenever the server value changes underneath us.
  useEffect(() => {
    setTick(0);
  }, [period?.id, period?.elapsedSec, period?.running]);

  if (!period) return { elapsed: 0, started: false };

  const elapsed = period.elapsedSec + (period.running ? tick : 0);
  // "Started" means the clock has actually been run at some point, which is
  // what decides whether an event gets a match minute or no time at all.
  const started = period.running || period.elapsedSec > 0 || Boolean(period.endedAt);

  return { elapsed, started };
}

export function mmss(total: number): string {
  const safe = Math.max(0, Math.floor(total));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
