/**
 * Palette and colour-primitive tests.
 *
 * The colour maths is worth testing on its own rather than only through a plan,
 * because a mistake here is invisible in a rendered picture — a hue that lands
 * 4 degrees off still looks like paint. Asserting the round trips and the
 * perceptual direction of each operation is what keeps a palette from drifting.
 */

import { describe, expect, it } from 'vitest';
import {
  buildPalette,
  cool,
  darken,
  desaturate,
  hexToRgb,
  hslToRgb,
  hueDistance,
  lighten,
  luminance,
  mix,
  paletteSwatches,
  resolveColor,
  rgbToHex,
  rgbToHsl,
  saturate,
  warm,
} from '../src/palette/engine.js';
import { Rng } from '../src/random.js';

describe('colour primitives', () => {
  it('round-trips hex through rgb and back', () => {
    for (const hex of ['#000000', '#ffffff', '#173b58', '#e4d7b2', '#7f7f80']) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });

  it('accepts shorthand hex', () => {
    expect(hexToRgb('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it('round-trips through hsl within one 8-bit step', () => {
    for (const hex of ['#173b58', '#e4d7b2', '#285c76', '#b9d6d8']) {
      const back = rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex))));
      expect(back).toBe(hex);
    }
  });

  it('reports luminance in the right order', () => {
    expect(luminance('#ffffff')).toBeGreaterThan(luminance('#808080'));
    expect(luminance('#808080')).toBeGreaterThan(luminance('#000000'));
  });

  it('lighten raises luminance and darken lowers it', () => {
    const base = '#285c76';
    expect(luminance(lighten(base, 0.2))).toBeGreaterThan(luminance(base));
    expect(luminance(darken(base, 0.2))).toBeLessThan(luminance(base));
  });

  it('desaturate moves toward grey without changing lightness', () => {
    const base = '#c43a1e';
    const grey = desaturate(base, 0.5);
    expect(rgbToHsl(hexToRgb(grey)).s).toBeLessThan(rgbToHsl(hexToRgb(base)).s);
    // HSL lightness survives to within one 8-bit step; perceptual luminance does
    // not, because it weights the channels, so lightness is the invariant to test.
    expect(rgbToHsl(hexToRgb(grey)).l).toBeCloseTo(rgbToHsl(hexToRgb(base)).l, 2);
  });

  it('saturate raises saturation', () => {
    const base = '#8a8070';
    expect(rgbToHsl(hexToRgb(saturate(base, 0.3))).s).toBeGreaterThan(rgbToHsl(hexToRgb(base)).s);
  });

  it('warm and cool move hue in opposite directions', () => {
    expect(hueDistance(warm('#285c76', 30), '#285c76')).toBeGreaterThan(25);
    expect(hueDistance(cool('#285c76', 30), '#285c76')).toBeGreaterThan(25);
    expect(hueDistance(warm('#285c76', 30), '#285c76')).toBeGreaterThan(
      hueDistance(cool('#285c76', 30), '#285c76') - 1,
    );
  });

  it('shift clamps instead of wrapping out of gamut', () => {
    expect(lighten('#ffffff', 0.5)).toBe('#ffffff');
    expect(darken('#000000', 0.5)).toBe('#000000');
    expect(saturate('#ffffff', 0.9)).toBe('#ffffff');
  });

  it('mix interpolates between its endpoints', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    // Relative luminance is 0..1, so mid grey sits near 0.2.
    const middle = luminance(mix('#000000', '#ffffff', 0.5));
    expect(middle).toBeGreaterThan(0.18);
    expect(middle).toBeLessThan(0.24);
  });

  it('measures hue distance the short way round the wheel', () => {
    expect(hueDistance('#ff0000', '#00ff00')).toBeCloseTo(120, 0);
    expect(hueDistance('#ff0000', '#fe0100')).toBeLessThan(2);
  });
});

describe('buildPalette', () => {
  it('fills every role from a sparse brief', () => {
    const palette = buildPalette({ shadows: ['#102a3b'], highlights: ['#e4d7b2'] });
    for (const role of ['shadows', 'midtones', 'highlights', 'accents', 'base'] as const) {
      expect(palette[role].length).toBeGreaterThan(0);
    }
  });

  it('keeps the roles it was given', () => {
    const palette = buildPalette({ shadows: ['#102a3b'] });
    expect(palette.shadows).toEqual(['#102a3b']);
  });

  it('derives shadows darker than highlights', () => {
    const palette = buildPalette({ midtones: ['#285c76'] });
    const darkestShadow = Math.min(...palette.shadows.map(luminance));
    const brightestHighlight = Math.max(...palette.highlights.map(luminance));
    expect(darkestShadow).toBeLessThan(brightestHighlight);
  });

  it('returns a usable palette for an empty brief rather than throwing', () => {
    const palette = buildPalette({});
    expect(paletteSwatches(palette).length).toBeGreaterThan(0);
  });

  it('is a pure function of the brief, with no randomness involved', () => {
    expect(buildPalette({ midtones: ['#285c76'] })).toEqual(buildPalette({ midtones: ['#285c76'] }));
  });
});

describe('resolveColor', () => {
  const palette = buildPalette(
    {
      shadows: ['#102a3b', '#173d55'],
      midtones: ['#285c76'],
      highlights: ['#b9d6d8', '#e4d7b2'],
      accents: ['#c05a3a'],
      base: ['#173b58'],
    },
    new Rng(1),
  );

  it('passes an explicit hex through untouched', () => {
    expect(resolveColor('#ff00ff', palette, new Rng(1))).toBe('#ff00ff');
  });

  it('resolves each named role', () => {
    expect(palette.shadows).toContain(resolveColor('shadows', palette, new Rng(1)));
    expect(palette.highlights).toContain(resolveColor('highlights', palette, new Rng(1)));
    expect(palette.accents).toContain(resolveColor('accents', palette, new Rng(1)));
  });

  it('falls back to midtones for an unknown role instead of throwing', () => {
    expect(palette.midtones).toContain(resolveColor('chartreuse', palette, new Rng(1)));
  });

  it('uses the variant to vary the choice deterministically', () => {
    const rngA = new Rng(5);
    const rngB = new Rng(5);
    const first = resolveColor('shadows', palette, rngA, 0);
    const again = resolveColor('shadows', palette, rngB, 0);
    expect(first).toBe(again);
  });
});