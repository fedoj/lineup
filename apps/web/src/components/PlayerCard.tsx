import { useId, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  AVATAR_LABELS,
  AVATAR_OPTIONS,
  CARD_STATS,
  COUNTRY_CODES,
  DEFAULT_AVATAR,
  defaultAvatarFor,
  GIRL_ONLY_PARTS,
  hairChoices,
  flagEmoji,
  HOME_COUNTRY,
  type Avatar,
  type AvatarPart,
} from '@lineup/shared';
import { api, type PlayerEvaluation } from '../lib/api';
import { renderPlayerCardImage } from '../lib/exportImages';
import { canvasBlob, fileSlug, shareFile } from '../lib/shareFile';
import { PaidLock, useFeature } from '../lib/features';
import { FigureArt, PlayerFace, PlayerFigure, SHIRT_HEX } from './PlayerAvatar';
import { loadLorelei } from '../lib/lorelei';

/** A country's name in the reader's language: "EG" -> "Egypt". */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Every country but the US, by name, for "Family's home country". */
function countryOptions(): Array<[string, string]> {
  return COUNTRY_CODES.filter((c) => c !== HOME_COUNTRY)
    .map((c) => [c, countryName(c)] as [string, string])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

/** Words for each choice, shown on the buttons. */
const CHOICE_LABEL: Record<string, string> = {
  s1: 'Light', s2: 'Fair', s3: 'Medium', s4: 'Tan', s5: 'Brown', s6: 'Dark',
  oval: 'Oval', round: 'Round', square: 'Square', heart: 'Heart',
  short: 'Short', buzz: 'Buzz cut', curly: 'Curly', long: 'Long', ponytail: 'Ponytail', afro: 'Afro', spiky: 'Spiky', bald: 'Bald',
  black: 'Black', brown: 'Brown', blonde: 'Blonde', red: 'Red', auburn: 'Auburn', gray: 'Gray', blue: 'Blue', pink: 'Pink',
  almond: 'Almond', smile: 'Smiling', green: 'Green', hazel: 'Hazel',
  none: 'None', sport: 'Sport',
  glitter: 'Glitter ✨', natural: 'Natural', rosy: 'Rosy',
  white: 'White', orange: 'Orange', yellow: 'Yellow', teal: 'Teal', sky: 'Sky blue', navy: 'Navy', purple: 'Purple',
};

/** Card colours by tier: the metal, its rim and the lettering. */
const FC_TIERS: Record<string, { a: string; b: string; c: string; d: string; rim: string; ink: string; ray: string }> = {
  gold: { a: '#fbeab0', b: '#ecca62', c: '#cf9e26', d: '#a97a12', rim: '#f8dc84', ink: '#3a2a06', ray: '#fff6d2' },
  silver: { a: '#f8fafc', b: '#d9dfe6', c: '#adb7c2', d: '#8a95a1', rim: '#eef1f4', ink: '#1e2731', ray: '#ffffff' },
  bronze: { a: '#f6d6b8', b: '#dfa97c', c: '#b9794a', d: '#8e5a31', rim: '#efc29a', ink: '#2e1806', ray: '#ffe9d6' },
};

/** The FC-style card outline: notched top corners, pointed bottom (300 x 420). */
const FC_OUTLINE =
  'M10 44 C30 40 40 30 42 12 Q150 0 258 12 C260 30 270 40 290 44 L290 330 Q290 360 260 372 L165 410 Q150 416 135 410 L40 372 Q10 360 10 330 Z';

const FC_FONT = "'Oswald','Arial Narrow','Roboto Condensed','HelveticaNeue-CondensedBold','sans-serif-condensed',Impact,sans-serif";

/** Where the flags and region badge sit on the card, as a fraction of its height. */
export const CARD_BADGE_ROW = 378 / 420;

/**
 * The player card drawn as one picture (Fady, 10/19: like the EA FC cards):
 * a gold, silver or bronze card with a sunburst behind the player, who fills
 * most of it holding a ball; the overall and position top left; the player ID
 * in a small purple tag under the player; the name; the six stats in a row;
 * a faint LINEUP watermark. The flags and the region's badge go on top
 * (PlayerCard on screen, the share picture on its canvas), because pictures
 * drawn from SVG cannot show emoji flags or load logos.
 */
export function PlayerCardArt({ ev }: { ev: PlayerEvaluation }) {
  const card = ev.card;
  const rating = card?.rating ?? null;
  const t = FC_TIERS[card?.tier ?? 'bronze'] ?? FC_TIERS.bronze;
  const raw = useId();
  const id = `fc${raw.replace(/[^a-zA-Z0-9]/g, '')}`;
  const name = (ev.playerName ?? 'Player').toUpperCase();
  const label = ev.number ? `${name}  #${ev.number}` : name;
  const long = label.length > 13;
  const rays = Array.from({ length: 28 }, (_, i) => {
    const a0 = (i * 2 * Math.PI) / 28;
    const a1 = a0 + Math.PI / 28;
    const r = 420;
    return `M160 150 L${(160 + r * Math.cos(a0)).toFixed(1)} ${(150 + r * Math.sin(a0)).toFixed(1)} L${(160 + r * Math.cos(a1)).toFixed(1)} ${(150 + r * Math.sin(a1)).toFixed(1)} Z`;
  });
  // Just the code, no "ID" in front (Fady, 10/20).
  const idLabel = ev.publicId ?? null;
  const idWidth = idLabel ? Math.max(70, idLabel.length * 6.6 + 18) : 0;
  return (
    <svg className="fc-art" viewBox="0 0 300 420" width="300" height="420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={`${ev.playerName ?? 'Player'} card`}>
      <defs>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={t.a} />
          <stop offset="38%" stopColor={t.b} />
          <stop offset="70%" stopColor={t.c} />
          <stop offset="100%" stopColor={t.d} />
        </linearGradient>
        <radialGradient id={`${id}-gloss`} cx="62%" cy="30%" r="60%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={t.b} stopOpacity="0" />
          <stop offset="35%" stopColor={t.b} stopOpacity="0.85" />
          <stop offset="100%" stopColor={t.c} stopOpacity="0.95" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d={FC_OUTLINE} />
        </clipPath>
      </defs>

      {/* The metal, the sunburst and the swoosh behind the player. */}
      <path d={FC_OUTLINE} fill={`url(#${id}-metal)`} />
      <g clipPath={`url(#${id}-clip)`}>
        <g fill={t.ray} opacity="0.16">
          {rays.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        <g fill="none" stroke={t.ray} strokeWidth="1.2" opacity="0.45">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <path key={i} d={`M${-20 + i * 6} ${330 - i * 4} C ${70 + i * 8} ${250 - i * 10}, ${150 + i * 6} ${40 + i * 8}, ${320} ${30 + i * 14}`} />
          ))}
        </g>
        <rect x="0" y="0" width="300" height="420" fill={`url(#${id}-gloss)`} />
        <text x="150" y="220" textAnchor="middle" dominantBaseline="middle" fontFamily={FC_FONT} fontWeight="900" fontSize="74" fill={t.ink} opacity="0.07" transform="rotate(-28 150 220)" letterSpacing="4">
          LINEUP
        </text>
        {/* The player, big, from the waist up. */}
        <g transform="translate(60 14)">
          <FigureArt a={ev.avatar ?? defaultAvatarFor(ev.gender)} id={`${id}fig`} fade logo={ev.regionLogo ?? null} gender={ev.gender ?? null} />
        </g>
        {/* The lower band the name and stats sit on. */}
        <rect x="0" y="262" width="300" height="160" fill={`url(#${id}-band)`} />
      </g>
      <path d={FC_OUTLINE} fill="none" stroke={t.rim} strokeWidth="5" />
      <path d={FC_OUTLINE} fill="none" stroke={t.ink} strokeOpacity="0.28" strokeWidth="1" transform="translate(150 210) scale(0.955) translate(-150 -210)" />

      {/* Overall and position, top left. */}
      <g fontFamily={FC_FONT} fill={t.ink} textAnchor="middle">
        <text x="56" y="88" fontSize="54" fontWeight="800">
          {rating ?? '–'}
        </text>
        <text x="56" y="116" fontSize="24" fontWeight="700">
          {ev.position ?? ''}
        </text>
      </g>

      {/* The player ID: a small purple tag under the player. */}
      {idLabel && (
        <g>
          <rect x={160 - idWidth / 2} y="262" width={idWidth} height="17" rx="8.5" fill="#6d28d9" stroke="#ffffff" strokeWidth="1.5" />
          <text x="160" y="274.5" textAnchor="middle" fontFamily={FC_FONT} fontWeight="700" fontSize="10.5" fill="#ffffff" letterSpacing="0.6">
            {idLabel}
          </text>
        </g>
      )}

      {/* Name and the six stats. */}
      <g fontFamily={FC_FONT} fill={t.ink} textAnchor="middle">
        <text x="150" y="307" fontSize="29" fontWeight="800" {...(long ? { textLength: 238, lengthAdjust: 'spacingAndGlyphs' } : {})}>
          {label}
        </text>
        {CARD_STATS.map(([sid], i) => (
          <g key={sid}>
            <text x={45 + i * 42} y="331" fontSize="14.5" fontWeight="700">
              {sid}
            </text>
            <text x={45 + i * 42} y="356" fontSize="24" fontWeight="800">
              {card?.stats[sid] ?? '–'}
            </text>
          </g>
        ))}
        <text x="150" y="401" fontSize="8.5" fontWeight="700" letterSpacing="2" opacity="0.6">
          LINEUP
        </text>
      </g>
    </svg>
  );
}

/**
 * The player card on screen: the drawing, with the flags (the US and the
 * family's home country) and the region's badge along the bottom.
 */
export function PlayerCard({ ev }: { ev: PlayerEvaluation }) {
  const flags = [ev.country ?? HOME_COUNTRY, ev.heritage].filter(Boolean) as string[];
  return (
    <div className={`fc-card ${ev.card?.tier ?? 'bronze'}`} title={ev.card?.rating == null ? 'Not rated yet' : undefined}>
      <PlayerCardArt ev={ev} />
      <div className="fc-badges" style={{ top: `${CARD_BADGE_ROW * 100}%` }}>
        {flags.map((c) => (
          <span key={c} className="fc-flag" title={countryName(c)} role="img" aria-label={countryName(c)}>
            {flagEmoji(c)}
          </span>
        ))}
        {ev.regionLogo && <img className="fc-badge" src={ev.regionLogo} alt={ev.regionName ?? 'Region'} title={ev.regionName ?? undefined} />}
      </div>
    </div>
  );
}

/**
 * The card's drawing on its own, built from the player's data rather than
 * copied from the screen, so the shared picture always has the player in it.
 */
function cardSvgElement(ev: PlayerEvaluation): SVGSVGElement | null {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<PlayerCardArt ev={ev} />));
    const svg = host.querySelector('svg');
    return svg ? (svg.cloneNode(true) as SVGSVGElement) : null;
  } finally {
    root.unmount();
  }
}

/** The card as a picture, the same as on screen, with the site under it. */
export async function makeCardPicture(ev: PlayerEvaluation): Promise<HTMLCanvasElement> {
  // The face art must be loaded before the card is drawn off screen.
  await loadLorelei();
  // A picture drawn from an SVG cannot fetch images, so the shirt's region logo goes in inline.
  const logo = ev.regionLogo ? await inlineImage(ev.regionLogo) : null;
  return renderPlayerCardImage({ ev, cardSvg: cardSvgElement({ ...ev, regionLogo: logo }), badgeRow: CARD_BADGE_ROW, countryName });
}

async function inlineImage(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise<string>((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => no(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Share or save the card as a picture (Fady, 10/19), with the site on it.
 * Made on the phone and never kept.
 */
export function ShareCardButton({ ev }: { ev: PlayerEvaluation }) {
  // Sharing the card, like designing the avatar, is premium (Fady, 10/19).
  const allowed = useFeature('playerEvaluation');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!allowed) return <PaidLock feature="playerEvaluation" what="Sharing the player card" />;
  async function share() {
    setBusy(true);
    setMsg(null);
    try {
      const canvas = await makeCardPicture(ev);
      const outcome = await shareFile(await canvasBlob(canvas), `${fileSlug(ev.playerName ?? 'player')}-card.png`, `${ev.playerName ?? 'Player'} · Lineup card`);
      if (outcome === 'downloaded') setMsg('Saved to your downloads.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not make the picture');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void share()}>
        {busy ? 'Making picture…' : '📤 Share card'}
      </button>
      {msg && <span className="sub">{msg}</span>}
    </>
  );
}

/**
 * A parent designs their child's avatar: skin tone, face shape, hairstyle and
 * colour, eyes and eye colour, glasses. The preview updates as they tap.
 */
export function AvatarEditor({
  playerId,
  playerName,
  initial,
  initialHeritage = null,
  gender = null,
  onSaved,
  onCancel,
}: {
  playerId: string;
  playerName: string;
  initial: Avatar | null | undefined;
  /** Girls also get hair glitter and rosy cheeks (Fady, 10/20). */
  gender?: 'boy' | 'girl' | null;
  /** The family's home country, shown as a second flag on the card. */
  initialHeritage?: string | null;
  onSaved: (a: Avatar) => void;
  onCancel: () => void;
}) {
  const [a, setA] = useState<Avatar>(initial ?? DEFAULT_AVATAR);
  const [heritage, setHeritage] = useState<string>(initialHeritage ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.savePlayerAvatar(playerId, a, heritage || null);
      onSaved(r.avatar);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the avatar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="avatar-editor">
      <div className="avatar-preview">
        <PlayerFigure avatar={a} width={170} title={`${playerName} avatar preview`} gender={gender ?? null} />
      </div>
      {(Object.keys(AVATAR_OPTIONS) as AvatarPart[])
        .filter((part) => gender === 'girl' || !GIRL_ONLY_PARTS.includes(part))
        .map((part) => (
        <div key={part} className="avatar-part">
          <span className="avatar-part-label">{AVATAR_LABELS[part]}</span>
          {part === 'hair' ? (
            <div className="hair-tiles" role="radiogroup" aria-label={AVATAR_LABELS[part]}>
              {/* Boys' cuts for boys, girls' styles for girls (Shadi, 10/21); the current one always shows. */}
              {[...(hairChoices(gender).includes(a.hair) ? [] : [a.hair]), ...hairChoices(gender)].map((v, i) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={a.hair === v}
                  aria-label={`Hairstyle ${i + 1}`}
                  className={`hair-tile${a.hair === v ? ' on' : ''}`}
                  onClick={() => setA((prev) => ({ ...prev, hair: v }))}
                >
                  <PlayerFace avatar={{ ...a, hair: v, glasses: 'none' }} size={48} />
                </button>
              ))}
            </div>
          ) : (
          <div className="chips" role="radiogroup" aria-label={AVATAR_LABELS[part]}>
            {(AVATAR_OPTIONS[part] as readonly string[]).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={a[part] === v}
                className={`chip${a[part] === v ? ' on' : ''}`}
                onClick={() => setA((prev) => ({ ...prev, [part]: v }) as Avatar)}
              >
                {part === 'shirt' && <span className="swatch" style={{ background: SHIRT_HEX[v] }} aria-hidden="true" />}
                {CHOICE_LABEL[v] ?? v}
              </button>
            ))}
          </div>
          )}
        </div>
      ))}
      <div className="avatar-part">
        <label className="avatar-part-label">
          Family’s home country (optional)
          <select value={heritage} onChange={(e) => setHeritage(e.target.value)}>
            <option value="">None, just the 🇺🇸 flag</option>
            {countryOptions().map(([code, name]) => (
              <option key={code} value={code}>
                {flagEmoji(code)} {name}
              </option>
            ))}
          </select>
        </label>
        <span className="sub">
          The card shows {flagEmoji(HOME_COUNTRY)}
          {heritage ? ` and ${flagEmoji(heritage)} ${countryName(heritage)}` : ''}.
        </span>
      </div>
      {error && <p className="danger-text">{error}</p>}
      <div className="row">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save avatar'}
        </button>
        <button type="button" className="btn ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Player cards as a stack (Fady, 10/17): one card on top, the rest peeking
 * out behind; swipe left or right (or tap the arrows) to go through them.
 * Order is the caller's: a parent's own children first.
 */
export function CardStack({
  items,
  below,
}: {
  items: PlayerEvaluation[];
  /** Shown under the top card, e.g. "Design avatar" for your own child. */
  below?: (ev: PlayerEvaluation) => ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<'left' | 'right' | null>(null);
  const [startX, setStartX] = useState<number | null>(null);
  if (items.length === 0) return null;
  const i = Math.min(index, items.length - 1);
  const ev = items[i];
  const go = (step: number) => {
    if (items.length < 2) return;
    setDir(step > 0 ? 'left' : 'right');
    setIndex((i + step + items.length) % items.length);
  };
  const tierOf = (k: number) => items[(i + k) % items.length]?.card?.tier ?? 'bronze';
  return (
    <div className="card-stack-wrap">
      <div
        className="card-stack"
        onPointerDown={(e) => setStartX(e.clientX)}
        onPointerUp={(e) => {
          if (startX === null) return;
          const dx = e.clientX - startX;
          setStartX(null);
          if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => setStartX(null)}
        role="group"
        aria-roledescription="carousel"
        aria-label={`Player cards, ${i + 1} of ${items.length}`}
      >
        {/* The next cards peek out behind, in their own gold, silver or bronze (Fady, 10/19). */}
        {items.length > 2 && <div className={`card-peek peek-2 ${tierOf(2)}`} aria-hidden="true" />}
        {items.length > 1 && <div className={`card-peek peek-1 ${tierOf(1)}`} aria-hidden="true" />}
        <div key={ev.playerId} className={`card-stack-top${dir ? ` from-${dir}` : ''}`}>
          <PlayerCard ev={ev} />
        </div>
      </div>
      {items.length > 1 && (
        <div className="row card-stack-nav">
          <button type="button" className="btn ghost btn-sm" aria-label="Previous card" onClick={() => go(-1)}>
            ‹
          </button>
          <span className="sub">
            {i + 1} / {items.length}
          </span>
          <button type="button" className="btn ghost btn-sm" aria-label="Next card" onClick={() => go(1)}>
            ›
          </button>
        </div>
      )}
      <div className="row card-stack-share">
        <ShareCardButton ev={ev} />
      </div>
      {below?.(ev)}
    </div>
  );
}
