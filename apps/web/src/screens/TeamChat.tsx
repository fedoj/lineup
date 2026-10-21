import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyPollVote,
  CHAT_IMAGE_MAX_BYTES,
  CHAT_IMAGE_MAX_SIDE,
  CHAT_PHOTOS_PER_SEND,
  chatRefreshDelay,
} from '@lineup/shared';
import { api, apiPath, peek, type ChatMessage, type TeamChat as Chat } from '../lib/api';
import { readAsDataUrl, shrinkPhoto } from '../lib/image';
import { PaidLock } from '../lib/features';
import { CameraIcon, ImageIcon, prefersCamera, useFileDrop } from '../components/FilePick';

/**
 * A photo ready to send: a JPEG at most CHAT_IMAGE_MAX_SIDE on its longest
 * side and under CHAT_IMAGE_MAX_BYTES, so a phone camera's 5 MB picture goes
 * as about 100-250 KB. A small GIF goes as it is, so it keeps moving.
 */
async function preparePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a photo.');
  if (file.type === 'image/gif' && file.size <= CHAT_IMAGE_MAX_BYTES) return readAsDataUrl(file);
  return shrinkPhoto(file, { maxSide: CHAT_IMAGE_MAX_SIDE, maxBytes: CHAT_IMAGE_MAX_BYTES });
}

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Team chat: Everyone, Staff and Coaches, each shown only to the people who
 * belong to it. Organization and region staff drop in and out; everyone in
 * the chat sees them join and leave.
 */
export default function TeamChat({ teamId, initialChannel }: { teamId: string; initialChannel?: string }) {
  const [channel, setChannel] = useState<string | undefined>(initialChannel);
  const [chat, setChat] = useState<Chat | null>(() => peek<Chat>(apiPath.chat(teamId, initialChannel)) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  // The chat opens full screen so there is room to read; the choice is remembered.
  const [full, setFull] = useState(() => {
    try {
      return localStorage.getItem('lineup.chatFull') !== '0';
    } catch {
      return true;
    }
  });
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const lastCount = useRef(0);
  const votesPending = useRef(0);
  const voteChain = useRef<Promise<unknown>>(Promise.resolve());
  // When anything last happened in this chat; it sets how often it refreshes.
  const lastActivity = useRef(Date.now());
  const chatRef = useRef<Chat | null>(chat);
  chatRef.current = chat;
  const touch = useMemo(prefersCamera, []);
  // On a computer, photos dragged onto the chat are ready to send, like choosing them.
  const { dragging, dropProps } = useFileDrop((f) => void pickPhotos([f]), {
    accept: 'image/*',
    disabled: !chat?.canPhoto || !chat.canRead || polling || Boolean(editing),
    onReject: () => setError('Only photos can be sent in the chat.'),
    onFiles: (files) => void pickPhotos(files),
  });

  const load = useCallback(async () => {
    try {
      const c = await api.chat(teamId, channel);
      // An unchanged chat comes back as the very same object (304).
      if (c !== chatRef.current) lastActivity.current = Date.now();
      // A vote still being saved keeps showing until the server has it.
      if (votesPending.current === 0) setChat(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the chat.');
    }
  }, [teamId, channel]);

  useEffect(() => {
    // Messages seen earlier in this visit show at once while they refresh.
    setChat(peek<Chat>(apiPath.chat(teamId, channel)) ?? null);
    lastCount.current = 0;
    lastActivity.current = Date.now();
    // Refresh while the page is in view: every 3 s while the chat is busy,
    // slowing to every 30 s when it is quiet (chatRefreshDelay). A hidden tab
    // stops asking and catches up the moment it is shown again.
    let timer: number | undefined;
    let run = 0;
    const tick = async (id: number) => {
      if (!document.hidden) await load();
      if (id !== run) return;
      timer = window.setTimeout(() => void tick(id), chatRefreshDelay(Date.now() - lastActivity.current));
    };
    const restart = () => {
      window.clearTimeout(timer);
      run += 1;
      void tick(run);
    };
    restart();
    const onVisible = () => {
      if (document.hidden) return;
      lastActivity.current = Date.now();
      restart();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      run += 1;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, teamId, channel]);

  // Keep the newest message in view when new ones arrive.
  useEffect(() => {
    const n = chat?.messages.length ?? 0;
    if (n !== lastCount.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    lastCount.current = n;
  }, [chat]);

  // Full screen: the page behind stops scrolling, Escape leaves, and the
  // newest message stays in view after the resize.
  useEffect(() => {
    try {
      localStorage.setItem('lineup.chatFull', full ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    if (!full) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener('keydown', onKey);
    };
  }, [full]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    lastActivity.current = Date.now();
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * A poll answer shows the moment it is tapped; it is saved behind the
   * scenes (one vote at a time, in order) and the chat refreshes after.
   */
  async function vote(messageId: string, choices: number[]) {
    setError(null);
    lastActivity.current = Date.now();
    setChat((c) =>
      c && {
        ...c,
        messages: c.messages.map((x) => (x.id === messageId && x.poll ? { ...x, poll: applyPollVote(x.poll, choices) } : x)),
      },
    );
    votesPending.current += 1;
    const saving = voteChain.current.then(() => api.chatAction({ action: 'vote', messageId, choices }));
    voteChain.current = saving.catch(() => undefined);
    try {
      await saving;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your vote was not saved.');
    }
    votesPending.current -= 1;
    if (votesPending.current === 0) void load();
  }

  if (!chat) {
    return <section className={error ? 'card err' : 'card'}>{error ?? 'Loading chat…'}</section>;
  }

  const ch = chat.channel;

  async function submit() {
    const body = text.trim();
    const sending = editing ? [] : photos;
    if (!body && !sending.length) return;
    await act(async () => {
      if (editing) {
        await api.chatAction({ action: 'edit', messageId: editing.id, body });
      } else {
        await api.chatAction({
          action: 'send',
          teamId,
          channel: ch,
          body,
          replyTo: replyTo?.id,
          images: sending.length ? sending : undefined,
        });
      }
      setText('');
      setPhotos([]);
      setReplyTo(null);
      setEditing(null);
    });
  }

  /** Photos chosen or dropped: shrunk and added, up to CHAT_PHOTOS_PER_SEND at a time. */
  async function pickPhotos(files: File[]) {
    if (!files.length) return;
    setError(null);
    const room = CHAT_PHOTOS_PER_SEND - photos.length;
    if (room <= 0) {
      setError(`You can send up to ${CHAT_PHOTOS_PER_SEND} photos at a time.`);
      return;
    }
    setPreparing(true);
    try {
      const ready: string[] = [];
      for (const f of files.slice(0, room)) ready.push(await preparePhoto(f));
      setPhotos((prev) => [...prev, ...ready].slice(0, CHAT_PHOTOS_PER_SEND));
      if (files.length > room) {
        setError(`You can send up to ${CHAT_PHOTOS_PER_SEND} photos at a time, so the first ${room} were added.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that photo.');
    } finally {
      setPreparing(false);
    }
  }

  return (
    <section className={`card chat${full ? ' chat-full' : ''}${dragging ? ' drop-over' : ''}`} {...dropProps}>
      {dragging && (
        <div className="chat-drop-hint" aria-hidden="true">
          <ImageIcon /> Drop photos to add them to your message (up to {CHAT_PHOTOS_PER_SEND})
        </div>
      )}
      <div className="card-head">
        <h2>Team chat</h2>
        <div className="row">
          {chat.dropIn && chat.present && (
            <button
              type="button"
              className="btn ghost btn-sm"
              disabled={busy}
              onClick={() => act(() => api.chatAction({ action: 'leave', teamId, channel: ch }))}
            >
              Leave chat
            </button>
          )}
          <button
            type="button"
            className="btn ghost btn-sm"
            aria-pressed={full}
            title={full ? 'Back to the app (Esc)' : 'Fill the screen with the chat'}
            onClick={() => setFull((v) => !v)}
          >
            {full ? '✕ Close full screen' : '⤢ Full screen'}
          </button>
        </div>
      </div>

      {chat.channels.length > 1 && (
        <div className="seg chat-tabs" role="tablist" aria-label="Chats">
          {chat.channels.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === ch}
              className={c.id === ch ? 'on' : ''}
              onClick={() => {
                setChannel(c.id);
                setReplyTo(null);
                setEditing(null);
                setPolling(false);
                setText('');
              }}
            >
              {c.label}
              {c.access === 'dropin' && !c.present ? ' ·' : ''}
            </button>
          ))}
        </div>
      )}

      {error && <p className="danger-text">{error}</p>}

      {chat.visitors.length > 0 && (
        <p className="note">In the chat now: {chat.visitors.map((v) => `${v.name} (${v.role})`).join(', ')}</p>
      )}

      {!chat.canRead ? (
        <div className="chat-dropin">
          <p className="note">
            You can drop in to this chat as organization or region staff. Everyone in it will see that you
            joined, and that you left.
          </p>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => act(() => api.chatAction({ action: 'enter', teamId, channel: ch }))}
          >
            Enter chat
          </button>
        </div>
      ) : (
        <>
          <div className="chat-list" ref={listRef}>
            {chat.messages.length === 0 && <p className="note">No messages yet. Be the first to say hello 👋</p>}
            {chat.messages.map((m) =>
              m.kind === 'system' ? (
                <div key={m.id} className="chat-system">
                  {m.body} · {when(m.createdAt)}
                </div>
              ) : (
                <div key={m.id} className={`chat-msg${m.mine ? ' mine' : ''}`}>
                  <div className="chat-meta">
                    <strong>{m.mine ? 'You' : m.author}</strong>
                    {m.child && <span className="chat-child"> – {m.child}</span>}
                    {m.role && <span className="sub"> · {m.role}</span>}
                    <span className="sub"> · {when(m.createdAt)}</span>
                    {m.editedAt && <span className="sub"> · edited</span>}
                  </div>
                  {m.replyTo && (
                    <div className="chat-quote">
                      ↩ {m.replyTo.author}: {m.replyTo.body}
                    </div>
                  )}
                  {m.kind === 'poll' && m.poll ? (
                    <PollCard m={m} busy={busy} act={act} onVote={(choices) => void vote(m.id, choices)} />
                  ) : (
                    <>
                      {m.image && (
                        <a className="chat-photo-link" href={m.image.url} target="_blank" rel="noopener noreferrer">
                          <img className="chat-photo" src={m.image.url} alt={`Photo from ${m.author}`} loading="lazy" />
                        </a>
                      )}
                      {m.body && <div className="chat-body">{m.body}</div>}
                    </>
                  )}
                  <div className="chat-actions">
                    {m.reactions.map((r) => (
                      <button
                        key={r.emoji}
                        type="button"
                        className={`chat-react${r.mine ? ' mine' : ''}`}
                        disabled={busy}
                        onClick={() => act(() => api.chatAction({ action: 'react', messageId: m.id, emoji: r.emoji }))}
                      >
                        {r.emoji} {r.count}
                      </button>
                    ))}
                    <button type="button" className="linkish" onClick={() => setPicker(picker === m.id ? null : m.id)}>
                      React
                    </button>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setReplyTo(m);
                        setEditing(null);
                      }}
                    >
                      Reply
                    </button>
                    {m.canEdit && (
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          setEditing(m);
                          setReplyTo(null);
                          setText(m.body);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {m.canDelete && (
                      <button
                        type="button"
                        className="linkish danger-text"
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(`Delete this ${m.kind === 'poll' ? 'poll' : 'message'} for everyone?`)) {
                            void act(() => api.chatAction({ action: 'delete', messageId: m.id }));
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                    {m.canRemove && (
                      <button
                        type="button"
                        className="linkish danger-text"
                        disabled={busy}
                        onClick={() => {
                          const what = m.kind === 'poll' ? 'poll' : 'message';
                          if (window.confirm(`Remove this ${what} from ${m.author} for everyone? It will simply disappear.`)) {
                            void act(() => api.chatAction({ action: 'delete', messageId: m.id }));
                          }
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {picker === m.id && (
                    <div className="chat-picker">
                      {chat.reactions.map((e) => (
                        <button
                          key={e}
                          type="button"
                          className="chat-react"
                          disabled={busy}
                          onClick={() => {
                            setPicker(null);
                            void act(() => api.chatAction({ action: 'react', messageId: m.id, emoji: e }));
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

          {(replyTo || editing) && (
            <div className="chat-context">
              <span>
                {editing
                  ? 'Editing your message'
                  : `Replying to ${replyTo!.author}: ${replyTo!.body.slice(0, 80) || (replyTo!.image ? '📷 Photo' : '')}`}
              </span>
              <button
                type="button"
                className="chip-x"
                title="Cancel"
                onClick={() => {
                  setReplyTo(null);
                  if (editing) setText('');
                  setEditing(null);
                }}
              >
                ✕
              </button>
            </div>
          )}
          {polling && chat.canPoll ? (
            <PollComposer
              max={chat.pollMaxOptions ?? 6}
              busy={busy}
              onCancel={() => setPolling(false)}
              onCreate={(p) =>
                act(async () => {
                  await api.chatAction({ action: 'poll', teamId, channel: ch, ...p });
                  setPolling(false);
                })
              }
            />
          ) : (
            <>
              {photos.length > 0 && !editing && (
                <div className="chat-photo-previews">
                  {photos.map((p, i) => (
                    <div className="chat-photo-preview" key={i}>
                      <img src={p} alt={`Photo ${i + 1} to send`} />
                      <button
                        type="button"
                        className="chip-x"
                        title="Remove this photo"
                        onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <span className="note">
                    {photos.length}/{CHAT_PHOTOS_PER_SEND} photos
                  </span>
                </div>
              )}
              {preparing && <p className="note">Preparing photos…</p>}
              <div className="chat-compose">
                <textarea
                  value={text}
                  maxLength={chat.maxLength}
                  rows={2}
                  placeholder={photos.length && !editing ? 'Add a caption (optional)' : 'Write a message'}
                  onChange={(e) => {
                    setText(e.target.value);
                    lastActivity.current = Date.now();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={busy || preparing || (!text.trim() && !(photos.length && !editing))}
                  onClick={() => void submit()}
                >
                  {editing ? 'Save' : 'Send'}
                </button>
              </div>
            </>
          )}
          {!polling && !editing && (
            <div className="chat-tools">
              {chat.canPhoto ? (
                <>
                  {touch && (
                    <button type="button" className="btn ghost btn-sm fp-btn" onClick={() => cameraRef.current?.click()}>
                      <CameraIcon /> Take photo
                    </button>
                  )}
                  <button type="button" className="btn ghost btn-sm fp-btn" onClick={() => fileRef.current?.click()}>
                    <ImageIcon /> {touch ? 'Upload photos' : 'Photos'}
                  </button>
                  {!touch && <span className="fp-hint">or drag up to {CHAT_PHOTOS_PER_SEND} into the chat</span>}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      void pickPhotos(Array.from(e.target.files ?? []));
                      e.target.value = '';
                    }}
                  />
                  {touch && (
                    <input
                      ref={cameraRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      hidden
                      onChange={(e) => {
                        void pickPhotos(Array.from(e.target.files ?? []));
                        e.target.value = '';
                      }}
                    />
                  )}
                </>
              ) : (
                <PaidLock feature="chatAttachments" what="Send photos" />
              )}
              {chat.canPoll ? (
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={() => {
                    setPolling(true);
                    setReplyTo(null);
                  }}
                >
                  📊 Poll
                </button>
              ) : (
                <PaidLock feature="chatPolls" what="Create a poll" />
              )}
            </div>
          )}
          <p className="note">
            Only people in this chat see these messages. Messages are deleted after {Math.round(chat.retentionDays / 30)}{' '}
            months.{' '}
            {chat.paid
              ? `You can edit a message for ${chat.editMinutes} minutes, and delete it until someone reacts or replies.`
              : 'Editing and deleting your messages is part of a paid plan.'}{' '}
            {chat.canPoll
              ? 'Anyone in the chat can vote in your polls.'
              : 'Anyone can vote in a poll; creating one is part of a paid plan.'}{' '}
            {chat.canPhoto ? 'Everyone in the chat sees the photos you send.' : 'Everyone sees photos; sending them is part of a paid plan.'}
          </p>
        </>
      )}
    </section>
  );
}

/** A poll in the chat: tap an answer to vote; tap it again to take it back. */
function PollCard({
  m,
  busy,
  act,
  onVote,
}: {
  m: ChatMessage;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onVote: (choices: number[]) => void;
}) {
  const [showVoters, setShowVoters] = useState(false);
  const poll = m.poll!;
  const most = Math.max(1, ...poll.options.map((o) => o.votes));
  const mineNow = poll.options.map((o, i) => (o.mine ? i : -1)).filter((i) => i >= 0);

  function vote(i: number) {
    const choices = poll.multi
      ? mineNow.includes(i)
        ? mineNow.filter((x) => x !== i)
        : [...mineNow, i].sort((a, b) => a - b)
      : mineNow.includes(i)
        ? []
        : [i];
    onVote(choices);
  }

  return (
    <div className="chat-poll">
      <div className="chat-poll-q">
        <span aria-hidden="true">📊</span> {m.body}
      </div>
      <div className="sub">
        {poll.closed ? 'Poll closed' : poll.multi ? 'Pick one or more' : 'Pick one'} · {poll.voters}{' '}
        {poll.voters === 1 ? 'person' : 'people'} voted
      </div>
      <ul className="chat-poll-options">
        {poll.options.map((o, i) => (
          <li key={i}>
            <button
              type="button"
              className={`chat-poll-option${o.mine ? ' mine' : ''}`}
              disabled={poll.closed}
              aria-pressed={o.mine}
              onClick={() => vote(i)}
            >
              <span className="chat-poll-bar" style={{ width: `${Math.round((o.votes / most) * 100)}%` }} />
              <span className="chat-poll-text">
                {o.mine ? '✅ ' : ''}
                {o.text}
              </span>
              <span className="chat-poll-count">{o.votes}</span>
            </button>
            {showVoters && o.voters.length > 0 && <div className="sub chat-poll-voters">{o.voters.join(', ')}</div>}
          </li>
        ))}
      </ul>
      <div className="chat-actions">
        {poll.voters > 0 && (
          <button type="button" className="linkish" onClick={() => setShowVoters((v) => !v)}>
            {showVoters ? 'Hide who voted' : 'Who voted'}
          </button>
        )}
        {poll.canClose && (
          <button
            type="button"
            className="linkish"
            disabled={busy}
            onClick={() => {
              if (window.confirm('Close this poll? Nobody will be able to vote after that.')) {
                void act(() => api.chatAction({ action: 'closePoll', messageId: m.id }));
              }
            }}
          >
            Close poll
          </button>
        )}
      </div>
    </div>
  );
}

/** Write a poll: a question, 2 to 6 answers, and one or several picks. */
function PollComposer({
  max,
  busy,
  onCreate,
  onCancel,
}: {
  max: number;
  busy: boolean;
  onCreate: (p: { question: string; options: string[]; multi: boolean }) => Promise<void>;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ready = question.trim() && filled.length >= 2;

  return (
    <div className="chat-poll-form">
      <label>
        Question
        <input
          value={question}
          maxLength={200}
          placeholder="e.g. Who can drive to Saturday's game?"
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      {options.map((o, i) => (
        <div className="row" key={i}>
          <input
            style={{ flex: '1 1 200px' }}
            value={o}
            maxLength={80}
            placeholder={`Answer ${i + 1}`}
            aria-label={`Answer ${i + 1}`}
            onChange={(e) => setOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
          />
          {options.length > 2 && (
            <button
              type="button"
              className="chip-x"
              title="Remove this answer"
              onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {options.length < max && (
        <button type="button" className="linkish" onClick={() => setOptions((prev) => [...prev, ''])}>
          + Add an answer
        </button>
      )}
      <label className="check">
        <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> People can pick more
        than one answer
      </label>
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={busy || !ready}
          onClick={() => void onCreate({ question: question.trim(), options: filled, multi })}
        >
          Post poll
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
