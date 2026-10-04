import { describe, expect, it } from 'vitest';

import { loadPurePluginFile } from './harness.js';
const geometry = loadPurePluginFile<{
  linearBands(options: {
    stops: Array<{ position: number; color: { r: number; g: number; b: number }; opacity?: number }>;
    width: number;
    height: number;
    bands?: number;
    reverse?: boolean;
    direction?: string;
  }): { bands: Array<{ bounds: { left: number; top: number; right: number; bottom: number }; color: { r: number; g: number; b: number }; t: number }>; truncated: boolean };
  radialBands(options: {
    stops: Array<{ position: number; color: { r: number; g: number; b: number } }>;
    width: number;
    height: number;
    bands?: number;
    reverse?: boolean;
    center?: { x: number; y: number };
    radius?: number;
    blendMode?: string;
  }): { bands: Array<{ bounds: { left: number; top: number; right: number; bottom: number }; color: { r: number; g: number; b: number }; t: number }>; truncated: boolean };
  normalizeStops(stops: Array<{ position: number; color: { r: number; g: number; b: number } }>): Array<{ position: number; color: { r: number; g: number; b: number } }>;
  colorAt(stops: ReturnType<typeof normalizeStops>, t: number): { r: number; g: number; b: number };
  verificationPoints(options: Record<string, unknown>, limit?: number): Array<{ x: number; y: number }>;
  MAX_BANDS: number;
}>('lib/ops/gradient-geometry.js');

const BLACK_TO_WHITE = [
  { position: 0, color: { r: 0, g: 0, b: 0 } },
  { position: 100, color: { r: 255, g: 255, b: 255 } },
];

describe('normalizeStops', () => {
  it('sorts by position, so call order does not change the ramp', () => {
    const stops = geometry.normalizeStops([
      { position: 100, color: { r: 255, g: 255, b: 255 } },
      { position: 0, color: { r: 0, g: 0, b: 0 } },
    ]);
    expect(stops.map((s) => s.position)).toEqual([0, 100]);
  });

  it('clamps positions and colours instead of dropping the stop', () => {
    // Dropping an out-of-range stop would silently change which colour the far
    // end lands on, which is the one thing a gradient cannot be allowed to do.
    const stops = geometry.normalizeStops([
      { position: -40, color: { r: 0, g: 0, b: 0 } },
      { position: 180, color: { r: 999, g: -20, b: 128 } },
    ]);
    expect(stops.map((s) => s.position)).toEqual([0, 100]);
    expect(stops[1].color).toEqual({ r: 255, g: 0, b: 128 });
  });

  it('separates two stops at the same position, so there is a direction', () => {
    const stops = geometry.normalizeStops([
      { position: 50, color: { r: 10, g: 10, b: 10 } },
      { position: 50, color: { r: 200, g: 200, b: 200 } },
    ]);
    expect(stops[0].position).not.toBe(stops[1].position);
  });
});

describe('colorAt', () => {
  it('interpolates between the stops', () => {
    const stops = geometry.normalizeStops(BLACK_TO_WHITE);
    expect(geometry.colorAt(stops, 0.5)).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('holds the end colours beyond the ends', () => {
    const stops = geometry.normalizeStops(BLACK_TO_WHITE);
    expect(geometry.colorAt(stops, 0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(geometry.colorAt(stops, 1)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('crosses a three-stop ramp in two segments', () => {
    const stops = geometry.normalizeStops([
      { position: 0, color: { r: 255, g: 0, b: 0 } },
      { position: 50, color: { r: 0, g: 255, b: 0 } },
      { position: 100, color: { r: 0, g: 0, b: 255 } },
    ]);
    expect(geometry.colorAt(stops, 0.25)).toEqual({ r: 128, g: 128, b: 0 });
    expect(geometry.colorAt(stops, 0.75)).toEqual({ r: 0, g: 128, b: 128 });
  });
});

describe('linearBands', () => {
  it('tiles the canvas with no gap and no overlap', () => {
    // A shared fractional edge would leave a one-pixel seam that no fill covers,
    // so the bands have to meet exactly.
    const { bands } = geometry.linearBands({ stops: BLACK_TO_WHITE, width: 800, height: 600, bands: 8, direction: 'topToBottom' });
    expect(bands).toHaveLength(8);
    expect(bands[0].bounds.top).toBe(0);
    expect(bands[7].bounds.bottom).toBe(600);
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i].bounds.top).toBe(bands[i - 1].bounds.bottom);
    }
  });

  it('runs left to right on request', () => {
    const { bands } = geometry.linearBands({ stops: BLACK_TO_WHITE, width: 800, height: 600, bands: 4, direction: 'leftToRight' });
    expect(bands[0].bounds).toEqual({ left: 0, top: 0, right: 200, bottom: 600 });
    expect(bands[3].bounds).toEqual({ left: 600, top: 0, right: 800, bottom: 600 });
  });

  it('flips the ramp with reverse', () => {
    // `reverse` has to mirror the ramp, not shift it: after a flip the first
    // band must carry what the last one did, or both ends keep their colours
    // and nothing actually reversed.
    const forward = geometry.linearBands({ stops: BLACK_TO_WHITE, width: 100, height: 100, bands: 4 });
    const reversed = geometry.linearBands({ stops: BLACK_TO_WHITE, width: 100, height: 100, bands: 4, reverse: true });

    expect(reversed.bands[0].color).toEqual(forward.bands[3].color);
    expect(reversed.bands[3].color).toEqual(forward.bands[0].color);
    expect(reversed.bands[0].color.r).toBeGreaterThan(forward.bands[0].color.r);
  });

  it('caps the band count and admits it', () => {
    // A caller asking for 5000 gets a coarser ramp rather than a frozen host,
    // and is told the ramp is coarser than it asked for.
    const { bands, truncated } = geometry.linearBands({ stops: BLACK_TO_WHITE, width: 100, height: 100, bands: 5000 });
    expect(bands.length).toBeLessThanOrEqual(geometry.MAX_BANDS);
    expect(truncated).toBe(true);
  });

  it('darkens towards the horizon for a top-to-bottom sky', () => {
    // The actual use: sky lighter at the top, deeper blue towards the ground.
    const { bands } = geometry.linearBands({
      stops: [
        { position: 0, color: { r: 20, g: 40, b: 90 } },
        { position: 100, color: { r: 150, g: 190, b: 240 } },
      ],
      width: 400,
      height: 400,
      bands: 4,
      direction: 'topToBottom',
    });
    const first = bands[0].color;
    const last = bands[bands.length - 1].color;
    expect(first.b).toBeLessThan(last.b);
    expect(first.r).toBeLessThan(last.r);
  });
});

describe('radialBands', () => {
  it('paints the innermost ring last, so it is not painted over', () => {
    // Rings drawn small-to-large would each cover the one inside it. The bands
    // come out largest-first for exactly this reason.
    const { bands } = geometry.radialBands({ stops: BLACK_TO_WHITE, width: 400, height: 400, bands: 5 });
    for (let i = 1; i < bands.length; i += 1) {
      expect(bands[i].bounds.right - bands[i].bounds.left).toBeLessThan(bands[i - 1].bounds.right - bands[i - 1].bounds.left);
    }
  });

  it('centres on the canvas by default and reaches past the far corner', () => {
    // The default radius is the half-diagonal, so the whole canvas is covered
    // rather than stopping at the middle of an edge.
    const { bands } = geometry.radialBands({ stops: BLACK_TO_WHITE, width: 400, height: 400, bands: 2 });
    const outer = bands[0].bounds;
    expect((outer.left + outer.right) / 2).toBe(200);
    expect((outer.top + outer.bottom) / 2).toBe(200);
    expect(outer.left).toBeLessThan(0);
    expect(outer.right).toBeGreaterThan(400);
  });

  it('honours an explicit centre and radius', () => {
    const { bands } = geometry.radialBands({
      stops: BLACK_TO_WHITE,
      width: 400,
      height: 400,
      bands: 2,
      center: { x: 100, y: 100 },
      radius: 50,
    });
    const outer = bands[0].bounds;
    expect((outer.left + outer.right) / 2).toBe(100);
    expect(outer.right - outer.left).toBe(100);
  });
});

describe('verificationPoints', () => {
  it('spreads along the ramp for a linear fill', () => {
    const points = geometry.verificationPoints({ type: 'linear', direction: 'topToBottom', width: 800, height: 600 }, 5);
    expect(points).toHaveLength(5);
    expect(points[0].y).toBe(0);
    expect(points[4].y).toBe(600);
    for (const point of points) expect(point.x).toBe(400);
  });

  it('walks two rays for a radial fill, so an off-centre ring still shows', () => {
    const points = geometry.verificationPoints(
      { type: 'radial', width: 400, height: 400, center: { x: 200, y: 200 }, radius: 100 },
      3,
    );
    expect(points.length).toBeGreaterThan(3);
    expect(points.some((p) => p.x !== 200 && p.y === 200)).toBe(true);
    expect(points.some((p) => p.y !== 200 && p.x === 200)).toBe(true);
  });
});

describe('light under an accumulating blend mode', () => {
  const MOON = [
    { position: 0, color: { r: 255, g: 244, b: 214 } },
    { position: 100, color: { r: 0, g: 0, b: 0 } },
  ];
  const luma = (c: { r: number; g: number; b: number }): number => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

  /** What `screen` leaves after the rings so far, painted outermost-first. */
  const composited = (bands: Array<{ color: { r: number; g: number; b: number } }>): number[] => {
    let product = 1;
    return bands.map((band) => {
      product *= 1 - luma(band.color) / 255;
      return Math.round((1 - product) * 255);
    });
  };

  it('composes to the ramp instead of saturating to white', () => {
    // Measured on Photoshop 26.11 before the correction: twenty-four rings of
    // this ramp under `screen` composited to #ffffff across the whole middle,
    // with no falloff until 120px out. A glow with no falloff is not a glow.
    const { bands } = geometry.radialBands({
      stops: MOON,
      width: 800,
      height: 600,
      bands: 24,
      center: { x: 400, y: 200 },
      radius: 220,
      blendMode: 'screen',
    });

    const levels = composited(bands);
    expect(levels[0]).toBeLessThan(20);
    expect(levels[levels.length - 1]).toBeGreaterThan(200);
    // Monotonic all the way in, with no plateau where it clips.
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
      expect(levels[i]!).toBeLessThan(255);
    }
  });

  it('leaves the ramp alone for a mode that does not accumulate', () => {
    // `lighten` takes a maximum rather than a sum, so the rings already compose
    // to the ramp and correcting them would darken it.
    const plain = geometry.radialBands({ stops: MOON, width: 800, height: 600, bands: 8, radius: 220 });
    const lightened = geometry.radialBands({
      stops: MOON, width: 800, height: 600, bands: 8, radius: 220, blendMode: 'lighten',
    });
    expect(lightened.bands.map((b) => b.color)).toEqual(plain.bands.map((b) => b.color));
  });

  it('keeps the increments neutral, so the glow takes its hue from the mode', () => {
    // An increment is a quantity of light, not a colour. If it carried the
    // ramp's hue, a screen-blended blue glow would also paint the sky's tint
    // into every ring it passes over.
    const { bands } = geometry.radialBands({
      stops: [{ position: 0, color: { r: 20, g: 90, b: 220 } }, { position: 100, color: { r: 10, g: 20, b: 40 } }],
      width: 400,
      height: 400,
      bands: 8,
      radius: 200,
      blendMode: 'screen',
    });
    for (const band of bands) {
      expect(band.color.r).toBe(band.color.g);
      expect(band.color.g).toBe(band.color.b);
    }
  });

  it('gives two ramps of equal brightness the same increments', () => {
    // Same luma profile, different hue: the correction is derived from luma, so
    // the ring levels have to come out identical.
    const levels = (stops: Array<{ position: number; color: { r: number; g: number; b: number } }>) =>
      geometry.radialBands({ stops, width: 400, height: 400, bands: 8, radius: 200, blendMode: 'screen' })
        .bands.map((b) => Math.round(luma(b.color)));

    const grey = levels([{ position: 0, color: { r: 200, g: 200, b: 200 } }, { position: 100, color: { r: 0, g: 0, b: 0 } }]);
    // 0.299r + 0.587g + 0.114b = 200 with a warm tint rather than pure grey.
    const warmTop = { r: 255, g: 190, b: 130 };
    const warm = levels([{ position: 0, color: warmTop }, { position: 100, color: { r: 0, g: 0, b: 0 } }]);
    expect(Math.abs(luma(warmTop) - 200)).toBeLessThan(3);
    // Within a level, not identical: the recurrence compounds rounding, and two
    // ramps that are only near-equal in luma are not owed identical rings.
    for (let i = 0; i < grey.length; i += 1) {
      expect(Math.abs(warm[i]! - grey[i]!)).toBeLessThanOrEqual(3);
    }
  });
});
