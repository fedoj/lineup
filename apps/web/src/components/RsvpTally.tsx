import { useState, type ReactNode } from 'react';

export interface TallyCounts {
  going: number;
  notGoing: number;
  late?: number;
  noAnswer: number;
}

export interface TallyNames {
  going: string[];
  notGoing: string[];
  late?: string[];
  noAnswer: string[];
}

type Bucket = 'going' | 'late' | 'out' | 'none';

const LABEL: Record<Bucket, string> = { going: 'Going', late: 'Late', out: 'Not going', none: 'No answer' };

/** Small stroke icons, so the answers read the same on every phone (emoji do not). */
export function RsvpIcon({ kind }: { kind: Bucket }) {
  return (
    <svg className="rsvp-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {kind === 'going' && <path d="M3.5 8.5l3 3 6-7" />}
      {kind === 'out' && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
      {kind === 'late' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.2l2 1.3" />
        </>
      )}
      {kind === 'none' && (
        <>
          <path d="M6 6.2a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.6" />
          <circle cx="8" cy="11.8" r=".4" />
        </>
      )}
    </svg>
  );
}

/**
 * Who is coming, as coloured counts with a bar showing how many have
 * answered. Staff get names: the counts open a panel grouped by answer, or
 * whatever the caller passes as children (practice attendance marking).
 * Everyone else sees the team totals only.
 */
export default function RsvpTally({
  counts,
  names,
  open: openProp,
  onToggle,
  children,
}: {
  counts?: TallyCounts | null;
  names?: TallyNames | null;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const [openState, setOpenState] = useState(false);
  const c: TallyCounts | null = names
    ? { going: names.going.length, notGoing: names.notGoing.length, late: names.late?.length ?? 0, noAnswer: names.noAnswer.length }
    : counts ?? null;
  if (!c) return null;

  const interactive = Boolean(names || onToggle);
  const open = openProp ?? openState;
  const toggle = onToggle ?? (() => setOpenState((v) => !v));

  const values: Record<Bucket, number> = { going: c.going, late: c.late ?? 0, out: c.notGoing, none: c.noAnswer };
  const total = values.going + values.late + values.out + values.none;
  const answered = total - values.none;
  const buckets: Bucket[] = values.late > 0 ? ['going', 'late', 'out', 'none'] : ['going', 'out', 'none'];

  const body = (
    <>
      <span className="rt-chips">
        {buckets.map((b) => (
          <span key={b} className={`rt-chip ${b}${values[b] === 0 ? ' zero' : ''}`}>
            <RsvpIcon kind={b} />
            <strong>{values[b]}</strong>
            <span>{LABEL[b]}</span>
          </span>
        ))}
      </span>
      <span className="rt-meter">
        <span className="rt-bar" aria-hidden="true">
          {total > 0 &&
            buckets
              .filter((b) => b !== 'none' && values[b] > 0)
              .map((b) => <span key={b} className={`rt-seg ${b}`} style={{ width: `${(values[b] / total) * 100}%` }} />)}
        </span>
        <span className="rt-caption">
          {total === 0 ? 'No players yet' : `${answered} of ${total} answered`}
          {interactive && (
            <span className="rt-more">
              {open ? 'Hide' : 'See who'}
              <svg className={`rt-chev${open ? ' up' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </span>
          )}
        </span>
      </span>
    </>
  );

  return (
    <div className={`rsvp-tally${open ? ' open' : ''}`}>
      {interactive ? (
        <button
          type="button"
          className="rt-head"
          aria-expanded={open}
          aria-label={`${values.going} going, ${values.out} not going${values.late ? `, ${values.late} late` : ''}, ${values.none} no answer. ${open ? 'Hide' : 'Show'} details`}
          onClick={toggle}
        >
          {body}
        </button>
      ) : (
        <div
          className="rt-head"
          role="group"
          aria-label={`Team: ${values.going} going, ${values.out} not going${values.late ? `, ${values.late} late` : ''}, ${values.none} no answer`}
        >
          {body}
        </div>
      )}
      {open && (children ?? (names && <TallyNamesPanel names={names} />))}
    </div>
  );
}

export function TallyNamesPanel({ names }: { names: TallyNames }) {
  const groups: Array<[Bucket, string[]]> = [
    ['going', names.going],
    ['late', names.late ?? []],
    ['out', names.notGoing],
    ['none', names.noAnswer],
  ];
  const shown = groups.filter(([, list]) => list.length > 0);
  if (shown.length === 0) return <p className="rt-names sub">No players on the roster yet.</p>;
  return (
    <div className="rt-names">
      {shown.map(([b, list]) => (
        <div key={b} className={`rt-group ${b}`}>
          <div className="rt-group-head">
            <RsvpIcon kind={b} />
            {LABEL[b]} <span className="rt-count">{list.length}</span>
          </div>
          <div className="rt-name-chips">
            {list.map((n, i) => (
              <span key={`${n}-${i}`} className="rt-name-chip">
                {n}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
