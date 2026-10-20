import { useCallback, useEffect, useMemo, useState } from 'react';
import { refMinute } from '@lineup/shared';
import { api, type RefEventKind, type RefMatch as Match, type RefMatchSide, type RefPlayerStatus } from '../lib/api';
import { PaidLock } from '../lib/features';
import { prettyDate, prettyTime } from './Calendar';
import MapLink from '../components/MapLink';

const KINDS: Array<[RefEventKind, string, string]> = [
  ['goal', 'Goal', '⚽'],
  ['yellow', 'Yellow', '🟨'],
  ['red', 'Red', '🟥'],
  ['sub', 'Sub', '🔁'],
  ['own_goal', 'Own goal', '🥅'],
];

const ICON: Record<RefEventKind, string> = { goal: '⚽', own_goal: '🥅', yellow: '🟨', red: '🟥', sub: '🔁' };

const STATUS: Array<[RefPlayerStatus, string]> = [
  ['start', 'Start'],
  ['bench', 'Bench'],
  ['absent', 'Out'],
];

function clockText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The referee's match screen for one league game: both rosters, prefilled
 * from the coaches' lineups and check-ins, the game clock (Referee Premium),
 * substitutions, goals and cards with the minute, and the final score, which
 * becomes the official result in the standings.
 */
export default function RefMatch({ fixtureId, onBack }: { fixtureId: string; onBack: () => void }) {
  const [m, setM] = useState<Match | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());

  const take = useCallback((next: Match) => {
    setM(next);
    setLoadedAt(Date.now());
  }, []);

  const load = useCallback(async () => {
    try {
      take(await api.refMatch(fixtureId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this game');
    }
  }, [fixtureId, take]);

  useEffect(() => {
    void load();
    // Assistants and organizers following along see changes as they happen.
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!m?.clock.running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [m?.clock.running]);

  async function act(b: Omit<Parameters<typeof api.refMatchAction>[0], 'fixtureId'>, done?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      take(await api.refMatchAction({ fixtureId, ...b }));
      if (done) setMsg(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!m) {
    return (
      <>
        <button type="button" className="linkish" onClick={onBack}>
          ‹ Back
        </button>
        <section className={error ? 'card err' : 'card'}>{error ?? 'Loading…'}</section>
      </>
    );
  }

  const final = Boolean(m.official);
  const recording = m.canEdit && !final;
  const elapsed = m.clock.elapsedSec + (m.clock.running ? Math.max(0, Math.floor((now - loadedAt) / 1000)) : 0);
  const periodWord = m.periods === 2 ? 'Half' : 'Quarter';
  const minuteNow = refMinute(m.clock.periodIndex, elapsed, m.periodLengthSec);
  const clockStarted = m.clock.running || m.clock.elapsedSec > 0 || m.clock.periodIndex > 0;

  return (
    <>
      <button type="button" className="linkish" onClick={onBack}>
        ‹ Back
      </button>
      {msg && (
        <section className="card" role="status">
          {msg}
        </section>
      )}
      {error && <section className="card err">{error}</section>}

      <section className="card ref-match-head">
        <div className="ref-scoreline">
          <span className="ref-team">{m.home.name}</span>
          <span className="ref-score" aria-label="Score">
            {final ? `${m.official!.home} – ${m.official!.away}` : `${m.score.home} – ${m.score.away}`}
          </span>
          <span className="ref-team">{m.away.name}</span>
        </div>
        <div className="sub">
          {prettyDate(m.date)}
          {m.kickoff ? ` · ${prettyTime(m.kickoff)}` : ''}
          {m.regionName ? ` · ${m.regionName}` : ''}
        </div>
        {(m.location || m.field) && (
          <div className="sub">
            {m.location && <MapLink place={m.location} />}
            {m.location && m.field ? ' · ' : ''}
            {m.field ? `Field ${m.field}` : ''}
          </div>
        )}
        <div className="sub ref-slots">
          <span>Main referee: {m.referees.main ?? <em>open</em>}</span>
          <span>Assistant 1: {m.referees.ar1 ?? <em>open</em>}</span>
          <span>Assistant 2: {m.referees.ar2 ?? <em>open</em>}</span>
        </div>
        {m.canceled && <p className="pill bad">This game was cancelled.</p>}
        {final ? (
          <p className="note ok-text">
            ✅ Official result, submitted by {m.official!.by ?? 'the referee'} on{' '}
            {new Date(m.official!.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. It counts in the
            standings.
          </p>
        ) : (
          m.coachScore &&
          (m.coachScore.home !== m.score.home || m.coachScore.away !== m.score.away) && (
            <p className="note">
              The coaches recorded {m.coachScore.home}–{m.coachScore.away}. Your final score replaces it.
            </p>
          )
        )}
        {m.role === 'assistant' && <p className="note">You're an assistant referee on this game, so this screen is view only.</p>}
        {m.role === 'staff' && <p className="note">You're seeing this as an organizer. You can correct the referee's report.</p>}
      </section>

      {!m.canceled && (
        <section className="card ref-clock">
          <div className="card-head">
            <h2>
              {periodWord} {m.clock.periodIndex + 1} of {m.periods}
            </h2>
            <span className="ref-clock-time" aria-live="off">
              {clockText(elapsed)}
            </span>
          </div>
          {m.clockPaid ? (
            recording && (
              <div className="row">
                {m.clock.running ? (
                  <button type="button" className="btn" disabled={busy} onClick={() => void act({ action: 'clock', op: 'pause' })}>
                    ⏸ Pause
                  </button>
                ) : (
                  <button type="button" className="btn" disabled={busy} onClick={() => void act({ action: 'clock', op: 'start' })}>
                    ▶ {clockStarted ? 'Resume' : 'Start'}
                  </button>
                )}
                {m.clock.periodIndex < m.periods - 1 && (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => void act({ action: 'clock', op: 'next' })}
                  >
                    Next {periodWord.toLowerCase()}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (confirm('Reset the clock to the start of the game?')) void act({ action: 'clock', op: 'reset' });
                  }}
                >
                  Reset
                </button>
              </div>
            )
          ) : (
            <>
              <PaidLock feature="refereeClock" what="Running game clock" />
              <p className="note">Without the clock, type the minute for each sub, goal or card.</p>
            </>
          )}
        </section>
      )}

      {recording && <RecordEvent m={m} busy={busy} act={act} autoMinute={m.clockPaid && clockStarted ? minuteNow : null} />}

      <section className="card">
        <h2>Match events</h2>
        {m.events.length === 0 ? (
          <p className="note">Nothing recorded yet.</p>
        ) : (
          <ul className="ref-events">
            {m.events.map((e) => (
              <li key={e.id} className={`ref-event ${e.side}`}>
                <span className="ref-min">{e.minute ? `${e.minute}'` : '–'}</span>
                <span aria-hidden="true">{ICON[e.kind]}</span>
                <span className="ref-event-what">
                  <strong>{e.label}</strong>
                  {e.kind === 'sub'
                    ? ` · ${e.playerName ?? '?'} on, ${e.playerOutName ?? '?'} off`
                    : e.playerName
                      ? ` · ${e.playerName}`
                      : ''}
                  <span className="sub"> · {e.side === 'home' ? m.home.name : m.away.name}</span>
                </span>
                {recording && (
                  <button
                    type="button"
                    className="chip-x"
                    title="Remove"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Remove this ${e.label.toLowerCase()}?`)) void act({ action: 'deleteEvent', eventId: e.id });
                    }}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="ref-sides">
        <Lineup side={m.home} recording={recording} busy={busy} act={act} />
        <Lineup side={m.away} recording={recording} busy={busy} act={act} />
      </div>

      {m.canEdit && <FinalScore m={m} busy={busy} act={act} />}
    </>
  );
}

type Act = (b: Omit<Parameters<typeof api.refMatchAction>[0], 'fixtureId'>, done?: string) => Promise<boolean>;

/** Record a goal, own goal, card or substitution. */
function RecordEvent({ m, busy, act, autoMinute }: { m: Match; busy: boolean; act: Act; autoMinute: number | null }) {
  const [kind, setKind] = useState<RefEventKind>('goal');
  const [side, setSide] = useState<'home' | 'away'>('home');
  const [playerId, setPlayerId] = useState('');
  const [playerOutId, setPlayerOutId] = useState('');
  const [minute, setMinute] = useState('');
  const team = side === 'home' ? m.home : m.away;
  const available = team.players.filter((p) => p.status !== 'absent');
  // Coming on: the bench first. Going off: whoever is playing.
  const onList = kind === 'sub' ? [...available].sort((a, b) => Number(a.status === 'start') - Number(b.status === 'start')) : available;
  const offList = available.filter((p) => p.played);
  const needsPlayer = kind !== 'goal' && kind !== 'own_goal';
  const ready = (!needsPlayer || playerId) && (kind !== 'sub' || (playerOutId && playerOutId !== playerId));

  useEffect(() => {
    setPlayerId('');
    setPlayerOutId('');
  }, [side, kind]);

  return (
    <section className="card ref-record">
      <h2>Record</h2>
      <div className="seg ref-kinds" role="group" aria-label="What happened">
        {KINDS.map(([k, label, icon]) => (
          <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {icon} {label}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Team">
        {(['home', 'away'] as const).map((s) => (
          <button key={s} type="button" className={side === s ? 'on' : ''} onClick={() => setSide(s)}>
            {s === 'home' ? m.home.name : m.away.name}
          </button>
        ))}
      </div>
      <div className="field-grid">
        <label>
          {kind === 'sub' ? 'Coming on' : kind === 'own_goal' ? `Player (${team.name})` : 'Player'}
          <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
            <option value="">{needsPlayer ? 'Choose…' : 'Not sure'}</option>
            {onList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.number ? `#${p.number} ` : ''}
                {p.name}
                {kind === 'sub' && p.status === 'bench' && !p.played ? ' (bench)' : ''}
              </option>
            ))}
          </select>
        </label>
        {kind === 'sub' && (
          <label>
            Going off
            <select value={playerOutId} onChange={(e) => setPlayerOutId(e.target.value)}>
              <option value="">Choose…</option>
              {(offList.length ? offList : available).map((p) => (
                <option key={p.id} value={p.id} disabled={p.id === playerId}>
                  {p.number ? `#${p.number} ` : ''}
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Minute
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={minute}
            placeholder={autoMinute ? `${autoMinute} (clock)` : 'e.g. 34'}
            onChange={(e) => setMinute(e.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        className="btn"
        disabled={busy || !ready}
        onClick={() =>
          void act(
            {
              action: 'event',
              kind,
              side,
              playerId: playerId || undefined,
              playerOutId: kind === 'sub' ? playerOutId : undefined,
              minute: minute ? Number(minute) : null,
            },
            'Recorded.',
          ).then((ok) => {
            if (ok) {
              setPlayerId('');
              setPlayerOutId('');
              setMinute('');
            }
          })
        }
      >
        Add {KINDS.find(([k]) => k === kind)?.[1].toLowerCase()}
      </button>
    </section>
  );
}

/** One team's players: start, bench or out, who played, cards and goals. */
function Lineup({ side, recording, busy, act }: { side: RefMatchSide; recording: boolean; busy: boolean; act: Act }) {
  const counts = useMemo(
    () => ({
      start: side.players.filter((p) => p.status === 'start').length,
      played: side.players.filter((p) => p.played).length,
      out: side.players.filter((p) => p.status === 'absent').length,
    }),
    [side],
  );
  return (
    <section className="card ref-lineup">
      <h2>{side.name}</h2>
      <p className="sub">
        {counts.start} starting · {counts.played} played · {side.players.length - counts.played - counts.out} sat out ·{' '}
        {counts.out} not playing
      </p>
      {!side.lineupSet && <p className="note">The coach hasn't set a starting lineup yet. Mark who starts below.</p>}
      {side.players.length === 0 ? (
        <p className="note">No players on this team yet.</p>
      ) : (
        <ul className="ref-roster">
          {side.players.map((p) => (
            <li key={p.id} className={`ref-player ${p.status}`}>
              <span className="ref-num">{p.number || '–'}</span>
              <span className="ref-name">
                {p.name}
                {p.publicId && <span className="sub player-id"> {p.publicId}</span>}
                <span className="ref-badges">
                  {p.goals > 0 && <span title="Goals">⚽{p.goals > 1 ? `×${p.goals}` : ''}</span>}
                  {p.yellow > 0 && <span title="Yellow cards">🟨{p.yellow > 1 ? `×${p.yellow}` : ''}</span>}
                  {p.red > 0 && <span title="Red card">🟥</span>}
                  {p.status !== 'absent' && (
                    <span className={p.played ? 'pill-league' : 'pill-event'}>{p.played ? 'Played' : 'Sat out'}</span>
                  )}
                  {p.changed && <span className="sub"> (coach: {STATUS.find(([s]) => s === p.fromCoach)?.[1]})</span>}
                </span>
              </span>
              {recording ? (
                <span className="seg ref-status" role="group" aria-label={`${p.name}: start, bench or out`}>
                  {STATUS.map(([s, label]) => (
                    <button
                      key={s}
                      type="button"
                      className={p.status === s ? 'on' : ''}
                      disabled={busy}
                      onClick={() => p.status !== s && void act({ action: 'status', playerId: p.id, status: s })}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="sub">{STATUS.find(([s]) => s === p.status)?.[1]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The final score: from the goals by default, and the official result once submitted. */
function FinalScore({ m, busy, act }: { m: Match; busy: boolean; act: Act }) {
  const [home, setHome] = useState(String(m.score.home));
  const [away, setAway] = useState(String(m.score.away));
  const [notes, setNotes] = useState(m.notes);
  const [touched, setTouched] = useState(false);

  // Follow the goals as they are recorded, until the referee types a score.
  useEffect(() => {
    if (touched) return;
    setHome(String(m.official?.home ?? m.score.home));
    setAway(String(m.official?.away ?? m.score.away));
  }, [m.score.home, m.score.away, m.official, touched]);

  if (m.canceled) return null;

  return (
    <section className="card ref-final">
      <h2>Final score</h2>
      {m.official ? (
        <>
          <p>
            <strong>
              {m.home.name} {m.official.home} – {m.official.away} {m.away.name}
            </strong>{' '}
            is the official result. It replaces the coaches' score in the standings.
          </p>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              if (confirm('Reopen the result to correct it? The standings keep this score until you submit again.')) {
                void act({ action: 'reopen' }, 'Result reopened. Make your changes, then submit the final score again.');
              }
            }}
          >
            Reopen to correct
          </button>
        </>
      ) : (
        <>
          <div className="ref-final-row">
            <label>
              {m.home.name}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={99}
                value={home}
                onChange={(e) => {
                  setTouched(true);
                  setHome(e.target.value);
                }}
              />
            </label>
            <span aria-hidden="true">–</span>
            <label>
              {m.away.name}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={99}
                value={away}
                onChange={(e) => {
                  setTouched(true);
                  setAway(e.target.value);
                }}
              />
            </label>
          </div>
          {(Number(home) !== m.score.home || Number(away) !== m.score.away) && (
            <p className="note">
              The goals recorded add up to {m.score.home}–{m.score.away}. The score you submit is the official one.
            </p>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy || !m.canFinal || home === '' || away === ''}
            onClick={() => {
              if (confirm(`Submit ${m.home.name} ${home} – ${away} ${m.away.name} as the official result?`)) {
                void act(
                  { action: 'final', homeScore: Number(home), awayScore: Number(away) },
                  'Final score submitted. It is now the official result, and both coaches have been told.',
                ).then((ok) => ok && setTouched(false));
              }
            }}
          >
            Submit final score
          </button>
          {!m.canFinal && <p className="note">You can submit the final score on game day.</p>}
        </>
      )}
      <label className="ref-notes">
        Notes for the organizers (optional)
        <textarea
          rows={3}
          maxLength={1000}
          value={notes}
          placeholder="Anything the league should know: injuries, weather, behavior…"
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      {notes !== m.notes && (
        <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void act({ action: 'notes', notes }, 'Notes saved.')}>
          Save notes
        </button>
      )}
    </section>
  );
}
