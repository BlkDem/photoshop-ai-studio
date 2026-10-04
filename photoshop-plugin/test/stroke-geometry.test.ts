import { describe, expect, it } from 'vitest';

import { loadPurePluginFile } from './harness.js';

/**
 * Stroke geometry tests.
 *
 * Everything that decides where ink lands is pure arithmetic in
 * `stroke-geometry.js` — no `require('photoshop')`, no selection calls, no
 * modal scope. That is deliberate: the drawing path is the one part of the
 * plugin that loading the file cannot check, and these tests are what stand in
 * for the licence. The bugs they exist to catch are the ones that produced
 * square stroke ends, notched corners and dotted hairlines in the previous
 * rectangle-tracing implementation.
 */

interface Stamp {
  x: number;
  y: number;
  r: number;
  p: number;
}

const geometry = loadPurePluginFile<{
  flattenSegments(segments: unknown[]): { points: Array<{ x: number; y: number }>; starts: number[] };
  smoothPoints(
    points: Array<{ x: number; y: number }>,
    starts: number[],
    iterations: number,
  ): { points: Array<{ x: number; y: number }>; starts: number[] };
  dropDuplicatePoints(
    points: Array<{ x: number; y: number }>,
    starts: number[],
    tolerance: number,
  ): { points: Array<{ x: number; y: number }>; starts: number[] };
  eachStamp(
    points: Array<{ x: number; y: number }>,
    starts: number[],
    options: { radius: number; simulatePressure?: boolean; maxStamps?: number },
    onStamp: (stamp: Stamp) => void,
  ): { emitted: number; truncated: boolean };
  verificationPoints(
    points: Array<{ x: number; y: number }>,
    starts: number[],
    stride: number,
  ): Array<{ x: number; y: number }>;
  buildStroke(
    segments: unknown[] | undefined,
    points: Array<{ x: number; y: number }> | undefined,
    options: { brushSize?: number; smoothing?: number; simulatePressure?: boolean; maxStamps?: number },
  ): {
    points: Array<{ x: number; y: number }>;
    starts: number[];
    stamps: Stamp[];
    truncated: boolean;
    radius: number;
    verificationPoints: Array<{ x: number; y: number }>;
  };
  pressureAt(t: number): number;
  stampSpacing(radius: number): number;
  distance(a: { x: number; y: number }, b: { x: number; y: number }): number;
}>('lib/ops/stroke-geometry.js');

const line = (x: number, y: number) => ({ type: 'line', point: { x, y } });
const move = (x: number, y: number) => ({ type: 'move', point: { x, y } });

describe('flattenSegments', () => {
  it('keeps move and line endpoints in order', () => {
    const flat = geometry.flattenSegments([move(0, 0), line(10, 0), line(20, 0)]);
    expect(flat.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ]);
    expect(flat.starts).toEqual([0]);
  });

  it('follows a curve through its control points instead of cutting the chord', () => {
    // The old implementation kept only `point`, so this rendered as a straight
    // line from (0,0) to (30,0). A curve bulging to y=30 must actually bulge.
    const flat = geometry.flattenSegments([
      move(0, 0),
      { type: 'curve', cp1: { x: 10, y: 30 }, cp2: { x: 20, y: 30 }, point: { x: 30, y: 0 } },
    ]);

    const peak = Math.max(...flat.points.map((p) => p.y));
    // The control points sit at y=30, so the curve must bulge towards them —
    // a chord from (0,0) to (30,0) would never leave y=0.
    expect(peak).toBeGreaterThan(15);
    expect(flat.points.length).toBeGreaterThan(4);
    expect(flat.points[flat.points.length - 1]).toEqual({ x: 30, y: 0 });
  });

  it('starts a new subpath at every move, so the gap between them is not inked', () => {
    const flat = geometry.flattenSegments([move(0, 0), line(10, 0), move(90, 0), line(100, 0)]);
    expect(flat.starts).toEqual([0, 2]);
  });

  it('treats a path that opens with a line as beginning at that point', () => {
    const flat = geometry.flattenSegments([line(5, 5), line(10, 0)]);
    expect(flat.points[0]).toEqual({ x: 5, y: 5 });
    expect(flat.starts).toEqual([0]);
  });
});

describe('smoothPoints', () => {
  it('leaves the path untouched at zero iterations', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ];
    expect(geometry.smoothPoints(points, [0], 0).points).toEqual(points);
  });

  it('cuts corners inward, so the smoothed path stays inside the original', () => {
    const smoothed = geometry.smoothPoints(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ],
      [0],
      1,
    );
    // Every interior point must be pulled off the spike at (10,10).
    expect(Math.max(...smoothed.points.map((p) => p.y))).toBeLessThan(10);
    expect(smoothed.points[0]).toEqual({ x: 0, y: 0 });
    expect(smoothed.points[smoothed.points.length - 1]).toEqual({ x: 20, y: 0 });
  });

  it('never bridges two subpaths', () => {
    const smoothed = geometry.smoothPoints(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 90, y: 0 },
        { x: 100, y: 0 },
      ],
      [0, 2],
      3,
    );
    // Both subpaths keep their endpoints, so the pen-up gap survives smoothing.
    expect(smoothed.points.some((p) => p.x === 0)).toBe(true);
    expect(smoothed.points.some((p) => p.x === 100)).toBe(true);
  });
});

describe('eachStamp', () => {
  const collect = (
    points: Array<{ x: number; y: number }>,
    options: { radius: number; simulatePressure?: boolean; maxStamps?: number },
  ) => {
    const stamps: Array<{ x: number; y: number; r: number; p: number }> = [];
    const walk = geometry.eachStamp(points, [0], options, (stamp) => stamps.push(stamp));
    return { stamps, walk };
  };

  it('leaves no gap along a straight run, whatever the radius', () => {
    for (const radius of [1, 2, 5, 21, 150]) {
      const { stamps } = collect(
        [
          { x: 0, y: 50 },
          { x: 200, y: 50 },
        ],
        { radius },
      );
      // Consecutive discs overlap only while their spacing is under 2r.
      const spacing = geometry.stampSpacing(radius);
      expect(spacing).toBeLessThan(2 * radius);
      for (let i = 1; i < stamps.length; i += 1) {
        expect(geometry.distance(stamps[i - 1]!, stamps[i]!)).toBeLessThanOrEqual(spacing + 1e-6);
      }
      expect(stamps.length).toBeGreaterThan(1);
    }
  });

  it('keeps the stamp count proportional to distance, not to a fixed step', () => {
    const thin = collect([{ x: 0, y: 0 }, { x: 400, y: 0 }], { radius: 2 });
    const thick = collect([{ x: 0, y: 0 }, { x: 400, y: 0 }], { radius: 100 });
    // Spacing scales with radius, so a thicker brush is not tens of times slower.
    expect(thick.stamps.length).toBeLessThan(thin.stamps.length * 6);
  });

  it('leaves round ends: the first and last discs are full size without pressure', () => {
    const { stamps } = collect([{ x: 0, y: 0 }, { x: 100, y: 0 }], { radius: 10 });
    expect(stamps[0]!.r).toBe(10);
    expect(stamps[stamps.length - 1]!.r).toBe(10);
  });

  it('tapers both ends and is fattest in the middle when pressure is simulated', () => {
    const { stamps } = collect([{ x: 0, y: 0 }, { x: 300, y: 0 }], { radius: 20, simulatePressure: true });
    expect(stamps[0]!.r).toBeLessThan(stamps[0]!.r === 0 ? 1 : 20);
    const middle = stamps[Math.floor(stamps.length / 2)]!;
    expect(middle.r).toBeGreaterThan(stamps[0]!.r);
    expect(middle.r).toBeGreaterThan(stamps[stamps.length - 1]!.r);
  });

  it('does not leave gaps where the taper narrows', () => {
    // Spacing has to follow the narrowest disc on the path, or the tapered ends
    // come out dotted instead of continuous.
    const { stamps } = collect([{ x: 0, y: 0 }, { x: 120, y: 0 }], { radius: 30, simulatePressure: true });
    for (let i = 1; i < stamps.length; i += 1) {
      const gap = geometry.distance(stamps[i - 1]!, stamps[i]!);
      expect(gap).toBeLessThanOrEqual(stamps[i - 1]!.r + stamps[i]!.r + 1e-6);
    }
  });

  it('leaves a dot rather than nothing for a single-point path', () => {
    const { stamps } = collect([{ x: 5, y: 5 }], { radius: 8 });
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ x: 5, y: 5, r: 8 });
  });

  it('reports truncation instead of silently stopping', () => {
    const { stamps, walk } = collect([{ x: 0, y: 0 }, { x: 100000, y: 0 }], { radius: 500, maxStamps: 25 });
    expect(stamps).toHaveLength(25);
    expect(walk.truncated).toBe(true);
  });
});

describe('verificationPoints', () => {
  it('covers both ends of the path', () => {
    const points = geometry.verificationPoints([{ x: 0, y: 0 }, { x: 90, y: 0 }], [0], 10);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 90, y: 0 });
  });

  it('samples a bounded number of points regardless of path length', () => {
    const long = Array.from({ length: 4000 }, (_, i) => ({ x: i, y: 0 }));
    const points = geometry.verificationPoints(long, [0], 10);
    expect(points.length).toBeLessThan(long.length / 2);
    expect(points.length).toBeGreaterThan(1);
  });
});

describe('buildStroke', () => {
  it('treats brushSize as a diameter', () => {
    const stroke = geometry.buildStroke([move(0, 0), line(80, 0)], undefined, { brushSize: 20 });
    expect(stroke.radius).toBe(10);
    expect(stroke.stamps[0]!.r).toBe(10);
  });

  it('rasterizes a flat point list as a single subpath', () => {
    const stroke = geometry.buildStroke(undefined, [{ x: 0, y: 0 }, { x: 50, y: 0 }], { brushSize: 4 });
    expect(stroke.starts).toEqual([0]);
    expect(stroke.stamps.length).toBeGreaterThan(1);
  });

  it('verifies along the same geometry it drew', () => {
    const stroke = geometry.buildStroke([move(0, 0), line(100, 0)], undefined, { brushSize: 10 });
    const xs = stroke.verificationPoints.map((p) => p.x);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(100);
  });

  it('keeps the 0-100 smoothing dial from exploding into an unbounded pass count', () => {
    // Each Chaikin pass roughly doubles the point count, so a raw pass count
    // would turn `smoothing: 100` into 2^100 points and hang the host. The dial
    // has to stay bounded, and still smooth.
    const jaggy = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: 0 },
    ];
    const raw = geometry.buildStroke(undefined, jaggy, { brushSize: 4 });
    const maxed = geometry.buildStroke(undefined, jaggy, { brushSize: 4, smoothing: 100 });

    expect(maxed.points.length).toBeLessThan(64);
    expect(maxed.points.length).toBeGreaterThan(raw.points.length);
    expect(maxed.stamps.length).toBeLessThanOrEqual(4000);
  });

  it('honours smoothing rather than dropping it', () => {
    const jaggy = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: 0 },
      { x: 30, y: 20 },
      { x: 40, y: 0 },
    ];
    const raw = geometry.buildStroke(undefined, jaggy, { brushSize: 4 });
    const smoothed = geometry.buildStroke(undefined, jaggy, { brushSize: 4, smoothing: 3 });
    expect(smoothed.points.length).toBeGreaterThan(raw.points.length);
  });

  it('produces no stamps for an empty path, so the caller can refuse cleanly', () => {
    expect(geometry.buildStroke([], undefined, { brushSize: 10 }).stamps).toHaveLength(0);
  });
});

describe('pressureAt', () => {
  it('is zero at both ends and one in the middle', () => {
    expect(geometry.pressureAt(0)).toBeCloseTo(0, 6);
    expect(geometry.pressureAt(1)).toBeCloseTo(0, 6);
    expect(geometry.pressureAt(0.5)).toBeCloseTo(1, 6);
  });

  it('is clamped outside 0..1', () => {
    expect(geometry.pressureAt(-3)).toBeCloseTo(0, 6);
    expect(geometry.pressureAt(7)).toBeCloseTo(0, 6);
  });
});