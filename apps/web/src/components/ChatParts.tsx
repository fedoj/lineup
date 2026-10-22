import { useState } from 'react';
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_SIDE } from '@lineup/shared';
import type { ChatMessage } from '../lib/api';
import { readAsDataUrl, shrinkPhoto } from '../lib/image';

/**
 * Pieces shared by team chat and the organization and region chats (Shadi,
 * 10/22): getting a photo ready to send, a poll, and writing one.
 */

/**
 * A photo ready to send: a JPEG at most CHAT_IMAGE_MAX_SIDE on its longest
 * side and under CHAT_IMAGE_MAX_BYTES, so a phone camera's 5 MB picture goes
 * as about 100-250 KB. A small GIF goes as it is, so it keeps moving.
 */
export async function preparePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a photo.');
  if (file.type === 'image/gif' && file.size <= CHAT_IMAGE_MAX_BYTES) return readAsDataUrl(file);
  return shrinkPhoto(file, { maxSide: CHAT_IMAGE_MAX_SIDE, maxBytes: CHAT_IMAGE_MAX_BYTES });
}

export type ChatPollView = NonNullable<ChatMessage['poll']>;

/** A poll in a chat: tap an answer to vote; tap it again to take it back. */
export function PollCard({
  question,
  poll,
  busy,
  onVote,
  onClose,
}: {
  question: string;
  poll: ChatPollView;
  busy: boolean;
  onVote: (choices: number[]) => void;
  onClose: () => void;
}) {
  const [showVoters, setShowVoters] = useState(false);
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
        <span aria-hidden="true">📊</span> {question}
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
              if (window.confirm('Close this poll? Nobody will be able to vote after that.')) onClose();
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
export function PollComposer({
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
