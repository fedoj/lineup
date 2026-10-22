import { useEffect, useMemo, useState } from 'react';
import {
  defaultAvatarFor,
  FORMATS,
  FORMAT_IDS,
  formationNames,
  isTeamAgeGroup,
  TEAM_TYPE_SUGGESTIONS,
  type Format,
  type Player,
  type Role,
  type Team,
} from '@lineup/shared';
import { api, apiPath, peek, type CatalogDivision, type Evaluations, type InviteCreated, type TeamPeople } from '../lib/api';
import RosterRow from '../components/RosterRow';
import InviteShare from '../components/InviteShare';
import { Rating, RosterEvaluation } from '../components/PlayerEvaluation';
import PlayerAvatar from '../components/PlayerAvatar';
import { LogoUpload } from '../components/Logo';

interface Props {
  team: Team;
  players: Player[];
  /** May change the roster, logo and division (coaches and above). */
  canEdit: boolean;
  /** May invite people to this team (coaches and above, not assistants). */
  canInvite?: boolean;
  /** Current logo version, null when the team has none. */
  logo?: string | null;
  onLogo?: (version: string | null) => void;
  onPlayers: (p: Player[]) => void;
  onTeam: (t: Team) => void;
  /** The team is in a region or organization: how its players arrive, and the way to its leagues. */
  joinVia?: { name: string; onOpenLeagues: () => void } | null;
  /** A coach's own team: open the Games page to start a league or tournament. */
  onCreateLeague?: () => void;
}

export default function TeamSetup({
  team,
  players,
  canEdit,
  canInvite = false,
  logo,
  onLogo,
  onPlayers,
  onTeam,
  joinVia,
  onCreateLeague,
}: Props) {
  const [draft, setDraft] = useState(players);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [catalog, setCatalog] = useState<CatalogDivision[]>([]);
  const [divisionDraft, setDivisionDraft] = useState('');
  const [savingDivision, setSavingDivision] = useState(false);

  useEffect(() => setDraft(players), [players]);

  // Only teams with no division need the picker, so the catalog is loaded lazily.
  const needsDivision = !team.catalogDivisionId;
  useEffect(() => {
    if (!needsDivision) return;
    api.catalog().then(setCatalog).catch(() => setCatalog([]));
  }, [needsDivision]);

  async function saveDivision() {
    if (!divisionDraft) return;
    setError(null);
    setSavingDivision(true);
    try {
      onTeam(await api.updateTeam({ id: team.id, catalogDivisionId: divisionDraft }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingDivision(false);
    }
  }

  /** Flag duplicate shirt numbers before the save rather than after. */
  const duplicateNumbers = useMemo(() => {
    const seen = new Map<string, number>();
    for (const p of draft) {
      const n = p.number.trim();
      if (!n) continue;
      seen.set(n, (seen.get(n) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n));
  }, [draft]);

  async function save() {
    setError(null);
    const named = draft.filter((p) => p.name.trim());
    try {
      const next = await api.savePlayers(team.id, named);
      onPlayers(next);
      setDraft(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    }
  }

  const formatLabel = team.format ? FORMATS[team.format as Format]?.label : null;

  return (
    <>
      {error && <section className="card err">{error}</section>}

      <section className="card">
        <h2>{team.name}</h2>
        <dl className="kv">
          <dt>Division</dt>
          <dd>{team.ageGroup || team.catalogDivisionId || '—'}</dd>
          <dt>Format</dt>
          <dd>{formatLabel ?? '—'}</dd>
          <dt>Periods</dt>
          <dd>{team.periods === 'halves' ? 'Halves' : 'Quarters'}</dd>
          <dt>Coach</dt>
          <dd>{team.coach || '—'}</dd>
          <dt>Team type</dt>
          <dd>
            {canEdit ? (
              <TeamTypeEdit team={team} onTeam={onTeam} />
            ) : (
              team.teamType || '—'
            )}
          </dd>
        </dl>
        <p className="note">
          The division sets the match format for every game on this team.
        </p>

        {canEdit && onLogo && (
          <LogoUpload kind="team" id={team.id} version={logo} onChanged={onLogo} />
        )}

        {needsDivision && canEdit && (
          <div className="division-fix">
            <p className="note warn">
              This team has no division, so new games fall back to 7v7. Pick one to set the
              correct format.
            </p>
            <div className="row">
              <select value={divisionDraft} onChange={(e) => setDivisionDraft(e.target.value)}>
                <option value="">Choose a division…</option>
                {catalog.filter((c) => isTeamAgeGroup(c.ageU)).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} — {c.label} ({c.format})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn"
                onClick={saveDivision}
                disabled={!divisionDraft || savingDivision}
              >
                {savingDivision ? 'Saving…' : 'Set division'}
              </button>
            </div>
          </div>
        )}
      </section>

      {canInvite && <InviteMember teamId={team.id} players={players.filter((p) => p.id && p.active)} />}

      <RosterHelp team={team} canEdit={canEdit} joinVia={joinVia} onCreateLeague={onCreateLeague} />

      <RosterCard
        team={team}
        draft={draft}
        setDraft={setDraft}
        canEdit={canEdit}
        canAddPlayers={team.canAddPlayers ?? canEdit}
        duplicateNumbers={duplicateNumbers}
        saved={saved}
        onSave={save}
      />
    </>
  );
}

/**
 * How players get onto this team (Fady, 10/20). In a region or organization
 * its staff approve and place players as families sign up for leagues and
 * tournaments. A coach's own team can do the same with a league or tournament
 * of its own, or skip it and type the roster in.
 */
function RosterHelp({
  team,
  canEdit,
  joinVia,
  onCreateLeague,
}: {
  team: Team;
  canEdit: boolean;
  joinVia?: { name: string; onOpenLeagues: () => void } | null;
  onCreateLeague?: () => void;
}) {
  const key = `lineup.rosterHelpClosed.${team.id}`;
  const [closed, setClosed] = useState(() => Boolean(localStorage.getItem(key)));
  if (joinVia) {
    return (
      <section className="card roster-help" data-fold-open>
        <h2>How players join</h2>
        <p className="note">
          Players are approved and placed on this team by {joinVia.name} staff as families sign up for its leagues and
          tournaments. Your team’s leagues and tournaments, and their sign-up links when you can share them, are on the Games page.
        </p>
        <button type="button" className="btn btn-sm" onClick={joinVia.onOpenLeagues}>
          ⚽ Leagues &amp; tournaments
        </button>
      </section>
    );
  }
  if (!canEdit || !onCreateLeague || closed) return null;
  return (
    <section className="card roster-help" data-fold-open>
      <h2>Let families sign up themselves</h2>
      <p className="note">
        Skip the typing ✨ Create a league or tournament, add this team to it and share its sign-up link. Parents
        register their own children, and you just place them on the team.
      </p>
      <div className="row">
        <button type="button" className="btn btn-sm" onClick={onCreateLeague}>
          ⚽ Create a league or tournament
        </button>
        <button
          type="button"
          className="btn ghost btn-sm"
          onClick={() => {
            localStorage.setItem(key, '1');
            setClosed(true);
          }}
        >
          No, I’ll add the roster myself
        </button>
      </div>
      <p className="sub">Choose “No” if parents won’t use Lineup for chat, the calendar or attendance.</p>
    </section>
  );
}

const STAFF_LABEL: Record<string, string> = {
  coach: 'Coach',
  assistant: 'Assistant coach',
  team_parent: 'Team parent',
};

/**
 * The roster as three simple lists: players, staff (coaches, assistant
 * coaches, team parents) and parents. A player's details open when their name
 * is tapped; staff and parents are names only.
 */
function RosterCard({
  team,
  draft,
  setDraft,
  canEdit,
  canAddPlayers,
  duplicateNumbers,
  saved,
  onSave,
}: {
  team: Team;
  draft: Player[];
  setDraft: (next: Player[]) => void;
  canEdit: boolean;
  canAddPlayers: boolean;
  duplicateNumbers: Set<string>;
  saved: boolean;
  onSave: () => void;
}) {
  const [tab, setTab] = useState<'players' | 'staff' | 'parents'>('players');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<TeamPeople | null>(() => peek<TeamPeople>(apiPath.teamPeople(team.id)) ?? null);
  const [personOpen, setPersonOpen] = useState<string | null>(null);
  const [peopleMsg, setPeopleMsg] = useState<string | null>(null);
  // Ratings, cards and avatars, shown on each player (Fady, 10/18).
  const [evals, setEvals] = useState<Evaluations | null>(() => peek<Evaluations>(apiPath.evaluations(team.id)) ?? null);
  const loadEvals = () =>
    api
      .evaluations(team.id)
      .then(setEvals)
      .catch(() => setEvals(null));
  useEffect(() => {
    setEvals(peek<Evaluations>(apiPath.evaluations(team.id)) ?? null);
    void loadEvals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.id]);
  const evalOf = (playerId: string) => (playerId ? evals?.evaluations.find((e) => e.playerId === playerId) : undefined);

  const loadPeople = () =>
    api
      .teamPeople(team.id)
      .then((p) => setPeople(p))
      .catch(() => setPeople({ staff: [], parents: [] }));

  async function linkChild(action: 'link' | 'unlink', userId: string, playerId: string) {
    setPeopleMsg(null);
    try {
      await api.linkChild({ action, teamId: team.id, userId, playerId });
      await loadPeople();
    } catch (e) {
      setPeopleMsg(e instanceof Error ? e.message : 'Could not update the child link.');
    }
  }

  useEffect(() => {
    let live = true;
    setPeople(peek<TeamPeople>(apiPath.teamPeople(team.id)) ?? null);
    api
      .teamPeople(team.id)
      .then((p) => live && setPeople(p))
      .catch(() => live && setPeople({ staff: [], parents: [] }));
    return () => {
      live = false;
    };
  }, [team.id]);

  const keyOf = (p: Player, i: number) => p.id || `new-${i}`;
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const activeCount = draft.filter((p) => p.active).length;

  return (
    <section className="card" data-tour="roster" data-fold-open>
      <div className="card-head">
        <h2>Roster</h2>
      </div>
      <div className="seg roster-tabs" role="tablist" aria-label="Roster lists">
        <button type="button" role="tab" aria-selected={tab === 'players'} className={tab === 'players' ? 'on' : ''} onClick={() => setTab('players')}>
          Players <span className="count">{activeCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'staff'} className={tab === 'staff' ? 'on' : ''} onClick={() => setTab('staff')}>
          Staff <span className="count">{people?.staff.length ?? '…'}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'parents'} className={tab === 'parents' ? 'on' : ''} onClick={() => setTab('parents')}>
          Parents <span className="count">{people?.parents.length ?? '…'}</span>
        </button>
      </div>

      {tab === 'players' && (
        <>
          {draft.length === 0 ? (
            <p className="note">No players yet.</p>
          ) : (
            <ul className="people-list">
              {draft.map((p, i) => {
                const k = keyOf(p, i);
                const isOpen = open.has(k);
                const ev = evalOf(p.id);
                return (
                  <li key={k} className={isOpen ? 'open' : ''}>
                    <button
                      type="button"
                      className="person"
                      aria-expanded={isOpen}
                      onClick={() => toggle(k)}
                    >
                      <PlayerAvatar avatar={ev?.avatar ?? defaultAvatarFor(p.gender)} size={34} title={`${p.name.trim() || 'Player'} avatar`} />
                      <span className="person-num">{p.number.trim() ? `#${p.number.trim()}` : '#–'}</span>
                      <span className="person-name">{p.name.trim() || 'New player'}</span>
                      {ev?.card?.rating != null && <Rating ev={ev} />}
                      {!p.active && <span className="pill small">Inactive</span>}
                      <span className="person-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    </button>
                    {isOpen && (
                      <div className="person-detail roster">
                        <RosterRow
                          player={p}
                          disabled={!canEdit}
                          duplicate={Boolean(p.number.trim() && duplicateNumbers.has(p.number.trim()))}
                          onChange={(next) => setDraft(draft.map((x, j) => (j === i ? next : x)))}
                          onRemove={canAddPlayers ? () => setDraft(draft.filter((_, j) => j !== i)) : undefined}
                        />
                        <RosterEvaluation ev={ev} data={evals} onChanged={() => void loadEvals()} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="note">
            Tap a player for their number, positions and player card (Evaluate). Positions are
            preferences, not rules: Auto formation leans towards them, but equal playing time always wins.
          </p>
          {canEdit && !canAddPlayers && team.inLeague && (
            <p className="note">
              Players on this team are added and removed by its organization or region. You can still
              change numbers, names, pictures and positions.
            </p>
          )}

          {duplicateNumbers.size > 0 && (
            <p className="note warn">
              Duplicate shirt number{duplicateNumbers.size > 1 ? 's' : ''}:{' '}
              {[...duplicateNumbers].join(', ')}
            </p>
          )}

          {canEdit && (
            <div className="row">
              {canAddPlayers && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    const next = [
                      ...draft,
                      {
                        id: '',
                        teamId: team.id,
                        number: '',
                        name: '',
                        active: true,
                        gender: null,
                        primaryPos: null,
                        secondaryPos: null,
                        neverKeeper: false,
                      },
                    ];
                    setDraft(next);
                    setOpen((prev) => new Set(prev).add(`new-${next.length - 1}`));
                  }}
                >
                  Add player
                </button>
              )}
              <button type="button" className="btn" onClick={onSave}>
                {saved ? 'Saved' : 'Save roster'}
              </button>
            </div>
          )}
        </>
      )}

      {tab === 'staff' &&
        (!people ? (
          <p className="note">Loading…</p>
        ) : people.staff.length === 0 ? (
          <p className="note">No coaches, assistant coaches or team parents have joined yet.</p>
        ) : (
          <ul className="people-list">
            {people.staff.map((s) => (
              <PersonRow
                key={`${s.userId}-${s.role}`}
                avatar={s.role === 'team_parent' ? '🧑' : '🧑‍🏫'}
                name={s.name}
                label={STAFF_LABEL[s.role] ?? s.role}
                linked={s.children ?? []}
                players={draft}
                canLink={Boolean(people.canLink)}
                open={personOpen === s.userId}
                onToggle={() => setPersonOpen(personOpen === s.userId ? null : s.userId)}
                onLink={(pid) => linkChild('link', s.userId, pid)}
                onUnlink={(pid) => linkChild('unlink', s.userId, pid)}
              />
            ))}
          </ul>
        ))}

      {tab === 'parents' &&
        (!people ? (
          <p className="note">Loading…</p>
        ) : people.parents.length === 0 ? (
          <p className="note">No parents have joined yet.</p>
        ) : (
          <ul className="people-list">
            {people.parents.map((p) => (
              <PersonRow
                key={p.userId}
                name={p.name}
                label={p.children.length ? '' : 'No child linked'}
                linked={p.children}
                players={draft}
                canLink={Boolean(people.canLink)}
                open={personOpen === p.userId}
                onToggle={() => setPersonOpen(personOpen === p.userId ? null : p.userId)}
                onLink={(pid) => linkChild('link', p.userId, pid)}
                onUnlink={(pid) => linkChild('unlink', p.userId, pid)}
              />
            ))}
          </ul>
        ))}
      {peopleMsg && <p className="danger-text">{peopleMsg}</p>}
    </section>
  );
}

/**
 * A staff member or parent on the roster: name, role and the children they
 * are linked to. People who can invite on the team tap it to link a child.
 */
function PersonRow({
  avatar,
  name,
  label,
  linked: children,
  players,
  canLink,
  open,
  onToggle,
  onLink,
  onUnlink,
}: {
  avatar?: string;
  name: string;
  label: string;
  linked: Array<{ id: string; name: string }>;
  players: Player[];
  canLink: boolean;
  open: boolean;
  onToggle: () => void;
  onLink: (playerId: string) => void;
  onUnlink: (playerId: string) => void;
}) {
  const [pick, setPick] = useState('');
  const linkedIds = new Set(children.map((c) => c.id));
  const choices = players.filter((p) => p.id && p.active && !linkedIds.has(p.id));
  const childText = children.length ? `Child: ${children.map((c) => c.name).join(', ')}` : '';
  const content = (
    <>
      {avatar && <span className="avatar" aria-hidden="true">{avatar}</span>}
      <span className="person-name">{name}</span>
      <span className="sub">{[label, childText].filter(Boolean).join(' · ')}</span>
      {canLink && <span className="person-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>}
    </>
  );
  return (
    <li className={open ? 'open' : ''}>
      {canLink ? (
        <button type="button" className="person" aria-expanded={open} onClick={onToggle}>
          {content}
        </button>
      ) : (
        <div className="person static">{content}</div>
      )}
      {canLink && open && (
        <div className="person-detail">
          {children.map((c) => (
            <div className="checkin-child" key={c.id}>
              <span>Linked to {c.name}</span>
              <button type="button" className="btn ghost btn-sm" onClick={() => onUnlink(c.id)}>
                Unlink
              </button>
            </div>
          ))}
          <div className="row">
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`Child for ${name}`}>
              <option value="">{choices.length ? 'Link a child…' : 'No other players on the roster'}</option>
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number ? `#${p.number} ` : ''}
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!pick}
              onClick={() => {
                onLink(pick);
                setPick('');
              }}
            >
              Link child
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

const INVITE_ROLES: Array<[Role, string]> = [
  ['coach', 'Coach'],
  ['assistant', 'Assistant coach'],
  ['team_parent', 'Team parent (team mom / manager)'],
  ['parent', 'Parent'],
  ['viewer', 'Viewer (read only)'],
];

/** Invite someone straight onto this team. Coaches and above. */
function InviteMember({ teamId, players }: { teamId: string; players: Player[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('parent');
  const [playerId, setPlayerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const needsChild = role === 'parent';
  const ready = emailOk && (!needsChild || Boolean(playerId));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.invite({
        email: email.trim(),
        name: name.trim() || undefined,
        role,
        teamId,
        playerId: playerId && role !== 'viewer' ? playerId : undefined,
      });
      setCreated(r);
      setName('');
      setEmail('');
      setPlayerId('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The invite could not be created.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {created && <InviteShare invite={created} onClose={() => setCreated(null)} />}
      <section className="card" data-tour="team-invite">
        <div className="card-head">
          <h2>Team members</h2>
          {!open && (
            <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
              Invite member
            </button>
          )}
        </div>
        {!open && (
          <p className="note">Invite coaches, team parents, parents and viewers to this team.</p>
        )}
        {open && (
          <>
            {error && <p className="danger-text">{error}</p>}
            <div className="field-grid">
              <label>
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {INVITE_ROLES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {role !== 'viewer' && (
                <label>
                  {role === 'parent' ? 'Their child' : 'Their child on this team (optional)'}
                  <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
                    <option value="">
                      {role === 'parent'
                        ? players.length
                          ? 'Choose a player…'
                          : 'Add players to the roster first'
                        : 'No child on this team'}
                    </option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.number ? `#${p.number} ` : ''}
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Name (optional)
                <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Email
                <input type="email" value={email} placeholder="person@example.com" onChange={(e) => setEmail(e.target.value)} />
              </label>
            </div>
            {needsChild && !playerId && (
              <p className="note">A parent always joins for a child on the roster, so they see that player.</p>
            )}
            <div className="row">
              <button type="button" className="btn" disabled={busy || !ready} onClick={send}>
                Send invite
              </button>
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}

/**
 * Team creation.
 *
 * The division picks the age group and pre-fills the match setup, but format,
 * periods and default formation are explicit fields the coach can override —
 * leagues do not all follow the same age-to-format convention.
 */
export function NewTeam({
  onCreated,
  onCancel,
  canCancel = false,
  regions,
}: {
  onCreated: (t: Team, invite?: InviteCreated, inviteError?: string) => void;
  onCancel?: () => void;
  canCancel?: boolean;
  /** Regions to create the team in, for organization and region staff. */
  regions?: Array<{ id: string; label: string }>;
}) {
  const [catalog, setCatalog] = useState<CatalogDivision[]>([]);
  const [name, setName] = useState('');
  // All Stars, MLS Next 2, NCL… (Shadi, 10/21).
  const [teamType, setTeamType] = useState('');
  const [regionId, setRegionId] = useState(regions?.[0]?.id ?? '');
  const [gender, setGender] = useState<'boys' | 'girls' | 'coed'>('boys');
  const [divisionId, setDivisionId] = useState('');
  const [coach, setCoach] = useState('');
  const [format, setFormat] = useState<Format | ''>('');
  const [periods, setPeriods] = useState<'quarters' | 'halves' | ''>('');
  const [formation, setFormation] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'coach' | 'assistant' | 'team_parent' | 'viewer'>('coach');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  // Splitting by gender keeps the age list short instead of one 48-row menu.
  const ages = useMemo(
    // MatchTrak's (AYSO's) age groups only (Shadi, 10/21).
    () => catalog.filter((c) => c.gender === gender && isTeamAgeGroup(c.ageU)).sort((a, b) => a.ageU - b.ageU),
    [catalog, gender],
  );

  // Changing gender invalidates the chosen division id (BU10 -> GU10).
  useEffect(() => {
    if (divisionId && !ages.some((a) => a.id === divisionId)) setDivisionId('');
  }, [ages, divisionId]);

  const chosen = catalog.find((c) => c.id === divisionId) ?? null;

  // Picking a division suggests a setup, but never overwrites a deliberate
  // choice the coach has already made.
  useEffect(() => {
    if (!chosen || touched) return;
    setFormat(chosen.format);
    setPeriods(chosen.periods);
    setFormation(FORMATS[chosen.format].defaultFormation);
  }, [chosen, touched]);

  const shapes = format ? formationNames(format) : [];
  useEffect(() => {
    if (format && formation && !shapes.includes(formation)) {
      setFormation(FORMATS[format].defaultFormation);
    }
  }, [format, formation, shapes]);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      const t = await api.createTeam({
        name,
        teamType: teamType.trim() || undefined,
        coach: coach || inviteName,
        catalogDivisionId: divisionId,
        ageGroup: chosen?.label ?? '',
        format: (format || undefined) as Format | undefined,
        periods: (periods || undefined) as 'quarters' | 'halves' | undefined,
        defaultFormation: formation || undefined,
        regionId: regions?.length ? regionId || undefined : undefined,
      });
      // The team exists from here on. An invite problem must not leave the
      // form open, or a second click would create a duplicate team.
      let invite: InviteCreated | undefined;
      let inviteError: string | undefined;
      if (inviteEmail.trim()) {
        try {
          invite = await api.invite({
            email: inviteEmail.trim(),
            name: inviteName.trim() || undefined,
            role: inviteRole,
            teamId: t.id,
          });
        } catch (e) {
          inviteError = e instanceof Error ? e.message : 'The invite could not be created.';
        }
      }
      onCreated(t, invite, inviteError);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const emailOk = !inviteEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim());
  const needsEmail = Boolean(inviteName.trim() && !inviteEmail.trim());

  return (
    <section className="card">
      <h2>New team</h2>
      <p className="note tagline">Let's get your squad on the field ⚽ It takes about a minute.</p>
      {error && <p className="danger-text">{error}</p>}

      <label>
        Team name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Blue Thunder" />
      </label>

      <label>
        Team type (optional)
        <input
          value={teamType}
          maxLength={30}
          list="team-types"
          placeholder="e.g. All Stars, MLS Next 2, NCL"
          onChange={(e) => setTeamType(e.target.value)}
        />
        <TeamTypeOptions />
      </label>

      {regions && regions.length > 1 && (
        <label>
          Region
          <select value={regionId} onChange={(e) => setRegionId(e.target.value)}>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        Boys, girls or coed
        <select value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
          <option value="boys">Boys</option>
          <option value="girls">Girls</option>
          <option value="coed">Coed</option>
        </select>
      </label>

      <label>
        Division
        <select value={divisionId} onChange={(e) => setDivisionId(e.target.value)}>
          <option value="">Choose an age group…</option>
          {ages.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} — {c.label}
            </option>
          ))}
        </select>
      </label>

      {chosen && (
        <p className="note">
          Suggested for {chosen.label}: {chosen.format},{' '}
          {chosen.periods === 'halves' ? 'two halves' : 'four quarters'} of{' '}
          {Math.round(chosen.periodLengthSec / 60)} minutes. Change anything below if your
          league plays differently.
        </p>
      )}

      <div className="field-grid">
        <label>
          Format
          <select
            value={format}
            onChange={(e) => {
              setTouched(true);
              setFormat(e.target.value as Format);
            }}
          >
            <option value="">Choose…</option>
            {FORMAT_IDS.map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Periods
          <select
            value={periods}
            onChange={(e) => {
              setTouched(true);
              setPeriods(e.target.value as 'quarters' | 'halves');
            }}
          >
            <option value="">Choose…</option>
            <option value="quarters">Quarters</option>
            <option value="halves">Halves</option>
          </select>
        </label>

        <label>
          Default formation
          <select
            value={formation}
            disabled={!format}
            onChange={(e) => {
              setTouched(true);
              setFormation(e.target.value);
            }}
          >
            {!format && <option value="">Pick a format first</option>}
            {shapes.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        Coach
        <input value={coach} onChange={(e) => setCoach(e.target.value)} />
      </label>

      <section className="mini-card">
        <h3>Invite someone to this team</h3>
        <p className="note">
          Optional. They get an email with a link to join. If you enter a name, the email is
          required.
        </p>
        <div className="field-grid">
          <label>
            Name
            <input
              value={inviteName}
              onChange={(e) => setInviteName(e.target.value)}
              placeholder="Coach or helper name"
            />
          </label>
          <label>
            Email{needsEmail ? ' (required)' : ''}
            <input
              type="email"
              className={needsEmail || !emailOk ? 'bad-input' : undefined}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="person@example.com"
            />
          </label>
          <label>
            Role
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
              <option value="coach">Coach</option>
              <option value="assistant">Assistant coach</option>
              <option value="team_parent">Team parent (team mom / manager)</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
        </div>
        {needsEmail && <p className="note warn">Add {inviteName.trim()}'s email to send the invite.</p>}
        {!emailOk && <p className="note warn">That email address does not look right.</p>}
      </section>

      <button
        type="button"
        className="btn"
        onClick={create}
        disabled={busy || !name.trim() || !divisionId || !format || !periods || needsEmail || !emailOk}
      >
        {busy ? 'Creating…' : 'Create team'}
      </button>
      {canCancel && (
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      )}
      {!divisionId && (
        <p className="note">Pick a division to continue — it sets the format for every game.</p>
      )}
    </section>
  );
}

/** Suggestions for the team type field; anything else can be typed (Shadi, 10/21). */
export function TeamTypeOptions() {
  return (
    <datalist id="team-types">
      {TEAM_TYPE_SUGGESTIONS.map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

/** Change a team's type in place: saved when the field loses focus or Enter is pressed. */
function TeamTypeEdit({ team, onTeam }: { team: Team; onTeam: (t: Team) => void }) {
  const [value, setValue] = useState(team.teamType ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  useEffect(() => setValue(team.teamType ?? ''), [team.teamType]);
  async function save() {
    const next = value.trim();
    if (next === (team.teamType ?? '')) return;
    setState('saving');
    try {
      onTeam(await api.updateTeam({ id: team.id, teamType: next || null }));
      setState('saved');
      window.setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('error');
    }
  }
  return (
    <span className="row">
      <input
        aria-label="Team type"
        value={value}
        maxLength={30}
        list="team-types"
        placeholder="e.g. All Stars, MLS Next 2, NCL"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <TeamTypeOptions />
      {state === 'saving' ? <span className="sub">Saving…</span> : state === 'saved' ? <span className="sub">Saved</span> : state === 'error' ? <span className="danger-text">Not saved</span> : null}
    </span>
  );
}