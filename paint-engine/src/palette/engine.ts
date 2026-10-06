/**
 * Colour, and the rule that keeps a painting from turning into confetti.
 *
 * The Art Director states *what tone a mark is* — "shadow", "the warm accent in
 * the break in the cloud" — and this module decides which hex that is. A model
 * asked to pick a colour per stroke invents a new hue every time and the result
 * has no colour unity; a model asked for five tonal roles produces a picture that
 * holds together.
 *
 * Everything is HSL internally because the operations a painter actually needs —
 * lifting a highlight without shifting its hue, cooling a shadow, greying an
 * accent until it sits behind the subject — are one-liners in HSL and fiddly
 * multi-step blends in RGB.
 */

import type { PaletteRole, PaletteSpec } from '../types.js';
import type { Rng } from '../random.js';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  l: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clamp255 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (value: number): string => clamp255(value).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;

  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const grey = l * 255;
    return { r: grey, g: grey, b: grey };
  }
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  return {
    r: (rgb[0] + m) * 255,
    g: (rgb[1] + m) * 255,
    b: (rgb[2] + m) * 255,
  };
}

/** Moves a colour in HSL. Unspecified channels are left alone. */
export function shift(hex: string, delta: Partial<Hsl>): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(
    hslToRgb({
      h: (hsl.h + (delta.h ?? 0) + 360) % 360,
      s: clamp01(hsl.s + (delta.s ?? 0)),
      l: clamp01(hsl.l + (delta.l ?? 0)),
    }),
  );
}

/** Perceptual-ish blend. `t` 0 returns `a`, 1 returns `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp01(t);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

export function lighten(hex: string, amount: number): string {
  return shift(hex, { l: amount });
}

export function darken(hex: string, amount: number): string {
  return shift(hex, { l: -amount });
}

export function saturate(hex: string, amount: number): string {
  return shift(hex, { s: amount });
}

export function desaturate(hex: string, amount: number): string {
  return shift(hex, { s: -amount });
}

export function warm(hex: string, amount: number): string {
  return shift(hex, { h: amount });
}

export function cool(hex: string, amount: number): string {
  return shift(hex, { h: -amount });
}

/** Relative luminance, for choosing a legible colour against a background. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The relative hue distance between two colours, 0..180. */
export function hueDistance(a: string, b: string): number {
  const ha = rgbToHsl(hexToRgb(a)).h;
  const hb = rgbToHsl(hexToRgb(b)).h;
  const diff = Math.abs(ha - hb) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Expands a short seed palette into a full five-role one.
 *
 * A brief like "deep blue, muted grey, warm highlights" arrives as three colours
 * in three different roles. This derives the missing roles from them by value
 * rather than inventing hues: shadows come from the darkest seed, highlights
 * from the lightest, and accents from whichever seed is furthest round the wheel
 * from the dominant one.
 *
 * Empty roles are filled by walking the seeds' hue, which is why a two-colour
 * brief still yields a coherent five-role palette.
 *
 * Takes no RNG on purpose: a palette is a pure function of the brief, so the
 * same words always produce the same colours. Randomness belongs in where the
 * marks go, not in what colour they are.
 */
export function buildPalette(seeds: Partial<Record<PaletteRole, string[]>>): PaletteSpec {
  const all = (Object.values(seeds) as string[][]).flat().filter(Boolean);
  if (all.length === 0) {
    // Nothing to work from. A neutral warm-grey ramp is the least committal
    // palette there is, and it lets the composition read while the brief is
    // fixed rather than failing the whole render.
    return {
      shadows: ['#1a1a1e', '#2b2b31'],
      midtones: ['#5c5a58', '#7d7a76'],
      highlights: ['#c9c4bb', '#ece7de'],
      accents: ['#8a7f6f'],
      base: ['#3a3833'],
    };
  }

  const sorted = [...all].sort((x, y) => luminance(x) - luminance(y));
  const darkest = sorted[0] as string;
  const lightest = sorted[sorted.length - 1] as string;
  const mid = sorted[Math.floor(sorted.length / 2)] as string;

  const furthest = [...all].sort((x, y) => hueDistance(y, mid) - hueDistance(x, x))[0] as string;

  const role = (key: PaletteRole, fallback: string[]): string[] => {
    const given = seeds[key];
    if (given && given.length > 0) return [...given];
    return fallback;
  };

  return {
    shadows: role('shadows', [darken(darkest, 0.12), darken(darkest, 0.04), darken(mid, 0.16)]),
    midtones: role('midtones', [mid, lighten(darkest, 0.2), lighten(lightest, -0.12)]),
    highlights: role('highlights', [lighten(lightest, 0.04), lighten(lightest, 0.16), lighten(mid, 0.3)]),
    accents: role('accents', [furthest === mid ? shift(mid, { h: 40 }) : furthest, shift(furthest, { l: 0.12 })]),
    base: role('base', [mid, darken(mid, 0.06)]),
  };
}

/**
 * Resolves a stroke's `colorRole` to an actual colour.
 *
 * An explicit `#rrggbb` passes through untouched, which is what makes the engine
 * usable for a caller that genuinely knows the colour it wants. Anything else is
 * treated as a palette role, and an unknown role falls back to midtones rather
 * than throwing — a plan naming a role that does not exist should still paint.
 */
export function resolveColor(role: string | undefined, palette: PaletteSpec, rng: Rng, variant = 0): string {
  if (role && /^#[0-9a-f]{6}$/i.test(role)) return role.toLowerCase();

  const key = (role ?? 'midtones') as PaletteRole;
  const list = palette[key] ?? palette.midtones;
  if (!list || list.length === 0) return '#808080';

  // `variant` walks the list deterministically so a stage using one role twice
  // gets two different colours, while a rerun of the same plan gets the same two.
  return list[(Math.abs(variant) + rng.int(0, 1)) % list.length] as string;
}

/** Every distinct colour in a palette, for documentation and plan previews. */
export function paletteSwatches(palette: PaletteSpec): string[] {
  return [...new Set(Object.values(palette).flat())];
}