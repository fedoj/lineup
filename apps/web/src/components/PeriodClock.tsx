import { useEffect, useState } from 'react';
import type { GamePeriod } from '../lib/api';

export interface PeriodClockProps {
  period: GamePeriod;
  label: string;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onEnd: () => void;
  readOnly?: boolean;
}

function mmss(total: number): string {
  const safe = Math.max(0, total);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Period clock.
 *
 * The server holds elapsed seconds and the moment the clock was started, so a
 * refresh or a second device shows the same time. This component only ticks
 * the display locally between those reads.
 */
export default function PeriodClock({
  period,
  label,
  onStart,
  onPause,
  onReset,
  onEnd,
  readOnly = false,
}: PeriodClockProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!period.running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [period.running, period.id]);

  // elapsedSec from the API already includes time since startedAt; tick adds
  // the seconds that have passed in this browser since that response.
  const elapsed = period.elapsedSec + (period.running ? tick : 0);
  const remaining = period.lengthSec - elapsed;
  const overrun = remaining < 0;
  const pct = Math.min(100, (elapsed / period.lengthSec) * 100);

  return (
    <div className={`clock ${period.running ? 'running' : ''} ${overrun ? 'overrun' : ''}`}>
      <div className="clock-head">
        <span className="clock-label">{label}</span>
        {period.endedAt && <span className="clock-done">ended</span>}
      </div>

      <div className="clock-time" aria-live="off">
        {overrun ? `+${mmss(-remaining)}` : mmss(remaining)}
      </div>

      <div className="clock-bar" aria-hidden="true">
        <div className="clock-fill" style={{ width: `${pct}%` }} />
      </div>

      {!readOnly && (
        <div className="clock-buttons">
          {period.running ? (
            <button type="button" className="btn" onClick={onPause}>
              Pause
            </button>
          ) : (
            <button type="button" className="btn" onClick={onStart}>
              Start
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onReset}>
            Reset
          </button>
          <button type="button" className="btn ghost" onClick={onEnd}>
            End period
          </button>
        </div>
      )}
    </div>
  );
}
