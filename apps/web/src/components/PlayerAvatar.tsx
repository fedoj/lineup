import { useId } from 'react';
import { DEFAULT_AVATAR, type Avatar } from '@lineup/shared';

/**
 * A player's avatar, drawn as SVG from the choices a parent made
 * (packages/shared/src/avatar.ts). Never a photo of a child.
 *
 * Drawn to look close to a real kid (Fady, 10/19): shaded skin, ears, a nose,
 * eyes with coloured irises and highlights, lips with a smile, and hair with
 * light and shade. PlayerAvatar is the head and shoulders, for lists and
 * small places; PlayerFigure is the half-body holding a ball, for the card.
 */

const SKIN: Record<Avatar['skin'], string> = {
  s1: '#f8dcc2',
  s2: '#eebd94',
  s3: '#d7a073',
  s4: '#b97c50',
  s5: '#8d5a3b',
  s6: '#5c3a26',
};

const HAIR: Record<Avatar['hairColor'], string> = {
  black: '#1f1a17',
  brown: '#5b3a22',
  blonde: '#e2b857',
  red: '#b5422a',
  auburn: '#8a3b1f',
  gray: '#9aa0a6',
  blue: '#2f6fd6',
  pink: '#e66aa8',
};

const EYE: Record<Avatar['eyeColor'], string> = {
  brown: '#5a3a1c',
  blue: '#2f7fd8',
  green: '#3a9a5b',
  hazel: '#8b6b2e',
  gray: '#7c8792',
};

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

/* ------------------------------------------------------------------ head */
/* Drawn in a 120 x 120 box, face centred on (60, 58). */

function FaceShape({ face, fill }: { face: Avatar['face']; fill: string }) {
  switch (face) {
    case 'round':
      return <circle cx="60" cy="58" r="30" fill={fill} />;
    case 'square':
      return <rect x="31" y="27" width="58" height="62" rx="18" fill={fill} />;
    case 'heart':
      return <path d="M30 46 Q30 26 60 26 Q90 26 90 46 Q90 72 60 90 Q30 72 30 46 Z" fill={fill} />;
    default:
      return <ellipse cx="60" cy="58" rx="28" ry="33" fill={fill} />;
  }
}

function HairBack({ hair, fill }: { hair: Avatar['hair']; fill: string }) {
  if (hair === 'afro') return <circle cx="60" cy="46" r="40" fill={fill} />;
  if (hair === 'long') return <path d="M25 50 Q24 16 60 16 Q96 16 95 50 L98 100 Q80 106 60 104 Q40 106 22 100 Z" fill={fill} />;
  if (hair === 'ponytail') return <path d="M88 44 Q108 52 104 78 Q100 92 92 96 Q96 74 86 56 Z" fill={fill} />;
  return null;
}

function HairTop({ hair, fill, hi, line }: { hair: Avatar['hair']; fill: string; hi: string; line: string }) {
  // Anime-style shine on the crown, and a few strand lines for texture.
  const shine = (
    <g stroke={hi} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.5">
      <path d="M39 30 Q47 24 55 23" />
      <path d="M64 23 Q70 23 75 25" />
    </g>
  );
  const strands = (d: string[]) => (
    <g stroke={line} strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.45">
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
    </g>
  );
  switch (hair) {
    case 'bald':
      return null;
    case 'buzz':
      return (
        <g>
          <path d="M32 47 Q31 23 60 23 Q89 23 88 47 Q75 36 60 36 Q45 36 32 47 Z" fill={fill} opacity="0.62" />
          <path d="M33 46 Q47 38 60 38 Q73 38 87 46" stroke={line} strokeWidth="0.8" fill="none" opacity="0.35" />
        </g>
      );
    case 'curly':
      return (
        <g fill={fill}>
          {[34, 44, 54, 64, 74, 84].map((x, i) => (
            <circle key={x} cx={x} cy={i % 2 ? 28 : 32} r="9.5" />
          ))}
          <circle cx="29" cy="44" r="7.5" />
          <circle cx="91" cy="44" r="7.5" />
          {/* Curls falling over the forehead. */}
          {[40, 49, 58, 67, 76].map((x, i) => (
            <circle key={`f${x}`} cx={x} cy={i % 2 ? 38 : 40} r="5.6" />
          ))}
          <g stroke={line} strokeWidth="0.9" fill="none" opacity="0.4">
            {[36, 50, 64, 78].map((x) => (
              <path key={x} d={`M${x - 3} 29 Q${x} 25 ${x + 3} 29`} />
            ))}
          </g>
        </g>
      );
    case 'spiky':
      return (
        <g>
          <path d="M28 50 L31 20 L41 32 L45 12 L55 29 L61 9 L68 29 L77 12 L80 32 L89 20 L92 50 Q86 38 78 35 L74 44 L68 36 L62 45 L56 36 L50 45 L45 36 L40 44 Q34 40 28 50 Z" fill={fill} />
          {shine}
        </g>
      );
    case 'afro':
      return (
        <g>
          <path d="M30 45 Q33 24 60 24 Q87 24 90 45 Q74 36 60 36 Q46 36 30 45 Z" fill={fill} />
          <g fill={line} opacity="0.25">
            {[[28, 20], [44, 12], [62, 10], [80, 14], [94, 26], [20, 36], [100, 40]].map(([x, y]) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" />
            ))}
          </g>
        </g>
      );
    case 'long':
      return (
        <g>
          {/* Side-swept fringe, a parting, and locks framing the face. */}
          <path d="M26 58 Q21 16 60 15 Q99 16 94 58 Q91 42 83 34 Q78 44 66 47 Q71 37 65 29 Q57 42 43 47 Q50 38 47 30 Q39 37 35 45 Q30 50 26 58 Z" fill={fill} />
          <path d="M29 46 Q23 72 29 96 Q34 84 35 64 Z" fill={fill} />
          <path d="M91 46 Q97 72 91 96 Q86 84 85 64 Z" fill={fill} />
          {strands(['M65 29 Q60 22 52 20', 'M47 30 Q42 24 36 26', 'M83 34 Q80 26 72 22', 'M30 60 Q28 76 30 90', 'M90 60 Q92 76 90 90'])}
          {shine}
        </g>
      );
    case 'ponytail':
      return (
        <g>
          <path d="M28 54 Q25 18 60 17 Q95 18 92 54 Q88 40 81 34 Q76 43 66 45 Q70 36 64 30 Q57 41 45 45 Q50 37 46 31 Q39 37 35 44 Q31 47 28 54 Z" fill={fill} />
          {strands(['M64 30 Q58 23 50 21', 'M46 31 Q41 25 35 27', 'M81 34 Q78 26 70 22'])}
          <rect x="86" y="40" width="6" height="5" rx="2" fill="#e85d8a" transform="rotate(25 89 42)" />
          {shine}
        </g>
      );
    case 'short':
    default:
      return (
        <g>
          {/* A full top with a fringe that falls in points over the forehead. */}
          <path d="M27 54 Q24 17 60 16 Q96 17 93 54 Q90 41 84 35 L80 46 L74 34 L67 45 L60 32 L53 45 L46 34 L40 46 L36 36 Q30 43 27 54 Z" fill={fill} />
          {strands(['M60 32 Q58 24 52 20', 'M74 34 Q72 26 66 21', 'M46 34 Q44 27 38 24', 'M84 35 Q84 28 78 23'])}
          {shine}
        </g>
      );
  }
}

function Eyes({ eyes, id, lid }: { eyes: Avatar['eyes']; id: string; lid: string }) {
  if (eyes === 'smile') {
    // Happy closed eyes, anime style.
    return (
      <g stroke="#231815" strokeWidth="2.6" fill="none" strokeLinecap="round">
        <path d="M41.5 59 Q48 51.5 54.5 59" />
        <path d="M65.5 59 Q72 51.5 78.5 59" />
        <path d="M41.5 59 L39.6 57.4 M78.5 59 L80.4 57.4" strokeWidth="1.6" />
      </g>
    );
  }
  const ry = eyes === 'almond' ? 4.8 : 6.2;
  const irisRy = ry - 0.6;
  return (
    <g>
      {[48, 72].map((cx) => {
        const out = cx < 60 ? -1 : 1;
        return (
          <g key={cx}>
            <ellipse cx={cx} cy="58" rx="6.8" ry={ry} fill="#ffffff" />
            <ellipse cx={cx} cy="58.6" rx="4.6" ry={irisRy} fill={`url(#${id}-iris)`} />
            <ellipse cx={cx} cy="59" rx="2.1" ry={irisRy * 0.55} fill="#111111" />
            <circle cx={cx - 1.7} cy={58.6 - irisRy * 0.45} r="1.6" fill="#ffffff" />
            <circle cx={cx + 1.6} cy={58.6 + irisRy * 0.42} r="0.75" fill="#ffffff" opacity="0.9" />
            {/* A thick upper lash line with a little flick at the outer corner. */}
            <path
              d={`M${cx - 7.3} 58.6 Q${cx} ${58 - ry * 1.5} ${cx + 7.3} 58.6`}
              stroke="#231815"
              strokeWidth="2.3"
              fill="none"
              strokeLinecap="round"
            />
            <path d={`M${cx + 7.3 * out} 58.4 L${cx + 9.2 * out} 56.6`} stroke="#231815" strokeWidth="1.6" strokeLinecap="round" />
            <path d={`M${cx - 4.8} ${58 + ry * 0.9} Q${cx} ${58 + ry * 1.12} ${cx + 4.8} ${58 + ry * 0.9}`} stroke={lid} strokeWidth="0.8" fill="none" opacity="0.5" />
          </g>
        );
      })}
    </g>
  );
}

function Glasses({ glasses }: { glasses: Avatar['glasses'] }) {
  if (glasses === 'none') return null;
  if (glasses === 'sport') {
    return <rect x="37" y="51" width="46" height="13" rx="6.5" fill="#1d2b3a" opacity="0.82" />;
  }
  const lens =
    glasses === 'round'
      ? [<circle key="l" cx="48" cy="57.5" r="8.8" />, <circle key="r" cx="72" cy="57.5" r="8.8" />]
      : [<rect key="l" x="39" y="50.5" width="18" height="14" rx="3.5" />, <rect key="r" x="63" y="50.5" width="18" height="14" rx="3.5" />];
  return (
    <g stroke="#1d2b3a" strokeWidth="2.2" fill="#ffffff" fillOpacity="0.12">
      {lens}
      <path d="M57 57 L63 57" fill="none" />
    </g>
  );
}

/** The head, with its own shading, in the 120 x 120 box. */
function Head({ a, id }: { a: Avatar; id: string }) {
  const skin = SKIN[a.skin];
  const hair = HAIR[a.hairColor];
  const skinLo = shade(skin, 0.24);
  return (
    <g>
      <defs>
        <radialGradient id={`${id}-face`} cx="44%" cy="36%" r="72%">
          <stop offset="0%" stopColor={tint(skin, 0.2)} />
          <stop offset="58%" stopColor={skin} />
          <stop offset="100%" stopColor={skinLo} />
        </radialGradient>
        <linearGradient id={`${id}-neck`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={shade(skin, 0.34)} />
          <stop offset="60%" stopColor={skin} />
        </linearGradient>
        <linearGradient id={`${id}-hair`} x1="0" y1="0" x2="0.25" y2="1">
          <stop offset="0%" stopColor={tint(hair, 0.18)} />
          <stop offset="100%" stopColor={shade(hair, 0.3)} />
        </linearGradient>
        <linearGradient id={`${id}-iris`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={shade(EYE[a.eyeColor], 0.45)} />
          <stop offset="60%" stopColor={EYE[a.eyeColor]} />
          <stop offset="100%" stopColor={tint(EYE[a.eyeColor], 0.35)} />
        </linearGradient>
      </defs>
      <HairBack hair={a.hair} fill={`url(#${id}-hair)`} />
      <rect x="50.5" y="78" width="19" height="22" rx="6" fill={`url(#${id}-neck)`} />
      {[31, 89].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy="61" rx="5.2" ry="7.6" fill={skin} />
          <ellipse cx={cx + (cx < 60 ? 0.8 : -0.8)} cy="61" rx="2.4" ry="4.6" fill={skinLo} opacity="0.55" />
        </g>
      ))}
      <FaceShape face={a.face} fill={`url(#${id}-face)`} />
      <ellipse cx="41.5" cy="70" rx="5.6" ry="3.2" fill="#ff7272" opacity="0.22" />
      <ellipse cx="78.5" cy="70" rx="5.6" ry="3.2" fill="#ff7272" opacity="0.22" />
      {/* A small, soft nose, anime style. */}
      <path d="M60.6 63.5 Q58.8 66.8 60.4 67.6" stroke={skinLo} strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <Eyes eyes={a.eyes} id={id} lid={shade(skin, 0.5)} />
      <g stroke={shade(hair, 0.08)} strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M41 48.5 Q48 45 55 47.2" />
        <path d="M65 47.2 Q72 45 79 48.5" />
      </g>
      <path d="M52.5 74 Q60 81.5 67.5 74 Q60 76.6 52.5 74 Z" fill="#a33c3c" />
      <path d="M54.6 74.7 Q60 77.6 65.4 74.7 Q60 76 54.6 74.7 Z" fill="#ffffff" />
      <path d="M56 78.6 Q60 80.4 64 78.6" stroke="#e28d8d" strokeWidth="1" fill="none" opacity="0.7" strokeLinecap="round" />
      <HairTop hair={a.hair} fill={`url(#${id}-hair)`} hi={tint(hair, 0.45)} line={shade(hair, 0.4)} />
      <Glasses glasses={a.glasses} />
    </g>
  );
}

/* --------------------------------------------------------------- avatars */

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
      <path d="M16 120 Q20 92 60 90 Q100 92 104 120 Z" fill={`url(#${id}-shirt)`} />
      <Head a={a} id={id} />
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
export function FigureArt({ a, id, shirt = '#f7f7f9', fade = false }: { a: Avatar; id: string; shirt?: string; fade?: boolean }) {
  const skin = SKIN[a.skin];
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
        {/* Body in a tee, with short sleeves. */}
        <path d="M100 128 C78 128 52 132 38 142 C24 150 18 168 17 190 L17 260 L183 260 L183 190 C182 168 176 150 162 142 C148 132 122 128 100 128 Z" fill={`url(#${id}-tee)`} />
        <path d="M38 142 C24 150 16 170 18 196 L46 200 C46 178 48 160 52 150 Z" fill={shirtLo} />
        <path d="M162 142 C176 150 184 170 182 196 L154 200 C154 178 152 160 148 150 Z" fill={shirtLo} />
        <path d="M83 131 Q100 146 117 131" stroke={shade(shirt, 0.3)} strokeWidth="3.5" fill="none" strokeLinecap="round" />
        {/* Upper arms, tapering to the elbow. */}
        <path d="M19 192 L45 197 Q47 222 42 240 Q34 250 26 242 Q18 222 19 192 Z" fill={`url(#${id}-arm)`} />
        <path d="M181 192 L155 197 Q153 222 158 240 Q166 250 174 242 Q182 222 181 192 Z" fill={`url(#${id}-arm)`} />
        {/* Head on top of the collar. */}
        <g transform="translate(19 0) scale(1.35)">
          <Head a={a} id={`${id}h`} />
        </g>
        {/* Forearms reach in to hold the ball. */}
        <g strokeLinecap="round" fill="none">
          <path d="M33 238 Q48 226 64 210" stroke={skinLo} strokeWidth="18" />
          <path d="M33 238 Q48 226 64 210" stroke={skin} strokeWidth="15" />
          <path d="M167 238 Q152 226 136 210" stroke={skinLo} strokeWidth="18" />
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
        <circle cx="100" cy="204" r="34" fill="none" stroke="#8a929b" strokeWidth="1" />
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
                stroke={skinLo}
                strokeWidth="0.8"
              />
              <g strokeLinecap="round" fill="none">
                {fingers.map(([y, len]) => (
                  <g key={y}>
                    <path d={`M${cx} ${y} L${cx + len * d} ${y + 0.6}`} stroke={skinLo} strokeWidth="5.4" />
                    <path d={`M${cx} ${y} L${cx + len * d} ${y + 0.6}`} stroke={skin} strokeWidth="4.3" />
                  </g>
                ))}
                <path d={`M${cx - 5 * d} 199 Q${cx} 192 ${cx + 6 * d} 193`} stroke={skinLo} strokeWidth="6" />
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
