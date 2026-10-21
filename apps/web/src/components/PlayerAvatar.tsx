import { useId } from 'react';
import { DEFAULT_AVATAR, type Avatar } from '@lineup/shared';
import { SKIN_HEX, useLorelei } from '../lib/lorelei';

/**
 * A player's avatar, drawn as SVG from the choices a parent made
 * (packages/shared/src/avatar.ts). Never a photo of a child.
 *
 * The face and hair are the Lorelei avatar art (Fady, 10/20; lib/lorelei.ts):
 * line-art faces and 48 real hairstyles, recolored. PlayerAvatar is the head
 * and shoulders, for lists and small places; PlayerFigure is the half-body
 * holding a ball, for the card, outlined in the same line style.
 */

const LINE = '#1b1311';

function mix(a: string, b: string, t: number): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
const shade = (h: string, t: number) => mix(h, '#000000', t);
const tint = (h: string, t: number) => mix(h, '#ffffff', t);

/** An id that is safe inside url(#…), unique per drawing. */
function useSvgId(): string {
  return `av${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

/**
 * The head, as a square drawing at (x, y). Until the art has loaded, a plain
 * skin-colored head shape holds its place.
 */
function Head({ a, x, y, size }: { a: Avatar; x: number; y: number; size: number }) {
  const lorelei = useLorelei();
  const id = useSvgId();
  if (!lorelei) {
    return (
      <g opacity="0.55">
        <ellipse cx={x + size * 0.52} cy={y + size * 0.45} rx={size * 0.2} ry={size * 0.25} fill={SKIN_HEX[a.skin]} />
        <rect x={x + size * 0.44} y={y + size * 0.62} width={size * 0.14} height={size * 0.38} fill={SKIN_HEX[a.skin]} />
      </g>
    );
  }
  const { viewBox, inner } = lorelei(a, id);
  return <svg x={x} y={y} width={size} height={size} viewBox={viewBox} dangerouslySetInnerHTML={{ __html: inner }} />;
}

/* --------------------------------------------------------------- avatars */

/** Just the face and hair, close up (the hairstyle picker). */
export function PlayerFace({ avatar, size = 44, title }: { avatar: Avatar; size?: number; title?: string }) {
  return (
    <svg className="player-avatar" width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={title ?? 'Face'}>
      <Head a={avatar} x={-30} y={-18} size={170} />
    </svg>
  );
}

/** Head and shoulders in the team shirt, in a circle-friendly square. */
export default function PlayerAvatar({
  avatar,
  size = 96,
  shirt = '#1f6feb',
  title,
}: {
  avatar: Avatar | null | undefined;
  size?: number;
  /** Jersey colour. */
  shirt?: string;
  title?: string;
}) {
  const a = avatar ?? DEFAULT_AVATAR;
  const id = useSvgId();
  return (
    <svg className="player-avatar" width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={title ?? 'Player avatar'}>
      <defs>
        <linearGradient id={`${id}-shirt`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={shade(shirt, 0.2)} />
          <stop offset="50%" stopColor={tint(shirt, 0.12)} />
          <stop offset="100%" stopColor={shade(shirt, 0.2)} />
        </linearGradient>
      </defs>
      <Head a={a} x={-4} y={-6} size={120} />
      <path d="M14 121 Q18 96 50 93 Q60 99 70 93 Q102 96 106 121 Z" fill={`url(#${id}-shirt)`} stroke={LINE} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
const PENTAGON = (cx: number, cy: number, r: number, turn = -90) =>
  Array.from({ length: 5 }, (_, i) => {
    const t = ((turn + i * 72) * Math.PI) / 180;
    return `${(cx + r * Math.cos(t)).toFixed(1)},${(cy + r * Math.sin(t)).toFixed(1)}`;
  }).join(' ');

/**
 * The player from the waist up, holding a ball in front of them, for the
 * player card (Fady, 10/19: like the FC cards, the player fills the card).
 * Drawn in a 200 x 260 box; `fade` fades the bottom so it sits into the card.
 */
export function PlayerFigure({
  avatar,
  shirt = '#f7f7f9',
  width = 200,
  title,
  fade = false,
}: {
  avatar: Avatar | null | undefined;
  shirt?: string;
  width?: number;
  title?: string;
  fade?: boolean;
}) {
  const a = avatar ?? DEFAULT_AVATAR;
  const id = useSvgId();
  return (
    <svg className="player-figure" width={width} height={(width * 260) / 200} viewBox="0 0 200 260" role="img" aria-label={title ?? 'Player'}>
      <FigureArt a={a} id={id} shirt={shirt} fade={fade} />
    </svg>
  );
}

/** The figure's drawing, for use inside another SVG (the card). */
export function FigureArt({
  a,
  id,
  shirt = '#f7f7f9',
  fade = false,
  logo = null,
}: {
  a: Avatar;
  id: string;
  shirt?: string;
  fade?: boolean;
  /** The team's region logo, on the chest of the tee (Fady, 10/20). */
  logo?: string | null;
}) {
  const skin = SKIN_HEX[a.skin];
  const skinLo = shade(skin, 0.24);
  const shirtLo = shade(shirt, 0.16);
  const balls = [0, 1, 2, 3, 4].map((i) => {
    const t = ((-90 + 36 + i * 72) * Math.PI) / 180;
    return { x: 100 + 31 * Math.cos(t), y: 204 + 31 * Math.sin(t), turn: -90 + 36 + i * 72 + 180 };
  });
  return (
    <g>
      <defs>
        <linearGradient id={`${id}-tee`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={shade(shirt, 0.2)} />
          <stop offset="45%" stopColor={tint(shirt, 0.15)} />
          <stop offset="100%" stopColor={shade(shirt, 0.22)} />
        </linearGradient>
        <linearGradient id={`${id}-arm`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={skinLo} />
          <stop offset="55%" stopColor={tint(skin, 0.08)} />
          <stop offset="100%" stopColor={skinLo} />
        </linearGradient>
        <radialGradient id={`${id}-ball`} cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="70%" stopColor="#eceff3" />
          <stop offset="100%" stopColor="#b9c0c9" />
        </radialGradient>
        <clipPath id={`${id}-ballclip`}>
          <circle cx="100" cy="204" r="34" />
        </clipPath>
        {fade && (
          <>
            <linearGradient id={`${id}-fadeg`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="86%" stopColor="#ffffff" />
              <stop offset="100%" stopColor="#000000" />
            </linearGradient>
            <mask id={`${id}-fade`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="260">
              <rect x="0" y="0" width="200" height="260" fill={`url(#${id}-fadeg)`} />
            </mask>
          </>
        )}
      </defs>
      <g mask={fade ? `url(#${id}-fade)` : undefined}>
        {/* The head first: the tee's collar covers the bottom of the neck. */}
        <Head a={a} x={14} y={-8} size={172} />
        {/* The neck down into the scooped collar. */}
        <path d="M88.5 120 L111.5 120 L113 148 L87 148 Z" fill={skin} />
        <path d="M88.5 120 L87.6 140 M111.5 120 L112.4 140" stroke={LINE} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        {/* The body in a tee (Fady, 10/20: a scooped collar, and the body narrows
            under the arms instead of one wide block), outlined like the face. */}
        <path
          d="M82 129 Q100 148 118 129 C134 130 150 134 160 142 C166 152 158 174 156 200 L152 260 L48 260 L44 200 C42 174 34 152 40 142 C50 134 66 130 82 129 Z"
          fill={`url(#${id}-tee)`}
          stroke={LINE}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {logo && (
          <g>
            <circle cx="131" cy="163" r="14" fill="#ffffff" stroke={LINE} strokeWidth="1.2" />
            <image href={logo} x="119" y="151" width="24" height="24" preserveAspectRatio="xMidYMid meet" />
          </g>
        )}
        {/* Short sleeves over the shoulders. */}
        <path d="M40 142 C26 150 17 170 18 196 L46 200 C46 180 46 162 52 151 Z" fill={shirtLo} stroke={LINE} strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M160 142 C174 150 183 170 182 196 L154 200 C154 180 154 162 148 151 Z" fill={shirtLo} stroke={LINE} strokeWidth="1.8" strokeLinejoin="round" />
        {/* Upper arms, tapering to the elbow. */}
        <path d="M19 192 L45 197 Q47 222 42 240 Q34 250 26 242 Q18 222 19 192 Z" fill={`url(#${id}-arm)`} stroke={LINE} strokeWidth="1.6" />
        <path d="M181 192 L155 197 Q153 222 158 240 Q166 250 174 242 Q182 222 181 192 Z" fill={`url(#${id}-arm)`} stroke={LINE} strokeWidth="1.6" />
        {/* Forearms reach in to hold the ball. */}
        <g strokeLinecap="round" fill="none">
          <path d="M33 238 Q48 226 64 210" stroke={LINE} strokeWidth="18.4" />
          <path d="M33 238 Q48 226 64 210" stroke={skin} strokeWidth="15" />
          <path d="M167 238 Q152 226 136 210" stroke={LINE} strokeWidth="18.4" />
          <path d="M167 238 Q152 226 136 210" stroke={skin} strokeWidth="15" />
        </g>
        {/* The ball. */}
        <circle cx="100" cy="204" r="34" fill={`url(#${id}-ball)`} />
        <g clipPath={`url(#${id}-ballclip)`}>
          <polygon points={PENTAGON(100, 204, 11)} fill="#24272b" />
          {balls.map((b, i) => (
            <polygon key={i} points={PENTAGON(b.x, b.y, 11, b.turn)} fill="#24272b" />
          ))}
          {[0, 1, 2, 3, 4].map((i) => {
            const t = ((-90 + i * 72) * Math.PI) / 180;
            return (
              <line
                key={i}
                x1={100 + 11 * Math.cos(t)}
                y1={204 + 11 * Math.sin(t)}
                x2={100 + 22 * Math.cos(t)}
                y2={204 + 22 * Math.sin(t)}
                stroke="#7d848c"
                strokeWidth="1.1"
              />
            );
          })}
        </g>
        <circle cx="100" cy="204" r="34" fill="none" stroke={LINE} strokeWidth="1.8" />
        {/* Hands holding the ball: fingers across the front, thumbs on top. */}
        {[66, 134].map((cx) => {
          const d = cx < 100 ? 1 : -1;
          const fingers: Array<[number, number]> = [
            [201, 8.5],
            [206, 10],
            [211, 9.5],
            [216, 7.5],
          ];
          return (
            <g key={cx}>
              <path
                d={`M${cx - 9 * d} 198 Q${cx - 2 * d} 194 ${cx + 2 * d} 199 L${cx + 3 * d} 218 Q${cx - 4 * d} 223 ${cx - 9 * d} 216 Z`}
                fill={shade(skin, 0.08)}
                stroke={LINE}
                strokeWidth="1.2"
              />
              <g strokeLinecap="round" fill="none">
                {fingers.map(([y, len]) => (
                  <g key={y}>
                    <path d={`M${cx} ${y} L${cx + len * d} ${y + 0.6}`} stroke={LINE} strokeWidth="5.6" />
                    <path d={`M${cx} ${y} L${cx + len * d} ${y + 0.6}`} stroke={skin} strokeWidth="4.3" />
                  </g>
                ))}
                <path d={`M${cx - 5 * d} 199 Q${cx} 192 ${cx + 6 * d} 193`} stroke={LINE} strokeWidth="6.2" />
                <path d={`M${cx - 5 * d} 199 Q${cx} 192 ${cx + 6 * d} 193`} stroke={skin} strokeWidth="4.8" />
              </g>
              {fingers.map(([y, len]) => (
                <path key={`n${y}`} d={`M${cx + (len - 1.6) * d} ${y - 1.1} l${0.9 * d} 0.3`} stroke={tint(skin, 0.4)} strokeWidth="1" strokeLinecap="round" />
              ))}
            </g>
          );
        })}
      </g>
    </g>
  );
}
