import { useCallback, useEffect, useRef, useState } from 'react';
import { GROUP_CHAT_ROLES, chatRefreshDelay } from '@lineup/shared';
import { PollCard, PollComposer, preparePhoto } from '../components/ChatParts';
import { ImageIcon } from '../components/FilePick';
import { PaidLock } from '../lib/features';
import {
  api,
  ApiError,
  type GroupChatList,
  type GroupChatOption,
  type GroupChatSummary,
  type GroupChatView,
} from '../lib/api';

/**
 * Group chats (Shadi, 10/21): chats for people across teams, started by
 * organization and region staff or by someone whose custom role allows it.
 * They live on the organization's or region's Chats tab, at the level they
 * were made (Shadi, 10/21). The list, starting a chat, and one chat.
 */
type Scope = { scope: 'org' | 'region'; scopeId: string };

export default function GroupChats({ scope, scopeId, focus }: Scope & { focus?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(focus ?? null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (focus) setOpenId(focus);
  }, [focus]);

  if (openId) return <ChatView id={openId} onBack={() => setOpenId(null)} />;
  if (creating)
    return (
      <NewChat
        scope={scope}
        scopeId={scopeId}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setOpenId(id);
        }}
      />
    );
  return <ChatList scope={scope} scopeId={scopeId} onOpen={setOpenId} onNew={() => setCreating(true)} />;
}

function todayPacific(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function shortDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function status(c: GroupChatSummary): string | null {
  if (c.archivedAt) return 'Archived';
  if (!c.open && c.endsOn) return `Ended ${shortDate(c.endsOn)}`;
  if (c.endsOn) return `Ends ${shortDate(c.endsOn)}`;
  return null;
}

/** Message text with web links made tappable. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/* ------------------------------------------------------------------- list */

function ChatList({ scope, scopeId, onOpen, onNew }: Scope & { onOpen: (id: string) => void; onNew: () => void }) {
  const [data, setData] = useState<GroupChatList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .groupChats(scope, scopeId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load chats'));
  }, [scope, scopeId]);

  if (error) return <section className="card err">{error}</section>;
  if (!data) return <section className="card">Loading…</section>;

  // The Staff and Admins & directors chats come first (Shadi, 10/22).
  const byDefault = (a: GroupChatSummary, b: GroupChatSummary) => Number(b.isDefault) - Number(a.isDefault);
  const mine = data.chats.filter((c) => c.member && c.open).sort(byDefault);
  const archived = data.chats.filter((c) => c.member && !c.open);
  const others = data.chats.filter((c) => !c.member).sort(byDefault);

  const item = (c: GroupChatSummary) => (
    <li key={c.id}>
      <button type="button" className="comp-card group-chat-item" onClick={() => onOpen(c.id)}>
        <span className="comp-main">
          <strong>
            {c.name}
            {(c.unread ?? 0) > 0 && <span className="group-chat-unread">{c.unread}</span>}
          </strong>
          <span className="sub">
            {c.scopeLabel} · {c.audience}
          </span>
          {c.last && (
            <span className="sub group-chat-last">
              {c.last.author ? `${c.last.author}: ` : ''}
              {c.last.body}
            </span>
          )}
        </span>
        {status(c) && <span className={`comp-status${c.open ? ' upcoming' : ''}`}>{status(c)}</span>}
      </button>
    </li>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Chat</h2>
        {data.canCreate && (
          <button type="button" className="btn btn-sm" onClick={onNew}>
            ＋ New chat
          </button>
        )}
      </div>
      <p className="sub">
        Chats with the people running {scope === 'org' ? 'this organization and its regions' : 'this region'}: coaches, assistant coaches, team parents and staff, such as all BU10 coaches. You are added automatically when a chat includes your role.
      </p>
      {mine.length === 0 && archived.length === 0 && others.length === 0 && (
        <p className="note">
          No chats here yet.{data.canCreate ? ' Start one with “New chat”.' : ' When one here includes you, it shows on this tab.'}
        </p>
      )}
      {mine.length > 0 && <ul className="comp-list">{mine.map(item)}</ul>}
      {others.length > 0 && (
        <>
          <h3 className="group-title">Other chats you manage</h3>
          <ul className="comp-list">{others.map(item)}</ul>
        </>
      )}
      {archived.length > 0 && (
        <>
          <h3 className="group-title">Archived</h3>
          <ul className="comp-list">{archived.map(item)}</ul>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- new chat */

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function NewChat({
  scope,
  scopeId,
  onCancel,
  onCreated,
}: Scope & { onCancel: () => void; onCreated: (id: string) => void }) {
  const [options, setOptions] = useState<GroupChatOption[] | null>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [customRoleIds, setCustomRoleIds] = useState<string[]>([]);
  const [allTeams, setAllTeams] = useState(true);
  const [divisions, setDivisions] = useState<string[]>([]);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [endsOn, setEndsOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .groupChatOptions(scope, scopeId)
      .then((r) => {
        setOptions(r.options);
        if (r.options[0]) setKey(`${r.options[0].scope}:${r.options[0].id}`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load'));
  }, [scope, scopeId]);

  if (!options) return <section className="card">{error ?? 'Loading…'}</section>;
  const opt = options.find((o) => `${o.scope}:${o.id}` === key) ?? options[0];
  if (!opt) {
    return (
      <section className="card">
        <p className="note">You can’t start a chat here.</p>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Back
        </button>
      </section>
    );
  }
  const singles = opt.teams.filter((t) => !(t.ageGroup && divisions.includes(t.ageGroup)));
  const pickedTeams = !allTeams && (divisions.length > 0 || teamIds.length > 0);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createGroupChat({
        scope: opt.scope,
        id: opt.id,
        name: name.trim(),
        roles,
        divisions: allTeams ? [] : divisions,
        teamIds: allTeams ? [] : teamIds,
        customRoleIds,
        endsOn: endsOn || null,
      });
      onCreated(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the chat');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>New chat</h2>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="comp-form">
        <div className="field-grid">
          {options.length > 1 && (
            <label>
              For
              <select
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setDivisions([]);
                  setTeamIds([]);
                  setCustomRoleIds([]);
                }}
              >
                {options.map((o) => (
                  <option key={`${o.scope}:${o.id}`} value={`${o.scope}:${o.id}`}>
                    {o.label}
                    {o.staff ? '' : ` (as ${o.viaRoles.join(', ')})`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Chat name
            <input value={name} maxLength={60} placeholder="BU10 coaches" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Ends on (optional)
            <input type="date" value={endsOn} min={todayPacific()} onChange={(e) => setEndsOn(e.target.value)} />
          </label>
        </div>
        {endsOn && <p className="sub">After that day the chat becomes read-only and moves to Archived.</p>}

        <h3 className="group-title">Who’s in it</h3>
        <div className="chips" role="group" aria-label="Roles">
          {GROUP_CHAT_ROLES.map((r) => (
            <button key={r.key} type="button" className={`chip${roles.includes(r.key) ? ' on' : ''}`} onClick={() => setRoles((x) => toggle(x, r.key))}>
              {r.key === 'staff' && scope === 'region' ? 'Region staff' : r.label}
            </button>
          ))}
          {opt.customRoles.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`chip${customRoleIds.includes(r.id) ? ' on' : ''}`}
              onClick={() => setCustomRoleIds((x) => toggle(x, r.id))}
            >
              🧩 {r.name}
            </button>
          ))}
        </div>
        <p className="sub">Everyone with these roles on the teams below. People who get the role later are added automatically.</p>

        <h3 className="group-title">Which teams</h3>
        <div className="chips" role="group" aria-label="Which teams">
          <button type="button" className={`chip${allTeams ? ' on' : ''}`} onClick={() => setAllTeams(true)}>
            {opt.staff ? 'All teams' : 'All my teams'}
          </button>
          <button type="button" className={`chip${!allTeams ? ' on' : ''}`} onClick={() => setAllTeams(false)}>
            Choose
          </button>
        </div>
        {!allTeams && (
          <>
            {opt.ageGroups.length > 0 && (
              <div className="chips" role="group" aria-label="Age groups">
                {opt.ageGroups.map((g) => (
                  <button key={g} type="button" className={`chip${divisions.includes(g) ? ' on' : ''}`} onClick={() => setDivisions((x) => toggle(x, g))}>
                    {g}
                  </button>
                ))}
              </div>
            )}
            {singles.length > 0 && (
              <div className="chips" role="group" aria-label="Teams">
                {singles.map((t) => (
                  <button key={t.id} type="button" className={`chip${teamIds.includes(t.id) ? ' on' : ''}`} onClick={() => setTeamIds((x) => toggle(x, t.id))}>
                    {t.name}
                    {t.ageGroup ? ` · ${t.ageGroup}` : ''}
                    {opt.scope === 'org' && t.regionName ? ` · ${t.regionName}` : ''}
                  </button>
                ))}
              </div>
            )}
            <p className="sub">An age group includes its teams added later.</p>
          </>
        )}

        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !name.trim() || (roles.length === 0 && customRoleIds.length === 0) || (!allTeams && !pickedTeams)}
            onClick={() => void create()}
          >
            Start chat
          </button>
          <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ chat */

function ChatView({ id, onBack }: { id: string; onBack: () => void }) {
  const [view, setView] = useState<GroupChatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [polling, setPolling] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [editing, setEditing] = useState<{ name: string; endsOn: string } | null>(null);
  const lastActivity = useRef(Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    try {
      const v = await api.groupChat(id);
      setView(v);
      setError(null);
      if (v.messages.length !== lastCount.current) {
        if (lastCount.current) lastActivity.current = Date.now();
        lastCount.current = v.messages.length;
        window.setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }), 0);
      }
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? 'This chat is not available to you.'
          : e instanceof Error
            ? e.message
            : 'Could not load the chat',
      );
    }
  }, [id]);

  // Refresh while in view: often while busy, slowing down when quiet.
  useEffect(() => {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await load();
      if (!stopped) timer = window.setTimeout(() => void tick(), chatRefreshDelay(Date.now() - lastActivity.current));
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [load]);

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const body = text.trim();
    if (!body && !photos.length) return;
    lastActivity.current = Date.now();
    await act(
      () => api.groupChatAction({ action: 'send', chatId: id, body, images: photos.length ? photos : undefined }),
      () => {
        setText('');
        setPhotos([]);
      },
    );
  }

  /** Photos chosen: shrunk and added, up to the per-send limit. */
  async function pickPhotos(files: File[]) {
    if (!files.length || !view) return;
    setError(null);
    const room = view.photosPerSend - photos.length;
    if (room <= 0) {
      setError(`You can send up to ${view.photosPerSend} photos at a time.`);
      return;
    }
    setPreparing(true);
    try {
      const ready: string[] = [];
      for (const f of files.slice(0, room)) ready.push(await preparePhoto(f));
      setPhotos((prev) => [...prev, ...ready].slice(0, view.photosPerSend));
      if (files.length > room) setError(`You can send up to ${view.photosPerSend} photos at a time, so the first ${room} were added.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that photo.');
    } finally {
      setPreparing(false);
    }
  }

  const back = (
    <button type="button" className="btn ghost btn-sm" onClick={onBack}>
      ← All chats
    </button>
  );
  if (!view) return <section className="card">{error ? <>{error} {back}</> : 'Loading…'}</section>;
  const c = view.chat;

  return (
    <section className="card chat group-chat">
      <div className="card-head">
        <h2>{c.name}</h2>
        {back}
      </div>
      <p className="sub">
        {c.scopeLabel} · {c.audience} ·{' '}
        <button type="button" className="linkish" onClick={() => setShowPeople((s) => !s)}>
          {c.people.length} {c.people.length === 1 ? 'person' : 'people'}
        </button>
        {status(c) ? ` · ${status(c)}` : ''}
      </p>
      {showPeople && <p className="sub group-chat-people">{c.people.map((p) => p.name).join(', ')}</p>}
      {!c.open && (
        <p className="note">
          {c.archivedAt ? 'This chat is archived' : 'This chat has ended'}, so it’s read-only.
          {c.canManage ? ' Reopen it to keep talking.' : ''}
        </p>
      )}
      {!c.member && c.canManage && <p className="note">You manage this chat but aren’t one of its people, so you don’t get its notifications.</p>}
      {error && <p className="error">{error}</p>}

      {c.canManage && !c.isDefault &&
        (editing ? (
          <div className="comp-form">
            <div className="field-grid">
              <label>
                Chat name
                <input value={editing.name} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
              <label>
                Ends on (optional)
                <input type="date" value={editing.endsOn} min={todayPacific()} onChange={(e) => setEditing({ ...editing, endsOn: e.target.value })} />
              </label>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !editing.name.trim()}
                onClick={() =>
                  void act(
                    () => api.groupChatAction({ action: 'edit', chatId: id, name: editing.name.trim(), endsOn: editing.endsOn || null }),
                    () => setEditing(null),
                  )
                }
              >
                Save
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row chat-actions">
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() => setEditing({ name: c.name, endsOn: c.endsOn && c.endsOn >= todayPacific() ? c.endsOn : '' })}
            >
              Edit
            </button>
            {c.archivedAt || !c.open ? (
              <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void act(() => api.groupChatAction({ action: 'archive', chatId: id, archived: false }))}>
                Reopen
              </button>
            ) : (
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (confirm('Archive this chat? It becomes read-only. You can reopen it later.')) {
                    void act(() => api.groupChatAction({ action: 'archive', chatId: id, archived: true }));
                  }
                }}
              >
                Archive
              </button>
            )}
            <button
              type="button"
              className="btn ghost btn-sm danger-text"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete “${c.name}” and all its messages for everyone? This can’t be undone.`)) {
                  void act(() => api.groupChatAction({ action: 'delete', chatId: id }), onBack);
                }
              }}
            >
              Delete
            </button>
          </div>
        ))}

      <div className="chat-list" ref={listRef}>
        {view.messages.length === 0 && <p className="note">No messages yet. Say hello 👋</p>}
        {view.messages.map((m) =>
          m.kind === 'system' ? (
            <div key={m.id} className="chat-system">
              {m.body} · {when(m.createdAt)}
            </div>
          ) : (
            <div key={m.id} className={`chat-msg${m.mine ? ' mine' : ''}`}>
              <div className="chat-meta">
                <strong>{m.mine ? 'You' : m.author}</strong>
                <span className="sub"> · {when(m.createdAt)}</span>
              </div>
              {m.kind === 'poll' && m.poll ? (
                <PollCard
                  question={m.body}
                  poll={m.poll}
                  busy={busy || !c.canPost}
                  onVote={(choices) => void act(() => api.groupChatAction({ action: 'vote', messageId: m.id, choices }))}
                  onClose={() => void act(() => api.groupChatAction({ action: 'closePoll', messageId: m.id }))}
                />
              ) : (
                <>
                  {m.image && (
                    <a className="chat-photo-link" href={m.image.url} target="_blank" rel="noopener noreferrer">
                      <img className="chat-photo" src={m.image.url} alt={`Photo from ${m.author}`} loading="lazy" />
                    </a>
                  )}
                  {m.body && (
                    <div className="chat-body">
                      <Linked text={m.body} />
                    </div>
                  )}
                </>
              )}
              <div className="chat-actions">
                {m.reactions.map((r) => (
                  <button
                    key={r.emoji}
                    type="button"
                    className={`chat-react${r.mine ? ' mine' : ''}`}
                    disabled={busy || !c.canPost}
                    onClick={() => void act(() => api.groupChatAction({ action: 'react', messageId: m.id, emoji: r.emoji }))}
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
                {c.canPost && (
                  <button type="button" className="linkish" onClick={() => setPicker(picker === m.id ? null : m.id)}>
                    React
                  </button>
                )}
                {m.canDelete && (
                  <button
                    type="button"
                    className="linkish danger-text"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Delete this ${m.kind === 'poll' ? 'poll' : 'message'} for everyone?`)) {
                        void act(() => api.groupChatAction({ action: 'deleteMessage', messageId: m.id }));
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
              {picker === m.id && (
                <div className="chat-picker">
                  {view.reactions.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="chat-react"
                      disabled={busy}
                      onClick={() => {
                        setPicker(null);
                        void act(() => api.groupChatAction({ action: 'react', messageId: m.id, emoji: e }));
                      }}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      {c.canPost && polling && (
        <PollComposer
          max={view.pollMaxOptions}
          busy={busy}
          onCancel={() => setPolling(false)}
          onCreate={async (p) => {
            lastActivity.current = Date.now();
            await act(() => api.groupChatAction({ action: 'poll', chatId: id, ...p }), () => setPolling(false));
          }}
        />
      )}

      {c.canPost && !polling && (
        <>
          {photos.length > 0 && (
            <div className="chat-photo-previews">
              {photos.map((src, i) => (
                <div key={i} className="chat-photo-preview">
                  <img src={src} alt={`Photo ${i + 1} to send`} />
                  <button
                    type="button"
                    className="chip-x"
                    aria-label="Remove this photo"
                    onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {preparing && <p className="note">Preparing photos…</p>}
          <div className="chat-compose">
            <textarea
              value={text}
              maxLength={view.maxLength}
              rows={2}
              placeholder={photos.length ? 'Add a caption (optional)' : 'Write a message'}
              onChange={(e) => {
                setText(e.target.value);
                lastActivity.current = Date.now();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="button" className="btn" disabled={busy || preparing || (!text.trim() && !photos.length)} onClick={() => void send()}>
              Send
            </button>
          </div>
          <div className="chat-tools">
            {c.canPhoto ? (
              <>
                <button type="button" className="btn ghost btn-sm fp-btn" onClick={() => fileRef.current?.click()}>
                  <ImageIcon /> Photos
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void pickPhotos(files);
                  }}
                />
              </>
            ) : (
              <PaidLock feature="chatAttachments" what="Send photos" />
            )}
            {c.canPoll ? (
              <button type="button" className="btn ghost btn-sm" onClick={() => setPolling(true)}>
                Poll
              </button>
            ) : (
              <PaidLock feature="chatPolls" what="Create a poll" />
            )}
          </div>
        </>
      )}
    </section>
  );
}
