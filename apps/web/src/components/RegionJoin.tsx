import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type CoachSignups, type Family, type JoinRegionInfo, type MySignups, type ParentLabel, type RegionSignups, type Signup } from '../lib/api';
import { PENDING_JOIN_KEY } from '../lib/pendingKeys';

export const PARENT_LABELS: Array<[ParentLabel, string]> = [
  ['mother', 'Mother'],
  ['father', 'Father'],
  ['guardian', 'Guardian'],
];
export const SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Dr'];

export { PENDING_JOIN_KEY };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for the region',
  approved: 'Approved, waiting for a team',
  declined: 'Not accepted',
  placed: 'On a team',
  withdrawn: 'Withdrawn',
};

interface ChildDraft {
  name: string;
  birthYear: string;
  birthMonth: string;
  gender: '' | 'boys' | 'girls';
  priorPlayerId: string | null;
}

const emptyChild = (): ChildDraft => ({ name: '', birthYear: '', birthMonth: '', gender: '', priorPlayerId: null });

/**
 * Account: join a region with its code and sign children up for the season.
 * Returning families pick children already on file instead of retyping them.
 */
export function JoinRegion() {
  const [code, setCode] = useState(() => (typeof localStorage !== 'undefined' ? localStorage.getItem(PENDING_JOIN_KEY) ?? '' : ''));
  const [region, setRegion] = useState<JoinRegionInfo | null>(null);
  const [kids, setKids] = useState<ChildDraft[]>([emptyChild()]);
  const [phone, setPhone] = useState('');
  // Optional (Fady, 10/19): who you are to the children, and the other parent.
  const [myLabel, setMyLabel] = useState<ParentLabel | ''>('');
  const [salutation, setSalutation] = useState('');
  const [otherEmail, setOtherEmail] = useState('');
  const [otherLabel, setOtherLabel] = useState<ParentLabel | ''>('');
  const [mine, setMine] = useState<MySignups | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadMine = useCallback(() => {
    api.mySignups().then(setMine).catch(() => setMine(null));
  }, []);
  useEffect(loadMine, [loadMine]);

  const lookup = useCallback(async (c: string) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setRegion(await api.joinLookup(c));
    } catch (e) {
      setRegion(null);
      setError(e instanceof Error ? e.message : 'That code was not found.');
    } finally {
      setBusy(false);
    }
  }, []);

  // A code that came from a shared link is looked up straight away.
  useEffect(() => {
    if (code && !region) void lookup(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thisYear = new Date().getFullYear();
  const years = useMemo(() => Array.from({ length: 17 }, (_, i) => thisYear - 3 - i), [thisYear]);
  const update = (i: number, patch: Partial<ChildDraft>) => setKids((k) => k.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const ready = region && kids.length > 0 && kids.every((k) => k.name.trim() && k.birthYear && k.birthMonth && k.gender);

  async function submit() {
    if (!region) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.joinRegion({
        code: region.code,
        phone: phone.trim() || undefined,
        children: kids.map((k) => ({
          name: k.name.trim(),
          birthYear: Number(k.birthYear),
          birthMonth: Number(k.birthMonth),
          gender: k.gender as 'boys' | 'girls',
          priorPlayerId: k.priorPlayerId,
        })),
        parentLabel: myLabel || undefined,
        salutation: salutation || undefined,
        secondParentEmail: otherEmail.trim() || undefined,
        secondParentLabel: otherEmail.trim() && otherLabel ? otherLabel : undefined,
      });
      localStorage.removeItem(PENDING_JOIN_KEY);
      setNotice(
        r.created > 0
          ? `Signed up for ${region.competitionName ?? region.regionName}. ${region.regionName} will approve and place ${r.created === 1 ? 'your child' : 'your children'} on a team, and you will get a notification.${otherEmail.trim() ? ' The other parent gets an invite once a child is placed.' : ''}`
          : 'These children are already signed up for this league or tournament.',
      );
      setOtherEmail('');
      setKids([emptyChild()]);
      setRegion(null);
      setCode('');
      loadMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign up');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(s: Signup) {
    if (!confirm(`Withdraw ${s.childName} from ${s.competitionName ?? s.regionName}?`)) return;
    try {
      await api.withdrawSignup(s.id);
      loadMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not withdraw');
    }
  }

  const active = (mine?.signups ?? []).filter((s) => s.status !== 'withdrawn');
  const open = region?.registration === undefined || region.registration === 'open';
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <section className="card" id="join">
      <h2>Sign up for a league or tournament</h2>
      <p className="note">
        Got a sign-up link or code from your region or coach, like FALL-7KQ2? Enter the code to sign your children up.
        They place each child on a team.
      </p>
      {error && <p className="danger-text">{error}</p>}
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}

      {!region && (
        <div className="row">
          <input
            style={{ flex: '1 1 200px' }}
            value={code}
            placeholder="Sign-up code"
            maxLength={60}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.trim()) void lookup(code);
            }}
          />
          <button type="button" className="btn" disabled={busy || !code.trim()} onClick={() => lookup(code)}>
            Find
          </button>
        </div>
      )}

      {region && (
        <>
          <p>
            <strong>{region.competitionName ?? region.regionName}</strong>
            {region.competitionName ? ` · ${region.regionName}` : ''}
            {region.orgName ? ` · ${region.orgName}` : ''}
            {region.startsOn && region.endsOn ? ` · ${day(region.startsOn)} – ${day(region.endsOn)}` : ''}{' '}
            <button type="button" className="linkish" onClick={() => setRegion(null)}>
              Change code
            </button>
          </p>
          {region.registration === 'closed' && region.regClosesOn && (
            <p className="note warn" role="status">
              Registration closed on {day(region.regClosesOn)}. Contact {region.regionName} if you still want to join.
            </p>
          )}
          {region.registration === 'upcoming' && region.regOpensOn && (
            <p className="note" role="status">
              Registration opens on {day(region.regOpensOn)}. Come back then to sign up.
            </p>
          )}
          {region.registration === 'open' && region.regClosesOn && (
            <p className="sub">Registration is open until {day(region.regClosesOn)}.</p>
          )}
        </>
      )}

      {region && open && (
        <>
          {mine && mine.children.length > 0 && (
            <div className="returning">
              <span className="sub">Signing up a child from before? Pick them:</span>
              <div className="row">
                {mine.children.map((c) => (
                  <button
                    key={c.playerId}
                    type="button"
                    className="btn ghost btn-sm"
                    onClick={() =>
                      setKids((k) => {
                        const blank = k.findIndex((x) => !x.name.trim());
                        const next = { ...emptyChild(), name: c.name, priorPlayerId: c.playerId };
                        return blank >= 0 ? k.map((x, j) => (j === blank ? next : x)) : [...k, next];
                      })
                    }
                  >
                    + {c.name} ({c.teamName})
                  </button>
                ))}
              </div>
            </div>
          )}

          {kids.map((k, i) => (
            <div className="field-grid join-child" key={i}>
              <label>
                Child's name
                <input value={k.name} maxLength={80} onChange={(e) => update(i, { name: e.target.value })} />
              </label>
              <label>
                Birth month
                <select value={k.birthMonth} onChange={(e) => update(i, { birthMonth: e.target.value })}>
                  <option value="">Month…</option>
                  {MONTHS.map((m, n) => (
                    <option key={m} value={n + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Birth year
                <select value={k.birthYear} onChange={(e) => update(i, { birthYear: e.target.value })}>
                  <option value="">Year…</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Plays with
                <select value={k.gender} onChange={(e) => update(i, { gender: e.target.value as ChildDraft['gender'] })}>
                  <option value="">Choose…</option>
                  <option value="boys">Boys</option>
                  <option value="girls">Girls</option>
                </select>
              </label>
              {kids.length > 1 && (
                <button type="button" className="btn ghost btn-sm" onClick={() => setKids((all) => all.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn ghost btn-sm" onClick={() => setKids((k) => [...k, emptyChild()])}>
              + Add another child
            </button>
          </div>
          <label>
            Phone (optional, for the region)
            <input type="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <details className="parent-extra">
            <summary>About you and the other parent (optional)</summary>
            <div className="field-grid">
              <label>
                You are the
                <select value={myLabel} onChange={(e) => setMyLabel(e.target.value as ParentLabel | '')}>
                  <option value="">Parent</option>
                  {PARENT_LABELS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Salutation
                <select value={salutation} onChange={(e) => setSalutation(e.target.value)}>
                  <option value="">None</option>
                  {SALUTATIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Other parent's email
                <input type="email" value={otherEmail} maxLength={200} placeholder="name@example.com" onChange={(e) => setOtherEmail(e.target.value)} />
              </label>
              {otherEmail.trim() && (
                <label>
                  They are the
                  <select value={otherLabel} onChange={(e) => setOtherLabel(e.target.value as ParentLabel | '')}>
                    <option value="">Parent</option>
                    {PARENT_LABELS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="note">
              The other parent gets an email invite once your child is on a team. It shows them the same children, so
              they don't type anything in.
            </p>
          </details>
          <button type="button" className="btn" disabled={busy || !ready} onClick={submit}>
            Sign up
          </button>
        </>
      )}

      {active.length > 0 && (
        <>
          <h3>Your sign-ups</h3>
          <ul className="signup-list">
            {active.map((s) => (
              <li key={s.id}>
                <strong>{s.childName}</strong> · {s.competitionName ?? s.regionName}
                {s.competitionName ? ` · ${s.regionName}` : ` · ${s.season}`}
                <br />
                <span className="sub">
                  {s.status === 'placed' && s.teamName ? `On ${s.teamName}` : STATUS_LABEL[s.status] ?? s.status}
                </span>
                {(s.status === 'pending' || s.status === 'approved') && (
                  <button type="button" className="linkish" onClick={() => withdraw(s)}>
                    Withdraw
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A region's Sign-ups tab (Fady, 10/17): each league or tournament's sign-up
 * link and registration dates, the children waiting to be approved and placed
 * on one of its teams, then the people already in the region.
 */
export function RegionSignupsPanel({ regionId, onChanged }: { regionId: string; onChanged?: () => void }) {
  const [data, setData] = useState<RegionSignups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [teamFor, setTeamFor] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [windowFor, setWindowFor] = useState<string | null>(null);
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');

  const load = useCallback(() => {
    api
      .regionSignups(regionId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load sign-ups'));
  }, [regionId]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <section className="card err">{error}</section> : null;

  const waiting = data.signups.filter((s) => s.status === 'pending' || s.status === 'approved');
  const placed = data.signups.filter((s) => s.status === 'placed');
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const REG_LABEL = { open: 'Registration open', upcoming: 'Opens soon', closed: 'Registration closed' } as const;

  return (
    <>
      <section className="card" data-tour="signup-links">
        <h2>Sign-up links</h2>
        <p className="note">
          Each league or tournament has its own sign-up link. Families open it during its registration dates, create
          their account and sign their children up; you place each child on one of its teams. After registration
          closes, the link says when it closed. To add a league or tournament, use the Games tab.
        </p>
        {error && <p className="danger-text">{error}</p>}
        {data.competitions.length === 0 ? (
          <p className="note">No league or tournament yet, so there is nothing to sign up for.</p>
        ) : (
          <ul className="signup-comps">
            {data.competitions.map((c) => {
              const link = `${location.origin}/join/${encodeURIComponent(c.code)}`;
              return (
                <li key={c.competitionId}>
                  <div className="signup-comp-head">
                    <strong>
                      {c.kind === 'tournament' ? '🏆' : '📅'} {c.competitionName}
                    </strong>
                    <span className={`comp-status ${c.registration === 'open' ? 'active' : c.registration === 'upcoming' ? 'upcoming' : ''}`}>
                      {REG_LABEL[c.registration]}
                    </span>
                  </div>
                  <span className="sub">
                    Code {c.code} · registration {c.regOpensOn ? `${day(c.regOpensOn)} – ` : 'until '}
                    {day(c.regClosesOn)} · {c.waiting} waiting
                  </span>
                  <div className="row">
                    <button
                      type="button"
                      className="btn ghost btn-sm"
                      onClick={async () => {
                        await navigator.clipboard.writeText(link);
                        setCopied(c.competitionId);
                        setTimeout(() => setCopied(null), 1800);
                      }}
                    >
                      {copied === c.competitionId ? 'Copied' : 'Copy sign-up link'}
                    </button>
                    <a
                      className="btn ghost btn-sm"
                      href={`https://wa.me/?text=${encodeURIComponent(`Sign up for ${c.competitionName} (${c.regionName}) on Lineup: ${link}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      WhatsApp
                    </a>
                    {windowFor !== c.competitionId && (
                      <button
                        type="button"
                        className="btn ghost btn-sm"
                        onClick={() => {
                          setWindowFor(c.competitionId);
                          setOpens(c.regOpensOn ?? '');
                          setCloses(c.regClosesOn);
                        }}
                      >
                        Registration dates
                      </button>
                    )}
                  </div>
                  {windowFor === c.competitionId && (
                    <div className="comp-form">
                      <div className="field-grid">
                        <label>
                          Opens (optional)
                          <input type="date" value={opens} onChange={(e) => setOpens(e.target.value)} />
                        </label>
                        <label>
                          Closes
                          <input type="date" value={closes} min={opens || undefined} onChange={(e) => setCloses(e.target.value)} />
                        </label>
                      </div>
                      <p className="sub">Extend registration any time by moving the closing date.</p>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() =>
                            act(() =>
                              api.regionSignupAction({
                                regionId,
                                action: 'window',
                                competitionId: c.competitionId,
                                regOpensOn: opens || null,
                                regClosesOn: closes || null,
                              }),
                            ).then(() => setWindowFor(null))
                          }
                        >
                          Save
                        </button>
                        <button type="button" className="btn ghost btn-sm" onClick={() => setWindowFor(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" data-tour="players-to-place">
        <h2>
          Players to place <span className="count">{waiting.length}</span>
        </h2>
        {waiting.length === 0 ? (
          <p className="note">No one is waiting. New sign-ups show here, and you get a notification in the bell.</p>
        ) : (
          <ul className="signup-list">
            {waiting.map((s) => {
              // A league or tournament sign-up goes on one of its teams.
              const comp = data.competitions.find((c) => c.competitionId === s.competitionId);
              const teams = comp ? data.teams.filter((t) => comp.teamIds.includes(t.id)) : data.teams;
              return (
                <li key={s.id}>
                  <div className="signup-row">
                    <div>
                      <strong>{s.childName}</strong> · {s.division} · born {MONTHS[s.birthMonth - 1]} {s.birthYear}
                      {s.competitionName ? <> · {s.competitionName}</> : null}
                      <br />
                      <span className="sub">
                        {s.parentName ?? s.parentEmail}
                        {s.parentEmail && s.parentName ? ` · ${s.parentEmail}` : ''}
                        {s.parentPhone ? ` · ${s.parentPhone}` : ''}
                        {s.status === 'approved' ? ' · Approved' : ''}
                      </span>
                    </div>
                    <div className="row">
                      {s.status === 'pending' && (
                        <>
                          <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => act(() => api.regionSignupAction({ regionId, action: 'approve', ids: [s.id] }))}>
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            disabled={busy}
                            onClick={() => {
                              if (confirm(`Decline ${s.childName}'s sign-up?`)) void act(() => api.regionSignupAction({ regionId, action: 'decline', ids: [s.id] }));
                            }}
                          >
                            Decline
                          </button>
                        </>
                      )}
                      <select
                        aria-label={`Team for ${s.childName}`}
                        value={teamFor[s.id] ?? ''}
                        onChange={(e) => setTeamFor((t) => ({ ...t, [s.id]: e.target.value }))}
                      >
                        <option value="">
                          {teams.length ? 'Pick a team…' : comp ? 'Add teams to this league first' : 'Add a team to this region first'}
                        </option>
                        {teams
                          .slice()
                          .sort((a, b) => Number(b.division === s.division) - Number(a.division === s.division))
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                              {t.division ? ` (${t.division})` : ''}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy || !teamFor[s.id]}
                        onClick={() => act(() => api.regionSignupAction({ regionId, action: 'place', id: s.id, teamId: teamFor[s.id] }))}
                      >
                        Place
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {placed.length > 0 && <p className="note">{placed.length} placed on teams.</p>}
      </section>

      <RegionPeople regionId={regionId} data={data} busy={busy} act={act} />
    </>
  );
}

const ROLE_LABEL: Record<string, string> = {
  coach: 'Coach',
  assistant: 'Assistant coach',
  team_parent: 'Team parent',
  parent: 'Parent',
  viewer: 'Viewer',
};

/**
 * People already in the region (signed up with the code, or on one of its
 * teams). Staff give them a role on a team directly, with no invite.
 */
function RegionPeople({
  regionId,
  data,
  busy,
  act,
}: {
  regionId: string;
  data: RegionSignups;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [teamFor, setTeamFor] = useState<Record<string, string>>({});
  const [roleFor, setRoleFor] = useState<Record<string, string>>({});
  const [childFor, setChildFor] = useState<Record<string, string>>({});
  const [rosters, setRosters] = useState<Record<string, Array<{ id: string; name: string; number: string }>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  // What the last "Give role" did, shown under that person until the next one.
  const [done, setDone] = useState<{ userId: string; text: string } | null>(null);

  function pickTeam(userId: string, teamId: string) {
    setTeamFor((t) => ({ ...t, [userId]: teamId }));
    setChildFor((c) => ({ ...c, [userId]: '' }));
    if (teamId && !rosters[teamId]) {
      api
        .listPlayers(teamId)
        .then((pu) => setRosters((r) => ({ ...r, [teamId]: pu.filter((p) => p.active) })))
        .catch(() => setRosters((r) => ({ ...r, [teamId]: [] })));
    }
  }
  const people = data.people ?? [];
  const shown = people
    .filter((p) => `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''));

  return (
    <section className="card">
      <h2>
        People in this region <span className="count">{people.length}</span>
      </h2>
      <p className="note">
        Everyone who signed up with your code or is on one of your teams. Tap a name to see their roles
        and give them a role on a team, for example coach or team parent. It applies straight away; no
        invite is needed.
      </p>
      {people.length > 8 && (
        <input className="search" placeholder="Search by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
      )}
      {people.length === 0 ? (
        <p className="note">No one yet. Share your join code to get families signed up.</p>
      ) : (
        <ul className="people-list">
          {shown.map((p) => {
            const isOpen = openId === p.userId;
            return (
              <li key={p.userId} className={isOpen ? 'open' : ''}>
                <button
                  type="button"
                  className="person"
                  aria-expanded={isOpen}
                  onClick={() => setOpenId(isOpen ? null : p.userId)}
                >
                  <span className="person-name">{p.name ?? p.email ?? 'Unnamed account'}</span>
                  <span className="sub">{p.roles.length ? `${p.roles.length} role${p.roles.length > 1 ? 's' : ''}` : 'No team yet'}</span>
                  <span className="person-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div className="person-detail">
                    {p.email && <p className="sub">{p.email}</p>}
                    {p.roles.length ? (
                      <ul className="person-roles">
                        {p.roles.map((r) => (
                          <li key={`${r.teamId}-${r.role}`}>
                            {ROLE_LABEL[r.role] ?? r.role} of {r.teamName}
                            {r.children && r.children.length > 0 && (
                              <span className="sub"> · child: {r.children.join(', ')}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="sub">No team yet</p>
                    )}
                    {done?.userId === p.userId && (
                      <p className="note" role="status">
                        ✓ {done.text}
                      </p>
                    )}
                    <div className="row">
                      <select
                        aria-label={`Role for ${p.name ?? p.email}`}
                        value={roleFor[p.userId] ?? 'coach'}
                        onChange={(e) => setRoleFor((r) => ({ ...r, [p.userId]: e.target.value }))}
                      >
                        <option value="coach">Coach</option>
                        <option value="assistant">Assistant coach</option>
                        <option value="team_parent">Team parent</option>
                        <option value="parent">Parent</option>
                      </select>
                      <select
                        aria-label={`Team for ${p.name ?? p.email}`}
                        value={teamFor[p.userId] ?? ''}
                        onChange={(e) => pickTeam(p.userId, e.target.value)}
                      >
                        <option value="">{data.teams.length ? 'Pick a team…' : 'Add a team first'}</option>
                        {data.teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      {teamFor[p.userId] && (
                        <select
                          aria-label={`Child for ${p.name ?? p.email}`}
                          value={childFor[p.userId] ?? ''}
                          onChange={(e) => setChildFor((c) => ({ ...c, [p.userId]: e.target.value }))}
                        >
                          <option value="">
                            {(roleFor[p.userId] ?? 'coach') === 'parent' ? 'Their child…' : 'Their child (optional)'}
                          </option>
                          {(rosters[teamFor[p.userId]] ?? []).map((pl) => (
                            <option key={pl.id} value={pl.id}>
                              {pl.number ? `#${pl.number} ` : ''}
                              {pl.name}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={
                          busy ||
                          !teamFor[p.userId] ||
                          ((roleFor[p.userId] ?? 'coach') === 'parent' && !childFor[p.userId])
                        }
                        onClick={() => {
                          const role = roleFor[p.userId] ?? 'coach';
                          const teamId = teamFor[p.userId];
                          const childId = childFor[p.userId] || undefined;
                          const teamName = data.teams.find((t) => t.id === teamId)?.name ?? 'the team';
                          const childName = childId ? (rosters[teamId] ?? []).find((pl) => pl.id === childId)?.name : undefined;
                          void act(async () => {
                            await api.regionSignupAction({
                              regionId,
                              action: 'assign',
                              userId: p.userId,
                              teamId,
                              role,
                              playerId: childId,
                            });
                            setDone({
                              userId: p.userId,
                              text: `Saved: ${ROLE_LABEL[role] ?? role} of ${teamName}${childName ? `, linked to ${childName}` : ''}.`,
                            });
                            setTeamFor((t) => ({ ...t, [p.userId]: '' }));
                            setChildFor((c) => ({ ...c, [p.userId]: '' }));
                          });
                        }}
                      >
                        Give role
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * A league or tournament's sign-ups, on its page (Fady, 10/19; every kind and
 * owner, cups included): the sign-up link to share
 * with families, its registration dates, and the children waiting to be placed
 * on one of its teams. The coach never types children's details: placing a
 * child adds them to the roster and links the parent (and invites the other
 * parent, if one was given).
 */
export function CoachSignupsPanel({ competitionId, onChanged }: { competitionId: string; onChanged?: () => void }) {
  const [data, setData] = useState<CoachSignups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [teamFor, setTeamFor] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [hidden, setHidden] = useState(false);

  const load = useCallback(() => {
    api
      .coachSignups(competitionId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        // Not theirs to see (not staff, nor a coach of one of its teams): nothing to show.
        if (e instanceof ApiError && e.status === 403) setHidden(true);
        else setError(e instanceof Error ? e.message : 'Could not load sign-ups');
      });
  }, [competitionId]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (!data) return error ? <section className="card err">{error}</section> : null;
  const c = data.competition;
  const shareOnly = Boolean(data.shareOnly);
  const link = `${location.origin}/join/${encodeURIComponent(c.code)}`;
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const waiting = data.signups.filter((s) => s.status === 'pending' || s.status === 'approved');
  const placed = data.signups.filter((s) => s.status === 'placed');
  const REG = { open: 'Registration open', upcoming: 'Opens soon', closed: 'Registration closed' } as const;

  return (
    <section className="card" data-tour="coach-signups">
      <h2>Sign-ups</h2>
      {shareOnly ? (
        <p className="note">
          Share this link with your team’s families. Parents sign in, add their children and sign up; the league’s staff
          approve them and place them on teams.
        </p>
      ) : (
        <p className="note">
          Share this link with families instead of typing the roster. Parents sign in, add their children and sign up;
          you place each child on one of this {c.kind === 'tournament' ? 'tournament' : 'league'}'s teams. You only add
          numbers and positions.
        </p>
      )}
      {error && <p className="danger-text">{error}</p>}
      <div className="signup-comp-head">
        <span className="sub">
          Code {c.code} · registration {c.regOpensOn ? `${day(c.regOpensOn)} – ` : 'until '}
          {day(c.regClosesOn)}
        </span>
        <span className={`comp-status ${c.registration === 'open' ? 'active' : c.registration === 'upcoming' ? 'upcoming' : ''}`}>
          {REG[c.registration]}
        </span>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn ghost btn-sm"
          onClick={async () => {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
        >
          {copied ? 'Copied' : 'Copy sign-up link'}
        </button>
        <a
          className="btn ghost btn-sm"
          href={`https://wa.me/?text=${encodeURIComponent(`Sign up for ${c.competitionName} on Lineup: ${link}`)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          WhatsApp
        </a>
        {!editing && !shareOnly && (
          <button
            type="button"
            className="btn ghost btn-sm"
            onClick={() => {
              setEditing(true);
              setOpens(c.regOpensOn ?? '');
              setCloses(c.regClosesOn);
            }}
          >
            Registration dates
          </button>
        )}
      </div>
      {editing && (
        <div className="row">
          <label>
            Opens
            <input type="date" value={opens} onChange={(e) => setOpens(e.target.value)} />
          </label>
          <label>
            Closes
            <input type="date" value={closes} onChange={(e) => setCloses(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api.coachSignupAction({ competitionId, action: 'window', regOpensOn: opens || null, regClosesOn: closes || null });
                setEditing(false);
              })
            }
          >
            Save
          </button>
          <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}

      {!shareOnly && (
        <>
      <h3 className="group-title">
        Players to place <span className="count">{waiting.length}</span>
      </h3>
      {data.teams.length === 0 && <p className="note warn">Add your teams to this {c.kind === 'tournament' ? 'tournament' : 'league'} first, so you can place children on them.</p>}
      {waiting.length === 0 ? (
        <p className="note">No one is waiting. New sign-ups show here, and you get a notification in the bell.</p>
      ) : (
        <ul className="signup-list">
          {waiting.map((s) => (
            <li key={s.id}>
              <div className="signup-row">
                <div>
                  <strong>{s.childName}</strong> · {s.division} · born {MONTHS[s.birthMonth - 1]} {s.birthYear}
                  <br />
                  <span className="sub">
                    {s.parentName ?? s.parentEmail}
                    {s.parentLabel ? ` (${s.parentLabel})` : ''}
                    {s.parentEmail && s.parentName ? ` · ${s.parentEmail}` : ''}
                    {s.parentPhone ? ` · ${s.parentPhone}` : ''}
                    {s.secondParentEmail ? ` · other parent: ${s.secondParentEmail}` : ''}
                    {s.status === 'approved' ? ' · Approved' : ''}
                  </span>
                </div>
                <div className="row">
                  {s.status === 'pending' && (
                    <>
                      <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void act(() => api.coachSignupAction({ competitionId, action: 'approve', ids: [s.id] }))}>
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn ghost btn-sm"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Decline ${s.childName}'s sign-up?`)) void act(() => api.coachSignupAction({ competitionId, action: 'decline', ids: [s.id] }));
                        }}
                      >
                        Decline
                      </button>
                    </>
                  )}
                  <select aria-label={`Team for ${s.childName}`} value={teamFor[s.id] ?? ''} onChange={(e) => setTeamFor((t) => ({ ...t, [s.id]: e.target.value }))}>
                    <option value="">{data.teams.length ? 'Pick a team…' : 'No teams yet'}</option>
                    {data.teams
                      .slice()
                      .sort((a, b) => Number(b.division === s.division) - Number(a.division === s.division))
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.division ? ` (${t.division})` : ''}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || !teamFor[s.id]}
                    onClick={() => void act(() => api.coachSignupAction({ competitionId, action: 'place', id: s.id, teamId: teamFor[s.id] }))}
                  >
                    Place
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {placed.length > 0 && (
        <p className="note">
          {placed.length} placed: {placed.map((s) => `${s.childName} (${s.teamName ?? 'team'})`).join(', ')}.
        </p>
      )}
        </>
      )}
    </section>
  );
}

const LABEL_WORD: Record<ParentLabel, string> = { mother: 'Mother', father: 'Father', guardian: 'Guardian' };

/**
 * Account: your family (Fady, 10/19). Your children, the other parent(s),
 * invites waiting, inviting the other parent (they get the same children),
 * and how you'd like to be called: mother, father or guardian, and a
 * salutation. All optional.
 */
export function FamilyCard() {
  const [data, setData] = useState<Family | null>(null);
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState<ParentLabel | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .family()
      .then(setData)
      .catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  if (!data || data.children.length === 0) return null;
  const kids = [...new Set(data.children.map((c) => c.name))];

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card family-card">
      <h2>Your family</h2>
      <p className="note">
        {kids.join(', ')} · {data.children.map((c) => c.teamName).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
      </p>
      {error && <p className="danger-text">{error}</p>}
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}

      <div className="field-grid">
        <label>
          You are the
          <select
            value={data.label ?? ''}
            disabled={busy}
            onChange={(e) =>
              void run(
                () => api.familyAction({ action: 'profile', salutation: data.salutation, label: (e.target.value || null) as ParentLabel | null }),
                'Saved.',
              )
            }
          >
            <option value="">Parent</option>
            {PARENT_LABELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Salutation
          <select
            value={data.salutation ?? ''}
            disabled={busy}
            onChange={(e) => void run(() => api.familyAction({ action: 'profile', salutation: e.target.value || null, label: data.label }), 'Saved.')}
          >
            <option value="">None</option>
            {SALUTATIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="group-title">Other parents</h3>
      {data.otherParents.length === 0 && data.pending.length === 0 && <p className="note">No one else yet.</p>}
      <ul className="signup-list">
        {data.otherParents.map((o, i) => (
          <li key={`${o.email}-${i}`}>
            <strong>{[o.salutation, o.name ?? o.email].filter(Boolean).join(' ')}</strong>
            {o.label ? ` · ${LABEL_WORD[o.label]}` : ''}
            <br />
            <span className="sub">Sees {o.children.join(', ')}</span>
          </li>
        ))}
        {data.pending.map((p) => (
          <li key={p.email}>
            <strong>{p.email}</strong>
            {p.label ? ` · ${LABEL_WORD[p.label]}` : ''}
            <br />
            <span className="sub">Invite sent {new Date(p.sentAt).toLocaleDateString()}, waiting to be accepted</span>
          </li>
        ))}
      </ul>

      <div className="field-grid">
        <label>
          Invite the other parent (email)
          <input type="email" value={email} maxLength={200} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          They are the
          <select value={label} onChange={(e) => setLabel(e.target.value as ParentLabel | '')}>
            <option value="">Parent</option>
            {PARENT_LABELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy || !email.trim()}
        onClick={() =>
          void run(async () => {
            await api.familyAction({ action: 'invite', email: email.trim(), label: label || null });
            setEmail('');
          }, 'Done. They get an email invite; once they accept, they see the same children.')
        }
      >
        Send invite
      </button>
      <p className="note">They get an email link. Once they accept, they see {kids.join(' and ')} too: no forms to fill in.</p>
    </section>
  );
}
