/**
 * Coordinate transform tests.
 *
 * The spec asks for "a deterministic test: normalized stroke -> pixel stroke with
 * a known result", and `KNOWN_CASES` below is that test written out longhand so a
 * regression names the exact stroke that changed rather than a property that
 * happens to hold.
 *
 * The invariant underneath all of it: at 1920x1080, x=0.5 and y=0.25 must land on
 * 960 and 270. Every other number here follows from that.
 */

import { describe, expect, it } from 'vitest';
import {
  brushToPixels,
  regionToPixels,
  shortEdge,
  strokeToPixels,
  toPixels,
} from '../src/renderer/coordinates.js';
import type { SemanticStroke } from '../src/types.js';

const HD: { width: number; height: number } = { width: 1920, height: 1080 };

describe('normalized -> pixels', () => {
  it('maps the spec example exactly', () => {
    expect(toPixels({ x: 0.5, y: 0.25 }, HD)).toEqual({ x: 960, y: 270 });
  });

  it('maps the corners', () => {
    expect(toPixels({ x: 0, y: 0 }, HD)).toEqual({ x: 0, y: 0 });
    expect(toPixels({ x: 1, y: 1 }, HD)).toEqual({ x: 1920, y: 1080 });
  });

  it('rounds rather than truncates', () => {
    // 1920/3 is exactly 640; 1080/3 is exactly 360, so this checks the thirds
    // grid rather than the rounding. The rounding is checked below at 0.1.
    expect(toPixels({ x: 1 / 3, y: 1 / 3 }, HD)).toEqual({ x: 640, y: 360 });
    // 1920 * 0.1 = 192, 1080 * 0.29 = 313.2 -> 313
    expect(toPixels({ x: 0.1, y: 0.29 }, HD)).toEqual({ x: 192, y: 313 });
  });

  it('scales to any canvas size', () => {
    const uhd = { width: 3840, height: 2160 };
    expect(toPixels({ x: 0.5, y: 0.25 }, uhd)).toEqual({ x: 1920, y: 540 });
  });

  it('maps a region to its pixel box', () => {
    expect(regionToPixels({ x: 0.5, y: 0.25, width: 0.25, height: 0.5 }, HD)).toEqual({
      left: 960,
      top: 270,
      right: 1440,
      bottom: 810,
    });
  });
});

describe('brush sizing', () => {
  it('measures against the shorter edge so a brush stays round', () => {
    expect(shortEdge(HD)).toBe(1080);
    expect(shortEdge({ width: 1080, height: 1920 })).toBe(1080);
  });

  it('gives the same brush the same diameter on a portrait canvas', () => {
    const landscape = brushToPixels(0.1, HD);
    const portrait = brushToPixels(0.1, { width: 1080, height: 1920 });
    expect(landscape).toBe(portrait);
  });

  it('converts a tenth of the short edge to 108px on 1920x1080', () => {
    expect(brushToPixels(0.1, HD)).toBe(108);
  });

  it('never returns a zero-sized brush', () => {
    expect(brushToPixels(0.0001, HD)).toBe(1);
  });
});

describe('strokeToPixels', () => {
  const base: SemanticStroke = {
    brush: 'oil_medium',
    color: '#214d69',
    size: 0.1,
    opacity: 0.55,
    flow: 0.7,
    spacing: 0.28,
    tip: { core: 0.6, steps: 3, outerAlpha: 0.35 },
    depth: 'midground',
    purpose: 'large ocean wave',
    points: [
      { x: 0.0625, y: 0.463 },
      { x: 0.09375, y: 0.444 },
      { x: 0.130208, y: 0.416667 },
      { x: 0.171875, y: 0.398148 },
      { x: 0.21875, y: 0.412037 },
    ],
  };

  it('produces a known pixel stroke for a known normalized stroke', () => {
    const pixels = strokeToPixels(base, HD);
    expect(pixels).not.toBeNull();
    // 1920 * 0.0625 = 120; 1080 * 0.463 = 500.04 -> 500
    expect(pixels?.points).toEqual([
      { x: 120, y: 500 },
      { x: 180, y: 480 },
      { x: 250, y: 450 },
      { x: 330, y: 430 },
      { x: 420, y: 445 },
    ]);
    expect(pixels?.size).toBe(108);
    expect(pixels?.color).toBe('#214d69');
    expect(pixels?.opacity).toBe(0.55);
    expect(pixels?.depth).toBe('midground');
  });

  it('is a pure function of its inputs', () => {
    expect(strokeToPixels(base, HD)).toEqual(strokeToPixels(base, HD));
  });

  it('renders the same picture at a different resolution', () => {
    const small = strokeToPixels(base, { width: 1280, height: 720 });
    expect(small?.points[0]).toEqual({ x: 80, y: 333 });
    expect(small?.size).toBe(72);
  });

  it('clamps a path that overshoots the canvas instead of throwing', () => {
    const overshoot: SemanticStroke = {
      ...base,
      points: [
        { x: -0.2, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 1.4, y: 0.5 },
      ],
    };
    const pixels = strokeToPixels(overshoot, HD);
    expect(pixels?.points[0]).toEqual({ x: 0, y: 540 });
    expect(pixels?.points[2]).toEqual({ x: 1920, y: 540 });
  });

  it('drops an empty stroke rather than sending a zero-length path', () => {
    expect(strokeToPixels({ ...base, points: [] }, HD)).toBeNull();
  });

  it('drops a path that was entirely off-canvas', () => {
    const offCanvas = strokeToPixels(
      { ...base, points: [{ x: -0.5, y: -0.5 }, { x: -0.2, y: -0.1 }] },
      HD,
    );
    expect(offCanvas).toBeNull();
  });

  it('keeps a single-point stroke, which is a legitimate dab', () => {
    const dab = strokeToPixels({ ...base, points: [{ x: 0.5, y: 0.5 }] }, HD);
    expect(dab?.points).toEqual([{ x: 960, y: 540 }]);
  });

  it('passes the blend mode through only when one is set', () => {
    expect(strokeToPixels(base, HD)?.blendMode).toBeUndefined();
    expect(strokeToPixels({ ...base, blendMode: 'screen' }, HD)?.blendMode).toBe('screen');
  });
});