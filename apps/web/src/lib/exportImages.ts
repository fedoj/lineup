import { flagEmoji, HOME_COUNTRY, SITE_HOST, slotsForFormation, type Format } from '@lineup/shared';
import type { Analytics, AnalyticsPlayer, CompetitionSummary, PlayerEvaluation } from './api';

/**
 * Pictures the app draws on the spot for sharing or printing (Fady, 10/19):
 * a game's lineup (every quarter or half on one page) and the team's stats.
 * White background so they print well. Drawn at 2x so they stay sharp.
 * Nothing is uploaded or kept.
 */

const SCALE = 2;
const INK = '#0e1a2b';
const MUTED = '#5b6576';
const LINE = '#d9dee7';
const GREEN = '#2e7d32';
const GREEN_LIGHT = '#eaf5eb';
const KEEPER = '#fff4cc';
const WIN = '#1b7f3b';
const LOSS = '#c4362f';
const FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * SCALE);
  canvas.height = Math.round(h * SCALE);
  const c = canvas.getContext('2d')!;
  c.scale(SCALE, SCALE);
  c.textBaseline = 'top';
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, h);
  return [canvas, c];
}

function fit(c: CanvasRenderingContext2D, text: string, max: number): string {
  if (c.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && c.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

/** Lines of text wrapped to a width. */
function wrap(c: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (c.measureText(next).width > max && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

export function shortName(name: string): string {
  const parts = name.replace(/\s*\(guest\)\s*$/i, '').trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] ?? 'Player';
}

function prettyDay(iso: string | null): string {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Every picture shared out names the site (Fady, 10/19). */
function footer(c: CanvasRenderingContext2D, h: number, pad: number) {
  c.textAlign = 'left';
  c.fillStyle = GREEN;
  c.font = `700 14px ${FONT}`;
  const lead = `Made with ⚽ Lineup · ${SITE_HOST}`;
  c.fillText(lead, pad, h - 30);
  const w = c.measureText(lead).width;
  c.fillStyle = MUTED;
  c.font = `400 12px ${FONT}`;
  c.fillText(` · ${new Date().toLocaleDateString()}`, pad + w, h - 30);
}

function header(c: CanvasRenderingContext2D, w: number, pad: number, title: string, subtitle: string): number {
  c.fillStyle = INK;
  c.font = `800 30px ${FONT}`;
  c.fillText(fit(c, title, w - pad * 2 - 140), pad, pad);
  c.fillStyle = MUTED;
  c.font = `500 16px ${FONT}`;
  c.fillText(fit(c, subtitle, w - pad * 2 - 140), pad, pad + 42);
  c.textAlign = 'right';
  c.fillStyle = GREEN;
  c.font = `800 18px ${FONT}`;
  c.fillText('⚽ LINEUP', w - pad, pad + 4);
  c.fillStyle = INK;
  c.font = `600 14px ${FONT}`;
  c.fillText(SITE_HOST, w - pad, pad + 30);
  c.textAlign = 'left';
  const y = pad + 74;
  c.strokeStyle = GREEN;
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(pad, y);
  c.lineTo(w - pad, y);
  c.stroke();
  return y + 18;
}

/* ------------------------------------------------------------------ lineup */

export interface LineupPeriod {
  label: string;
  formation: string;
  /** slot id -> player id */
  assignment: Record<string, string>;
}

/** One pitch, drawn into a box. y=90 is our own goal (bottom). */
function drawPitch(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  format: Format,
  p: LineupPeriod,
  names: Map<string, { name: string; number: string }>,
) {
  c.strokeStyle = GREEN;
  c.lineWidth = 2.5;
  c.strokeRect(x, y, w, h);
  // Halfway line, centre circle, both penalty boxes and goal areas.
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(x, y + h / 2);
  c.lineTo(x + w, y + h / 2);
  c.stroke();
  c.beginPath();
  c.arc(x + w / 2, y + h / 2, w * 0.12, 0, Math.PI * 2);
  c.stroke();
  for (const top of [true, false]) {
    const bw = w * 0.56;
    const bh = h * 0.15;
    const gw = w * 0.28;
    const gh = h * 0.06;
    const by = top ? y : y + h - bh;
    const gy = top ? y : y + h - gh;
    c.strokeRect(x + (w - bw) / 2, by, bw, bh);
    c.strokeRect(x + (w - gw) / 2, gy, gw, gh);
  }

  const slots = slotsForFormation(format, p.formation);
  const r = Math.max(16, Math.min(24, w / 22));
  for (const s of slots) {
    const pid = p.assignment[s.id];
    const cx = x + (s.x / 100) * w;
    const cy = y + (s.y / 100) * h;
    const who = pid ? names.get(pid) : undefined;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = s.isKeeper ? KEEPER : who ? GREEN_LIGHT : '#ffffff';
    c.fill();
    c.strokeStyle = who ? GREEN : '#9aa5b5';
    c.lineWidth = 2;
    if (!who) c.setLineDash([4, 3]);
    c.stroke();
    c.setLineDash([]);
    c.textAlign = 'center';
    c.fillStyle = INK;
    c.font = `800 ${Math.round(r * 0.8)}px ${FONT}`;
    c.fillText(who ? who.number || '–' : s.pos, cx, cy - r * 0.45);
    if (who) {
      c.font = `700 ${Math.round(r * 0.6)}px ${FONT}`;
      const label = fit(c, shortName(who.name), r * 5);
      const tw = c.measureText(label).width + 8;
      c.fillStyle = 'rgba(255,255,255,0.9)';
      c.fillRect(cx - tw / 2, cy + r + 2, tw, r * 0.8);
      c.fillStyle = INK;
      c.fillText(label, cx, cy + r + 4);
    }
    c.textAlign = 'left';
  }
}

/**
 * The whole game on one page: four pitches for quarters (2 by 2) or two for
 * halves (side by side), each with its bench and who is out.
 */
export function renderLineupImage(o: {
  teamName: string;
  opponent: string;
  date: string | null;
  kickoff?: string | null;
  format: Format;
  periods: LineupPeriod[];
  players: Array<{ id: string; name: string; number: string; active?: boolean }>;
  absentIds?: Set<string>;
}): HTMLCanvasElement {
  const W = 1400;
  const PAD = 40;
  const cols = 2;
  const rows = Math.ceil(o.periods.length / cols);
  const cellW = (W - PAD * 2 - 40) / cols;
  const pitchW = cellW;
  const pitchH = o.periods.length > 2 ? cellW * 1.05 : cellW * 1.3;
  const benchH = 78;
  const cellH = 40 + pitchH + benchH;
  const H = PAD + 92 + rows * (cellH + 24) + 40;

  const [canvas, c] = canvasOf(W, H);
  const names = new Map(o.players.map((p) => [p.id, { name: p.name, number: p.number }]));
  const when = [prettyDay(o.date), o.kickoff ?? ''].filter(Boolean).join(' · ');
  let y = header(
    c,
    W,
    PAD,
    `${o.teamName}${o.opponent ? ` vs ${o.opponent}` : ''}`,
    `${when ? `${when} · ` : ''}${o.format} · Lineup for every ${o.periods.length === 2 ? 'half' : 'quarter'}`,
  );

  o.periods.forEach((p, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = PAD + col * (cellW + 40);
    const top = y + row * (cellH + 24);
    c.fillStyle = INK;
    c.font = `800 22px ${FONT}`;
    c.fillText(p.label, x, top);
    c.fillStyle = MUTED;
    c.font = `500 15px ${FONT}`;
    c.textAlign = 'right';
    c.fillText(p.formation, x + cellW, top + 5);
    c.textAlign = 'left';
    drawPitch(c, x, top + 34, pitchW, pitchH, o.format, p, names);

    const on = new Set(Object.values(p.assignment));
    const bench = o.players.filter((pl) => pl.active !== false && !on.has(pl.id) && !o.absentIds?.has(pl.id));
    const out = o.players.filter((pl) => o.absentIds?.has(pl.id));
    c.font = `500 15px ${FONT}`;
    let by = top + 34 + pitchH + 10;
    const lines = wrap(c, `Bench: ${bench.length ? bench.map((b) => `${b.number ? `#${b.number} ` : ''}${shortName(b.name)}`).join(', ') : 'none'}`, cellW);
    c.fillStyle = INK;
    for (const l of lines.slice(0, 3)) {
      c.fillText(l, x, by);
      by += 20;
    }
    if (out.length) {
      c.fillStyle = LOSS;
      c.fillText(fit(c, `Out: ${out.map((b) => shortName(b.name)).join(', ')}`, cellW), x, by);
    }
  });

  c.fillStyle = MUTED;
  c.font = `400 12px ${FONT}`;
  footer(c, H, PAD);
  return canvas;
}

/* ------------------------------------------------------------------- stats */

function standingLine(cmp: CompetitionSummary): string {
  const s = cmp.standing;
  if (!s) return '';
  const parts: string[] = [];
  if (s.positionLabel) parts.push(`${s.positionLabel} of ${s.of}`);
  if (s.played > 0) parts.push(`${s.pts} pts`, `${s.won}W ${s.drawn}D ${s.lost}L`);
  else parts.push('no games yet');
  if (s.stage) parts.push(s.stage);
  return parts.join(' · ');
}

function statBoxes(c: CanvasRenderingContext2D, x: number, y: number, w: number, cells: Array<[string, string, string?]>): number {
  const gap = 10;
  const bw = (w - gap * (cells.length - 1)) / cells.length;
  cells.forEach(([n, label, color], i) => {
    const bx = x + i * (bw + gap);
    c.fillStyle = '#f2f4f8';
    c.fillRect(bx, y, bw, 70);
    c.strokeStyle = LINE;
    c.strokeRect(bx, y, bw, 70);
    c.textAlign = 'center';
    c.fillStyle = color ?? INK;
    c.font = `800 26px ${FONT}`;
    c.fillText(n, bx + bw / 2, y + 10);
    c.fillStyle = MUTED;
    c.font = `700 11px ${FONT}`;
    c.fillText(label.toUpperCase(), bx + bw / 2, y + 48);
    c.textAlign = 'left';
  });
  return y + 70;
}

/**
 * Season stats on one page, with as much as fits (Fady, 10/19): the record,
 * match events, leagues and tournaments with the team's place, every player's
 * numbers in a table, and every result. Or one player's numbers with the team.
 */
export function renderStatsImage(o: {
  teamName: string;
  data: Analytics;
  comps: CompetitionSummary[];
  playerId?: string | null;
  fullNames?: boolean;
}): HTMLCanvasElement {
  const W = 1200;
  const PAD = 40;
  const nameOf = (p: AnalyticsPlayer) => (o.fullNames ? p.name : shortName(p.name));
  const r = o.data.record;
  const t = o.data.team;
  const player = o.playerId ? o.data.players.find((p) => p.playerId === o.playerId) ?? null : null;
  const players = [...o.data.players].sort((a, b) => b.goals + b.assists - (a.goals + a.assists) || a.name.localeCompare(b.name));
  const games = o.data.games;
  const resultCols = 4;
  const resultRows = player ? 0 : Math.ceil(games.length / resultCols);

  const H =
    PAD + 92 +
    (player ? 110 + 90 : 0) +
    90 + // record
    (t && !player ? 34 : 0) +
    (o.comps.length ? 34 + o.comps.length * 28 + 10 : 0) +
    (player ? 0 : 40 + 32 + players.length * 30 + 16) +
    (resultRows ? 40 + resultRows * 34 : 0) +
    50;

  const [canvas, c] = canvasOf(W, H);
  let y = header(
    c,
    W,
    PAD,
    player ? `${nameOf(player)}${player.number ? `  #${player.number}` : ''}` : `${o.teamName} · Season stats`,
    player ? `${o.teamName} · Season stats` : `${r.played} games · ${players.length} players`,
  );

  if (player) {
    y = statBoxes(c, PAD, y, W - PAD * 2, [
      [String(player.gamesPlayed), 'games'],
      [String(player.minutes), 'minutes'],
      [String(player.goals), 'goals', WIN],
      [String(player.assists), 'assists'],
      [String(player.clearances), 'clearances'],
      [String(player.saves), 'saves'],
      [String(player.yellow), 'yellow'],
      [String(player.red), 'red', player.red ? LOSS : undefined],
      [player.present + player.absent ? `${player.attendanceRate}%` : '–', 'attendance'],
    ]);
    y += 30;
    c.fillStyle = MUTED;
    c.font = `700 13px ${FONT}`;
    c.fillText('TEAM', PAD, y);
    y += 22;
  }

  y = statBoxes(c, PAD, y, W - PAD * 2, [
    [String(r.played), 'played'],
    [String(r.won), 'won', WIN],
    [String(r.drawn), 'drawn'],
    [String(r.lost), 'lost', LOSS],
    [`${r.goalsFor}–${r.goalsAgainst}`, 'goals'],
    [String(r.won * 3 + r.drawn), 'points'],
  ]);
  y += 16;
  if (t && !player) {
    c.fillStyle = MUTED;
    c.font = `500 15px ${FONT}`;
    c.fillText(
      `Match events: ${t.corners} corners · ${t.fouls} fouls · ${t.yellow} yellow · ${t.red} red   |   Against: ${t.cornersAgainst} corners · ${t.foulsAgainst} fouls · ${t.yellowAgainst} yellow · ${t.redAgainst} red`,
      PAD,
      y,
    );
    y += 34;
  }

  if (o.comps.length) {
    c.fillStyle = MUTED;
    c.font = `700 13px ${FONT}`;
    c.fillText('LEAGUES & TOURNAMENTS', PAD, y);
    y += 26;
    for (const cmp of o.comps) {
      c.fillStyle = INK;
      c.font = `700 16px ${FONT}`;
      const name = `${cmp.kind === 'tournament' ? '🏆' : '📅'} ${cmp.name}`;
      c.fillText(fit(c, name, 420), PAD, y);
      c.font = `500 16px ${FONT}`;
      c.fillStyle = cmp.standing?.position === 1 ? WIN : INK;
      c.fillText(fit(c, standingLine(cmp), W - PAD * 2 - 440), PAD + 440, y);
      y += 28;
    }
    y += 10;
  }

  if (!player) {
    c.fillStyle = MUTED;
    c.font = `700 13px ${FONT}`;
    c.fillText('PLAYERS', PAD, y);
    y += 26;
    const cols: Array<[string, number, (p: AnalyticsPlayer) => string]> = [
      ['#', 50, (p) => p.number || '–'],
      ['Player', 330, (p) => nameOf(p)],
      ['GP', 70, (p) => String(p.gamesPlayed)],
      ['Min', 80, (p) => String(p.minutes)],
      ['G', 60, (p) => String(p.goals)],
      ['A', 60, (p) => String(p.assists)],
      ['Clr', 70, (p) => String(p.clearances)],
      ['Saves', 80, (p) => String(p.saves)],
      ['YC', 60, (p) => String(p.yellow)],
      ['RC', 60, (p) => String(p.red)],
      ['Att', 100, (p) => (p.present + p.absent ? `${p.attendanceRate}%` : '–')],
    ];
    const total = cols.reduce((a, [, w]) => a + w, 0);
    const k = (W - PAD * 2) / total;
    c.fillStyle = GREEN;
    c.fillRect(PAD, y, W - PAD * 2, 30);
    c.fillStyle = '#ffffff';
    c.font = `800 14px ${FONT}`;
    let x = PAD;
    for (const [label, w] of cols) {
      c.fillText(label, x + 8, y + 8);
      x += w * k;
    }
    y += 32;
    players.forEach((p, i) => {
      if (i % 2 === 0) {
        c.fillStyle = '#f5f7fa';
        c.fillRect(PAD, y, W - PAD * 2, 30);
      }
      let cx = PAD;
      cols.forEach(([label, w, val], ci) => {
        c.fillStyle = label === 'G' && p.goals ? WIN : label === 'RC' && p.red ? LOSS : INK;
        c.font = `${ci === 1 ? 700 : 500} 15px ${FONT}`;
        c.fillText(fit(c, val(p), w * k - 12), cx + 8, y + 7);
        cx += w * k;
      });
      y += 30;
    });
    y += 16;
  }

  if (resultRows) {
    c.fillStyle = MUTED;
    c.font = `700 13px ${FONT}`;
    c.fillText('RESULTS', PAD, y);
    y += 26;
    const cw = (W - PAD * 2 - (resultCols - 1) * 10) / resultCols;
    games.forEach((g, i) => {
      const col = i % resultCols;
      const row = Math.floor(i / resultCols);
      const gx = PAD + col * (cw + 10);
      const gy = y + row * 34;
      const res = g.us > g.them ? 'W' : g.us < g.them ? 'L' : 'D';
      c.fillStyle = res === 'W' ? '#eaf5eb' : res === 'L' ? '#fdecea' : '#f2f4f8';
      c.fillRect(gx, gy, cw, 28);
      c.fillStyle = INK;
      c.font = `500 14px ${FONT}`;
      const day = g.date ? new Date(`${g.date}T12:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : `#${g.gameNo}`;
      c.fillText(fit(c, `${day}  ${g.opponent || 'Game'}`, cw - 80), gx + 8, gy + 6);
      c.textAlign = 'right';
      c.fillStyle = res === 'W' ? WIN : res === 'L' ? LOSS : MUTED;
      c.font = `800 14px ${FONT}`;
      c.fillText(`${g.us}–${g.them} ${res}`, gx + cw - 8, gy + 6);
      c.textAlign = 'left';
    });
    y += resultRows * 34;
  }

  c.fillStyle = MUTED;
  c.font = `400 12px ${FONT}`;
  footer(c, H, PAD);
  return canvas;
}

/* ------------------------------------------------------------- player card */

const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * An SVG element as a ready-to-draw bitmap. Loaded as a data URL (some phones
 * refuse blob URLs for SVG), decoded first, and drawn twice because Safari
 * can draw an SVG blank the first time.
 */
async function svgBitmap(svg: SVGSVGElement | null, w: number, h: number): Promise<HTMLCanvasElement | null> {
  if (!svg) return null;
  const el = svg.cloneNode(true) as SVGSVGElement;
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  let markup = new XMLSerializer().serializeToString(el);
  if (!/^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(markup)) {
    markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
  if (!img) return null;
  await img.decode?.().catch(() => undefined);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const c = out.getContext('2d')!;
  c.drawImage(img, 0, 0, w, h);
  await frame();
  c.clearRect(0, 0, w, h);
  c.drawImage(img, 0, 0, w, h);
  return out;
}

/**
 * The player card as a picture to share (Fady, 10/19): the same drawing as on
 * screen (PlayerCardArt), then the flags and the region's badge along its
 * bottom, and the site underneath. Nothing is uploaded or kept.
 */
export async function renderPlayerCardImage(o: {
  ev: PlayerEvaluation;
  cardSvg: SVGSVGElement | null;
  /** Where the flags and badge sit, as a fraction of the card's height. */
  badgeRow: number;
  countryName: (code: string) => string;
}): Promise<HTMLCanvasElement> {
  const { ev } = o;
  const W = 600;
  const CARD_H = 840;
  const TOP = 16;
  const H = TOP + CARD_H + 90;
  const [canvas, c] = canvasOf(W, H);
  // The bitmap is made at the canvas's own scale so it stays sharp.
  const [card, badge] = await Promise.all([
    svgBitmap(o.cardSvg, W * SCALE, CARD_H * SCALE),
    ev.regionLogo ? loadImage(ev.regionLogo) : Promise.resolve(null),
  ]);
  if (!card) throw new Error('Could not draw the card');
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.28)';
  c.shadowBlur = 22;
  c.shadowOffsetY = 10;
  c.drawImage(card, 0, TOP, W, CARD_H);
  c.restore();

  // Flags and the region's badge, centred along the bottom of the card.
  const flags = [ev.country ?? HOME_COUNTRY, ev.heritage].filter(Boolean) as string[];
  const items: Array<{ kind: 'flag'; code: string } | { kind: 'badge'; img: HTMLImageElement }> = [
    ...flags.map((code) => ({ kind: 'flag' as const, code })),
    ...(badge ? [{ kind: 'badge' as const, img: badge }] : []),
  ];
  const rowY = TOP + CARD_H * o.badgeRow;
  const gap = 76;
  items.forEach((it, i) => {
    const x = W / 2 + (i - (items.length - 1) / 2) * gap;
    if (it.kind === 'flag') {
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `40px ${EMOJI_FONT}`;
      c.fillText(flagEmoji(it.code), x, rowY);
    } else {
      const s = 46;
      c.drawImage(it.img, x - s / 2, rowY - s / 2, s, s);
    }
  });

  // Under the card: where it's from, for anyone who sees it shared.
  c.textAlign = 'center';
  c.textBaseline = 'top';
  c.fillStyle = GREEN;
  c.font = `800 22px ${FONT}`;
  c.fillText(`⚽ LINEUP · ${SITE_HOST}`, W / 2, H - 70);
  c.fillStyle = MUTED;
  c.font = `400 14px ${FONT}`;
  const flagNames = flags.map((f) => o.countryName(f)).join(' · ');
  c.fillText(fit(c, [ev.teamName, ev.regionName, flagNames].filter(Boolean).join(' · '), W - 80), W / 2, H - 38);
  c.textAlign = 'left';
  return canvas;
}
