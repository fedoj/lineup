import { useEffect, useState } from 'react';
import type { Avatar } from '@lineup/shared';
import type { StyleOptions } from '@dicebear/core';
import type { Options as LoreleiOptions } from '@dicebear/lorelei';
import { GLITTER_POINTS } from '../data/avatarGlitter';

/**
 * Player avatars drawn with the Lorelei avatar art (Fady, 10/20): DiceBear's
 * "Lorelei" by Lisa Wischofsky, released as CC0 (free for any use). Its 48
 * hairstyles are the hairstyle choices, recolored with the hair color; skin,
 * face shape, eyes and glasses map onto its parts.
 *
 * The art is about 50 KB, so it loads on its own after the page (and early,
 * when the app is idle); avatars show a plain placeholder until then.
 */

export const SKIN_HEX: Record<Avatar['skin'], string> = {
  s1: '#f8dcc2',
  s2: '#eebd94',
  s3: '#d7a073',
  s4: '#b97c50',
  s5: '#8d5a3b',
  s6: '#5c3a26',
};

export const HAIR_HEX: Record<Avatar['hairColor'], string> = {
  black: '#1f1a17',
  brown: '#5b3a22',
  blonde: '#e2b857',
  red: '#b5422a',
  auburn: '#8a3b1f',
  gray: '#9aa0a6',
  blue: '#2f6fd6',
  pink: '#e66aa8',
};

/** Eye colors, a little deeper than real life so they read in the line art. */
export const EYE_HEX: Record<Avatar['eyeColor'], string> = {
  brown: '#4a2c16',
  blue: '#1f62b8',
  green: '#2d8250',
  hazel: '#7d5a1c',
  gray: '#56616d',
};

const EYES: Record<Avatar['eyes'], string> = { round: 'variant14', almond: 'variant12', smile: 'variant17' };
const HEAD: Record<Avatar['face'], string> = { oval: 'variant01', round: 'variant02', square: 'variant03', heart: 'variant04' };
const GLASSES: Record<Exclude<Avatar['glasses'], 'none'>, string> = { round: 'variant01', square: 'variant04', sport: 'variant02' };

/**
 * Where each eye's iris sits in the drawing (980 x 980, the same for every
 * face shape), measured from the art. The art draws the eye, lashes and lid as
 * one line, so coloring it would color the lids too (Fady, 10/20: "it colored
 * their eyebrows"); instead the line stays dark and a colored circle with a
 * pupil dot sits in each eye.
 */
const IRIS: Partial<Record<Avatar['eyes'], ReadonlyArray<{ cx: number; cy: number; rx: number; ry: number }>>> = {
  round: [
    { cx: 496, cy: 466, rx: 17, ry: 21 },
    { cx: 657, cy: 455, rx: 11, ry: 14 },
  ],
  almond: [
    { cx: 487, cy: 461, rx: 14, ry: 15 },
    { cx: 656, cy: 455, rx: 11, ry: 11 },
  ],
};

function irisMarkup(a: Avatar): string {
  const color = EYE_HEX[a.eyeColor];
  return (IRIS[a.eyes] ?? [])
    .map(({ cx, cy, rx, ry }) => {
      const p = Math.min(rx, ry) * 0.5;
      return (
        `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}"/>` +
        `<circle cx="${cx}" cy="${cy + 1}" r="${p.toFixed(1)}" fill="#120b08"/>` +
        `<circle cx="${cx - rx * 0.35}" cy="${cy - ry * 0.4}" r="${(p * 0.55).toFixed(1)}" fill="#ffffff"/>`
      );
    })
    .join('');
}

/** Rosier cheeks (girls only, Fady, 10/20): soft pink under each eye. */
function cheeksMarkup(a: Avatar): string {
  if (a.cheeks !== 'rosy') return '';
  return (
    '<ellipse cx="466" cy="534" rx="40" ry="20" fill="#ff4f72" opacity="0.45"/>' +
    '<ellipse cx="676" cy="524" rx="24" ry="15" fill="#ff4f72" opacity="0.45"/>'
  );
}

/** Glitter in the hair (girls only): small four-point sparkles and dots, set inside the hair. */
function glitterMarkup(a: Avatar): string {
  if (a.glitter !== 'glitter') return '';
  return (GLITTER_POINTS[a.hair] ?? [])
    .map(([x, y], i) => {
      const r = i % 3 === 0 ? 34 : i % 3 === 1 ? 26 : 12;
      const fill = i % 2 ? '#fff6c2' : '#ffffff';
      if (r === 12) return `<circle cx="${x}" cy="${y}" r="11" fill="#ffe27a" stroke="#e8b923" stroke-width="3"/>`;
      const w = r * 0.28;
      return `<path d="M${x} ${y - r}L${x + w} ${y - w}L${x + r} ${y}L${x + w} ${y + w}L${x} ${y + r}L${x - w} ${y + w}L${x - r} ${y}L${x - w} ${y - w}Z" fill="${fill}" stroke="#e8b923" stroke-width="4" stroke-linejoin="round"/>`;
    })
    .join('');
}

const hex = (h: string) => h.replace('#', '');

function darker(h: string, t: number): string {
  return hex(h)
    .match(/../g)!
    .map((c) => Math.round(parseInt(c, 16) * (1 - t)).toString(16).padStart(2, '0'))
    .join('');
}

function optionsFor(a: Avatar): StyleOptions<LoreleiOptions> {
  const hair = HAIR_HEX[a.hairColor];
  return {
    seed: 'lineup',
    hair: [`variant${a.hair.slice(1)}`] as LoreleiOptions['hair'],
    hairColor: [hex(hair)],
    skinColor: [hex(SKIN_HEX[a.skin])],
    head: [HEAD[a.face]] as LoreleiOptions['head'],
    eyes: [EYES[a.eyes]] as LoreleiOptions['eyes'],
    eyesColor: ['1b1311'],
    eyebrows: ['variant02'],
    eyebrowsColor: [darker(hair, 0.35)],
    mouth: ['happy01'],
    nose: ['variant01'],
    glasses: a.glasses === 'none' ? undefined : ([GLASSES[a.glasses]] as LoreleiOptions['glasses']),
    glassesProbability: a.glasses === 'none' ? 0 : 100,
    beardProbability: 0,
    earringsProbability: 0,
    frecklesProbability: 0,
    hairAccessoriesProbability: 0,
  };
}

/** The drawing's insides and its viewBox; ids are made unique per use with `idSuffix`. */
export type LoreleiRender = (a: Avatar, idSuffix: string) => { viewBox: string; inner: string };

let render: LoreleiRender | null = null;
let loading: Promise<LoreleiRender> | null = null;
const waiting = new Set<() => void>();

export function loadLorelei(): Promise<LoreleiRender> {
  if (render) return Promise.resolve(render);
  loading ??= Promise.all([import('@dicebear/core'), import('@dicebear/lorelei')]).then(([core, lorelei]) => {
    const cache = new Map<string, { viewBox: string; inner: string }>();
    render = (a, idSuffix) => {
      const key = `${a.skin}|${a.face}|${a.hair}|${a.hairColor}|${a.eyes}|${a.eyeColor}|${a.glasses}|${a.glitter}|${a.cheeks}`;
      let hit = cache.get(key);
      if (!hit) {
        const svg = core.createAvatar(lorelei, optionsFor(a)).toString().replace(/<metadata[\s\S]*?<\/metadata>/, '');
        const open = svg.indexOf('>');
        hit = {
          viewBox: /viewBox="([^"]+)"/.exec(svg.slice(0, open))?.[1] ?? '0 0 980 980',
          inner: svg.slice(open + 1, svg.lastIndexOf('</svg>')) + irisMarkup(a) + cheeksMarkup(a) + glitterMarkup(a),
        };
        cache.set(key, hit);
      }
      // Every drawing on the page needs its own mask id, or a hidden copy
      // (a folded card) could blank out the visible ones.
      return { viewBox: hit.viewBox, inner: hit.inner.replace(/(id="|url\(#)([A-Za-z][\w-]*)/g, `$1$2-${idSuffix}`) };
    };
    waiting.forEach((fn) => fn());
    waiting.clear();
    return render;
  });
  return loading;
}

/** The renderer once the art has loaded (null until then; the component redraws). */
export function useLorelei(): LoreleiRender | null {
  const [r, setR] = useState<LoreleiRender | null>(() => render);
  useEffect(() => {
    if (r) return;
    if (render) {
      setR(() => render);
      return;
    }
    const done = () => setR(() => render);
    waiting.add(done);
    void loadLorelei().catch(() => undefined);
    return () => {
      waiting.delete(done);
    };
  }, [r]);
  return r;
}
