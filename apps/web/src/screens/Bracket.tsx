import { useMemo, useState } from 'react';
import {
  api,
  type BracketEntryInput,
  type BracketGroup,
  type BracketGroupMatch,
  type BracketMatch,
  type CompetitionDetail,
} from '../lib/api';
import { prettyDate, prettyTime } from './Calendar';
import LocationInput from '../components/LocationInput';
import { useRegionFields } from '../components/RegionFields';

type Seeding = 'standings' | 'order' | 'random';
type Act = (fn: () => Promise<unknown>) => Promise<void>;
type Side = { teamId?: string | null; name: string; pending?: boolean } | null;

/**
 * A tournament's bracket (Fady, 10/16): an optional group stage (everyone in
 * a group plays everyone once) and a knockout, made automatically from its
 * teams (and, in a coach's own tournament, teams typed in by name). The best
 * seeds meet last, the top seeds get byes, and a third-place game is optional.
 * Managers schedule each match (it goes on the teams' calendars; kick-off and
 * location required), enter scores for games not on Lineup, change the first
 * knockout round and set a winner by hand. Results move teams on.
 */
export default function BracketCard({
  c,
  onChanged,
  onOpenGame,
}: {
  c: CompetitionDetail;
  onChanged: () => void;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act: Act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const run = (fn: () => Promise<unknown>) => act(fn).catch(() => undefined);

  const bracket = c.bracket;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Bracket</h2>
        {bracket && c.canEdit && (
          <button
            type="button"
            className="btn ghost btn-sm"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Remove this bracket? Games already scheduled stay on the calendars.')) {
                void run(() => api.bracketAction({ action: 'bracketDelete', id: c.id }));
              }
            }}
          >
            Remove bracket
          </button>
        )}
      </div>
      {error && <p className="danger-text">{error}</p>}
      {!bracket ? (
        c.canEdit ? (
          <MakeBracket
            c={c}
            busy={busy}
            onMake={(entries, thirdPlace, addTeamIds, groups) =>
              run(async () => {
                // Teams picked from outside the tournament join it first.
                if (addTeamIds.length) await api.competitionAction({ action: 'addTeams', id: c.id, teamIds: addTeamIds });
                await api.bracketAction({ action: 'bracketCreate', id: c.id, entries, thirdPlace, groups });
              })
            }
          />
        ) : (
          <p className="note">No bracket yet.</p>
        )
      ) : (
        <>
          {bracket.groups.length > 0 && (
            <>
              <h3 className="group-title">Group stage</h3>
              <div className="bracket-groups">
                {bracket.groups.map((g) => (
                  <GroupCard key={g.label} c={c} g={g} busy={busy} act={act} onOpenGame={onOpenGame} />
                ))}
              </div>
            </>
          )}
          {bracket.rounds > 0 && (
            <>
              {bracket.groups.length > 0 && <h3 className="group-title">Knockout</h3>}
              {(() => {
                const final = bracket.matches.find((m) => m.round === bracket.rounds && !m.thirdPlace);
                const champ = final?.winner ? final[final.winner]?.name : null;
                return champ ? (
                  <div className="bracket-champion" role="status">
                    <span aria-hidden="true">🏆</span> Champion: <strong>{champ}</strong>
                  </div>
                ) : null;
              })()}
              <div className="bracket" role="list">
                {Array.from({ length: bracket.rounds }, (_, i) => i + 1).map((round) => {
                  const matches = bracket.matches.filter((m) => m.round === round && !m.thirdPlace);
                  // Each stage has its own colour, the final in gold (Fady, 10/17).
                  const left = bracket.rounds - round;
                  const stage = left === 0 ? 'final' : left === 1 ? 'semi' : left === 2 ? 'quarter' : 'early';
                  return (
                    <div key={round} className={`bracket-round stage-${stage}`} role="listitem">
                      <h4 className="group-title">{matches[0]?.roundName}</h4>
                      {matches.map((m) => (
                        <MatchCard key={m.id} c={c} m={m} busy={busy} act={act} onOpenGame={onOpenGame} />
                      ))}
                    </div>
                  );
                })}
                {bracket.matches
                  .filter((m) => m.thirdPlace)
                  .map((m) => (
                    <div key={m.id} className="bracket-round stage-third" role="listitem">
                      <h4 className="group-title">{m.roundName}</h4>
                      <MatchCard c={c} m={m} busy={busy} act={act} onOpenGame={onOpenGame} />
                    </div>
                  ))}
              </div>
            </>
          )}
          <p className="note">
            Results move teams on: group places fill in once a group’s games are all played, and knockout winners go to the
            next round. A knockout draw (for example decided on penalties) needs “Set winner”.
          </p>
        </>
      )}
    </section>
  );
}

function MakeBracket({
  c,
  busy,
  onMake,
}: {
  c: CompetitionDetail;
  busy: boolean;
  onMake: (
    entries: BracketEntryInput[],
    thirdPlace: boolean,
    addTeamIds: string[],
    groups: { perGroup: number; advance: number } | null,
  ) => void;
}) {
  // A coach's own tournament also takes teams typed in by name; an
  // organization's or region's uses its own teams only (Fady, 10/16).
  const coach = c.ownerKind === 'coach';
  const choices = [...c.teams.map((t) => ({ ...t, inIt: true })), ...c.eligibleTeams.map((t) => ({ ...t, inIt: false }))];
  const anyPlayed = c.standings.table.some((r) => r.played > 0);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(c.teams.map((t) => t.id)));
  const [others, setOthers] = useState('');
  const [seeding, setSeeding] = useState<Seeding>(anyPlayed ? 'standings' : 'order');
  const [thirdPlace, setThirdPlace] = useState(true);
  const [format, setFormat] = useState<'knockout' | 'groups'>('knockout');
  const [perGroup, setPerGroup] = useState(4);
  const [advance, setAdvance] = useState(2);

  const outside = useMemo(
    () =>
      coach
        ? [...new Set(others.split('\n').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 64)
        : [],
    [others, coach],
  );
  const count = picked.size + outside.length;

  // What it will look like, matching the server's rules.
  let groupCount = Math.max(1, Math.ceil(count / perGroup));
  while (groupCount > 1 && Math.floor(count / groupCount) < 2) groupCount -= 1;
  const smallest = Math.floor(count / groupCount);
  const goThrough = Math.min(advance, Math.max(1, smallest)) * groupCount;
  const knockoutTeams = format === 'groups' ? goThrough : count;
  let size = 2;
  while (size < knockoutTeams) size *= 2;
  const ok = format === 'groups' ? count >= 3 && goThrough >= 2 : count >= 2;

  function entries(): BracketEntryInput[] {
    const teams = choices.filter((t) => picked.has(t.id));
    let ordered: BracketEntryInput[];
    if (seeding === 'standings') {
      const rank = new Map(c.standings.table.map((r, i) => [r.teamId, i]));
      ordered = [...teams]
        .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999))
        .map((t) => ({ teamId: t.id }));
      ordered.push(...outside.map((name) => ({ name })));
    } else {
      ordered = [...teams.map((t) => ({ teamId: t.id })), ...outside.map((name) => ({ name }))];
      if (seeding === 'random') {
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        }
      }
    }
    return ordered;
  }

  return (
    <div className="comp-form">
      <p className="note">
        Pick the teams and Lineup lines everything up: groups get a fair mix of strong and weaker teams, and in the
        knockout the best seeds meet last (the top seeds get a bye when the numbers don’t work out). You can change the
        knockout’s first round afterwards.
      </p>
      {choices.length > 0 && (
        <ul className="check-list">
          {choices.map((t) => (
            <li key={t.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.has(t.id)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(t.id);
                      else next.delete(t.id);
                      return next;
                    })
                  }
                />
                {t.name}
                {t.regionName ? <span className="sub"> · {t.regionName}</span> : null}
                {!t.inIt && <span className="sub"> · joins the tournament</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      {coach && (
        <label>
          Other teams, not on Lineup (one per line)
          <textarea rows={3} value={others} placeholder={'e.g. Westside FC\nValley United'} onChange={(e) => setOthers(e.target.value)} />
        </label>
      )}
      <div className="field-grid">
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="knockout">Knockout only</option>
            <option value="groups">Group stage, then knockout</option>
          </select>
        </label>
        {format === 'groups' && (
          <>
            <label>
              Teams per group
              <select value={perGroup} onChange={(e) => setPerGroup(Number(e.target.value))}>
                {[3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Go through from each group
              <select value={advance} onChange={(e) => setAdvance(Number(e.target.value))}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Group winner' : `Top ${n}`}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Seeding
          <select value={seeding} onChange={(e) => setSeeding(e.target.value as Seeding)}>
            <option value="standings">By standings (best record first)</option>
            <option value="order">In the order listed</option>
            <option value="random">Random draw</option>
          </select>
        </label>
      </div>
      <ul className="check-list">
        <li>
          <label className="check">
            <input type="checkbox" checked={thirdPlace} onChange={(e) => setThirdPlace(e.target.checked)} />
            Third-place game
          </label>
        </li>
      </ul>
      <p className="sub">
        {!ok
          ? format === 'groups'
            ? 'Pick at least 3 teams for a group stage.'
            : 'Pick at least 2 teams.'
          : format === 'groups'
            ? `${count} teams → ${groupCount} ${groupCount === 1 ? 'group' : 'groups'}; ${goThrough} go through to a knockout of ${size}.`
            : `${count} teams → a bracket of ${size}${size > count ? `, ${size - count} ${size - count === 1 ? 'bye' : 'byes'}` : ''}.`}
      </p>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || !ok || count > 64}
        onClick={() =>
          onMake(
            entries(),
            thirdPlace,
            [...picked].filter((id) => !c.teams.some((t) => t.id === id)),
            format === 'groups' ? { perGroup, advance } : null,
          )
        }
      >
        {busy ? 'Making…' : 'Make bracket'}
      </button>
    </div>
  );
}

function GroupCard({
  c,
  g,
  busy,
  act,
  onOpenGame,
}: {
  c: CompetitionDetail;
  g: BracketGroup;
  busy: boolean;
  act: Act;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  return (
    <div className={`bracket-group g-${Math.max(0, g.label.toUpperCase().charCodeAt(0) - 65) % 6}`}>
      <h4 className="group-title">
        Group {g.label}
        {g.complete && <span className="pill small"> Done</span>}
      </h4>
      <div className="table-scroll">
        <table className="tiers standings">
          <thead>
            <tr>
              <th>#</th>
              <th>Team</th>
              <th>P</th>
              <th>W</th>
              <th>D</th>
              <th>L</th>
              <th>GD</th>
              <th>Pts</th>
            </tr>
          </thead>
          <tbody>
            {g.table.map((r, i) => (
              <tr key={`${r.teamId ?? r.name}`}>
                <td>{i + 1}</td>
                <td>{r.name}</td>
                <td>{r.played}</td>
                <td>{r.won}</td>
                <td>{r.drawn}</td>
                <td>{r.lost}</td>
                <td>{r.gd}</td>
                <td>
                  <strong>{r.pts}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="bracket-group-games">
        {g.matches.map((m) => (
          <GroupMatchRow key={m.id} c={c} m={m} busy={busy} act={act} onOpenGame={onOpenGame} />
        ))}
      </ul>
    </div>
  );
}

function GroupMatchRow({
  c,
  m,
  busy,
  act,
  onOpenGame,
}: {
  c: CompetitionDetail;
  m: BracketGroupMatch;
  busy: boolean;
  act: Act;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  const [mode, setMode] = useState<null | 'schedule' | 'score' | 'winner'>(null);
  return (
    <li>
      <div className="bracket-group-game">
        <span>
          {m.home?.name} <span className="sub">v</span> {m.away?.name}
        </span>
        <span className="sub">
          {m.score ? (
            <strong>
              {m.score.home} – {m.score.away}
            </strong>
          ) : m.date ? (
            `${prettyDate(m.date)}${m.kickoff ? ` · ${prettyTime(m.kickoff)}` : ''}`
          ) : (
            'Not scheduled'
          )}
        </span>
      </div>
      <MatchActions
        c={c}
        id={m.id}
        names={[m.home?.name ?? '', m.away?.name ?? '']}
        known={Boolean(m.home && m.away)}
        scheduled={m.scheduled}
        canEnterScore={m.canEnterScore}
        score={m.score}
        canSetWinner={false}
        links={m.links}
        mode={mode}
        setMode={setMode}
        busy={busy}
        act={act}
        onOpenGame={onOpenGame}
      />
    </li>
  );
}

function MatchCard({
  c,
  m,
  busy,
  act,
  onOpenGame,
}: {
  c: CompetitionDetail;
  m: BracketMatch;
  busy: boolean;
  act: Act;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  const [mode, setMode] = useState<null | 'edit' | 'schedule' | 'winner' | 'score'>(null);
  const known = Boolean(m.home && m.away && !m.home.pending && !m.away.pending);
  const canSetSides = c.canEdit && m.round === 1 && !m.thirdPlace && !m.scheduled;

  const side = (s: 'home' | 'away') => {
    const e: Side = m[s];
    const won = m.winner === s;
    const lost = m.winner !== null && m.winner !== s && e;
    const goals = m.score ? m.score[s] : null;
    return (
      <div className={`bracket-team${won ? ' won' : ''}${lost ? ' lost' : ''}`}>
        <span>
          {!e ? (
            <em className="sub">{m.round === 1 && !m.thirdPlace ? 'Bye' : 'TBD'}</em>
          ) : e.pending ? (
            <em className="sub">{e.name}</em>
          ) : (
            e.name
          )}
        </span>
        {goals !== null && <strong>{goals}</strong>}
      </div>
    );
  };

  return (
    <div className="bracket-match">
      {side('home')}
      {side('away')}
      <div className="sub bracket-meta">
        {[
          m.decidedBy === 'bye' ? 'Goes through (bye)' : null,
          m.decidedBy === 'hand' ? 'Winner set by hand' : null,
          m.date ? `${prettyDate(m.date)}${m.kickoff ? ` · ${prettyTime(m.kickoff)}` : ''}` : null,
          m.location,
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {m.decidedBy !== 'bye' && (
        <MatchActions
          c={c}
          id={m.id}
          names={[m.home?.name ?? '', m.away?.name ?? '']}
          known={known}
          scheduled={m.scheduled}
          canEnterScore={m.canEnterScore}
          score={m.score}
          canSetWinner
          handWinner={m.decidedBy === 'hand'}
          links={m.links}
          mode={mode === 'edit' ? null : mode}
          setMode={setMode}
          busy={busy}
          act={act}
          onOpenGame={onOpenGame}
        />
      )}
      {canSetSides && mode !== 'edit' && (
        <div className="row bracket-actions">
          <button type="button" className="linkish" onClick={() => setMode('edit')}>
            Change teams
          </button>
        </div>
      )}
      {mode === 'edit' && (
        <EditSides
          c={c}
          m={m}
          busy={busy}
          onCancel={() => setMode(null)}
          onSave={(home, away) =>
            act(() => api.bracketAction({ action: 'bracketSet', id: c.id, matchId: m.id, home, away }))
              .then(() => setMode(null))
              .catch(() => undefined)
          }
        />
      )}
    </div>
  );
}

/** Open match day, schedule, enter a score, set a winner: what a match offers. */
function MatchActions({
  c,
  id,
  names,
  known,
  scheduled,
  canEnterScore,
  score,
  canSetWinner,
  handWinner = false,
  links,
  mode,
  setMode,
  busy,
  act,
  onOpenGame,
}: {
  c: CompetitionDetail;
  id: string;
  names: [string, string];
  known: boolean;
  scheduled: boolean;
  canEnterScore: boolean;
  score: { home: number; away: number } | null;
  canSetWinner: boolean;
  handWinner?: boolean;
  links: Array<{ teamId: string; gameId: string }>;
  mode: null | 'schedule' | 'winner' | 'score';
  setMode: (m: null | 'schedule' | 'winner' | 'score') => void;
  busy: boolean;
  act: Act;
  onOpenGame: (teamId: string, gameId: string) => void;
}) {
  const done = () => setMode(null);
  return (
    <>
      {links.length > 0 && (
        <div className="row">
          {links.map((l) => (
            <button key={l.gameId} type="button" className="linkish" onClick={() => onOpenGame(l.teamId, l.gameId)}>
              Open match day
            </button>
          ))}
        </div>
      )}
      {c.canEdit && known && mode === null && (
        <div className="row bracket-actions">
          {!scheduled && (
            <button type="button" className="linkish" onClick={() => setMode('schedule')}>
              Schedule
            </button>
          )}
          {canEnterScore && (
            <button type="button" className="linkish" onClick={() => setMode('score')}>
              {score ? 'Change score' : 'Enter score'}
            </button>
          )}
          {canSetWinner && (
            <button type="button" className="linkish" onClick={() => setMode('winner')}>
              Set winner
            </button>
          )}
        </div>
      )}
      {mode === 'schedule' && (
        <ScheduleMatch
          c={c}
          busy={busy}
          onCancel={done}
          onSave={(date, kickoff, location) =>
            act(() => api.bracketAction({ action: 'bracketSchedule', id: c.id, matchId: id, date, kickoff, location }))
              .then(done)
              .catch(() => undefined)
          }
        />
      )}
      {mode === 'score' && (
        <EnterScore
          names={names}
          score={score}
          busy={busy}
          onCancel={done}
          onSave={(homeScore, awayScore) =>
            act(() => api.bracketAction({ action: 'bracketScore', id: c.id, matchId: id, homeScore, awayScore }))
              .then(done)
              .catch(() => undefined)
          }
        />
      )}
      {mode === 'winner' && (
        <div className="row bracket-actions">
          {(['home', 'away'] as const).map((s, i) => (
            <button
              key={s}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                act(() => api.bracketAction({ action: 'bracketWinner', id: c.id, matchId: id, winner: s }))
                  .then(done)
                  .catch(() => undefined)
              }
            >
              {names[i]}
            </button>
          ))}
          {handWinner && (
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() =>
                act(() => api.bracketAction({ action: 'bracketWinner', id: c.id, matchId: id, winner: null }))
                  .then(done)
                  .catch(() => undefined)
              }
            >
              Use the score
            </button>
          )}
          <button type="button" className="btn ghost btn-sm" onClick={done}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

function EnterScore({
  names,
  score,
  busy,
  onCancel,
  onSave,
}: {
  names: [string, string];
  score: { home: number; away: number } | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (home: number | null, away: number | null) => void;
}) {
  const [home, setHome] = useState(score ? String(score.home) : '');
  const [away, setAway] = useState(score ? String(score.away) : '');
  const valid = /^\d{1,2}$/.test(home) && /^\d{1,2}$/.test(away);
  return (
    <div className="comp-form">
      <div className="field-grid">
        <label>
          {names[0]}
          <input type="number" inputMode="numeric" min={0} max={99} value={home} onChange={(e) => setHome(e.target.value)} />
        </label>
        <label>
          {names[1]}
          <input type="number" inputMode="numeric" min={0} max={99} value={away} onChange={(e) => setAway(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={busy || !valid} onClick={() => onSave(Number(home), Number(away))}>
          Save score
        </button>
        {score && (
          <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => onSave(null, null)}>
            Clear
          </button>
        )}
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** First-round knockout match: pick each side from the tournament's teams, (a coach's own) type a name, or leave a bye. */
function EditSides({
  c,
  m,
  busy,
  onCancel,
  onSave,
}: {
  c: CompetitionDetail;
  m: BracketMatch;
  busy: boolean;
  onCancel: () => void;
  onSave: (home: BracketEntryInput | null, away: BracketEntryInput | null) => void;
}) {
  const coach = c.ownerKind === 'coach';
  const names = useMemo(() => {
    const all = (c.bracket?.matches ?? []).flatMap((x) => (x.round === 1 && !x.thirdPlace ? [x.home, x.away] : []));
    return [...new Set(all.filter((e) => e && !e.teamId && !e.pending).map((e) => e!.name))];
  }, [c.bracket]);
  const valueOf = (e: Side) => (!e || e.pending ? '' : e.teamId ? `t:${e.teamId}` : `n:${e.name}`);
  const [home, setHome] = useState(valueOf(m.home));
  const [away, setAway] = useState(valueOf(m.away));
  const [typed, setTyped] = useState({ home: '', away: '' });
  const toEntry = (v: string, t: string): BracketEntryInput | null => {
    if (coach && t.trim()) return { name: t.trim() };
    if (v.startsWith('t:')) return { teamId: v.slice(2) };
    if (v.startsWith('n:')) return { name: v.slice(2) };
    return null;
  };
  const picker = (which: 'home' | 'away', value: string, set: (v: string) => void) => (
    <label>
      {which === 'home' ? 'Team 1' : 'Team 2'}
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">— None (bye) —</option>
        {c.teams.map((t) => (
          <option key={t.id} value={`t:${t.id}`}>
            {t.name}
          </option>
        ))}
        {coach &&
          names.map((n) => (
            <option key={n} value={`n:${n}`}>
              {n}
            </option>
          ))}
      </select>
      {coach && (
        <input
          value={typed[which]}
          maxLength={80}
          placeholder="or type a team name"
          onChange={(e) => setTyped((p) => ({ ...p, [which]: e.target.value }))}
        />
      )}
    </label>
  );
  return (
    <div className="comp-form">
      <div className="field-grid">
        {picker('home', home, setHome)}
        {picker('away', away, setAway)}
      </div>
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onSave(toEntry(home, typed.home), toEntry(away, typed.away))}>
          Save
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ScheduleMatch({
  c,
  busy,
  onCancel,
  onSave,
}: {
  c: CompetitionDetail;
  busy: boolean;
  onCancel: () => void;
  onSave: (date: string, kickoff: string, location: string) => void;
}) {
  const [date, setDate] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [location, setLocation] = useState('');
  const fields = useRegionFields({ competitionId: c.id });
  return (
    <div className="comp-form">
      <p className="sub">The game goes on the teams’ calendars; its score moves the result on.</p>
      <div className="field-grid">
        <label>
          Date
          <input type="date" value={date} min={c.startsOn} max={c.endsOn} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Kick-off
          <input type="time" value={kickoff} required onChange={(e) => setKickoff(e.target.value)} />
        </label>
        <label>
          Location
          <LocationInput value={location} onChange={setLocation} label="Location" placeholder="e.g. Central Park, field 2" presets={fields} />
        </label>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !date || !kickoff || !location.trim()}
          onClick={() => onSave(date, kickoff, location.trim())}
        >
          Schedule
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
