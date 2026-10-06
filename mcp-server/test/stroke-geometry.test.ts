import { describe, expect, it } from 'vitest';

import { loadPluginFile } from '../../photoshop-plugin/test/harness.js';
import {
  flattenSegments,
  overlapDivisor,
  rasterizeStamps,
  ringFillAlpha,
  smoothingIterations,
  smoothPoints,
  dropDuplicatePoints,
  pressureAt,
  stampSpacing,
  tipRings,
  type FlatPath,
  type Segment,
} from '../src/adapter/stroke-geometry.js';

/**
 * The mock and the plugin both implement stroke rasterization, and they have to
 * agree exactly — the mock is where a drawing plan is rehearsed, so a
 * disagreement here is a plan that works in the mock and fails in Photoshop.
 *
 * They cannot share code (the plugin is build-free CommonJS for a UXP host, and
 * `shared` may not depend on it), so they are held together by this test instead:
 * every case below runs through both and compares the stamps they emit.
 *
 * The plugin file is loaded through the shared harness rather than a plain
 * `require`: the repository root declares `"type": "module"`, so Node's ESM
 * loader would reject the plugin's CommonJS. The harness wraps the source the way
 * Photoshop does.
 */
const plugin = loadPluginFile('lib/ops/stroke-geometry.js') as unknown as {
  buildStroke(
    segments?: Segment[],
    points?: Array<{ x: number; y: number }>,
    options?: {
      brushSize?: number;
      smoothing?: number;
      simulatePressure?: boolean;
      maxStamps?: number;
      spacing?: number;
    },
  ): { points: Array<{ x: number; y: number }>; starts: number[]; stamps: Array<{ x: number; y: number; r: number }> };
};

const pluginGeometry = loadPluginFile('lib/ops/stroke-geometry.js') as unknown as {
  tipRings(radius: number, tip: unknown): Array<{ radius: number; weight: number }>;
  overlapDivisor(radius: number, spacing: number, steps: number): number;
  ringFillAlpha(opacity: number, radius: number, spacing: number, steps: number, weight: number): number;
};

/**
 * Normalises a stamp list for comparison: drops the plugin's extra pressure
 * field and rounds, because the two implementations accumulate the walking
 * distance in a different order and land a float's last bit apart.
 */
const geometry = (stamps: Array<{ x: number; y: number; r: number }>) =>
  stamps.map(({ x, y, r }) => ({ x: round(x), y: round(y), r: round(r) }));

interface Case {
  name: string;
  segments?: Segment[];
  points?: Array<{ x: number; y: number }>;
  brushSize?: number;
  smoothing?: number;
  simulatePressure?: boolean;
}

const CASES: Case[] = [
  {
    name: 'a straight horizontal line',
    segments: [
      { type: 'move', point: { x: 20, y: 100 } },
      { type: 'line', point: { x: 380, y: 100 } },
    ],
  },
  {
    name: 'a diagonal line',
    segments: [
      { type: 'move', point: { x: 10, y: 10 } },
      { type: 'line', point: { x: 300, y: 280 } },
    ],
    brushSize: 12,
  },
  {
    name: 'a cubic curve, which must start from the previous endpoint',
    segments: [
      { type: 'move', point: { x: 20, y: 20 } },
      { type: 'curve', cp1: { x: 120, y: 260 }, cp2: { x: 280, y: 260 }, point: { x: 380, y: 20 } },
    ],
    brushSize: 16,
  },
  {
    name: 'two curves in a row',
    segments: [
      { type: 'move', point: { x: 10, y: 150 } },
      { type: 'curve', cp1: { x: 60, y: 40 }, cp2: { x: 120, y: 260 }, point: { x: 180, y: 150 } },
      { type: 'curve', cp1: { x: 240, y: 40 }, cp2: { x: 300, y: 260 }, point: { x: 370, y: 150 } },
    ],
    smoothing: 2,
  },
  {
    name: 'two separate marks, which must not be joined',
    segments: [
      { type: 'move', point: { x: 20, y: 20 } },
      { type: 'line', point: { x: 120, y: 20 } },
      { type: 'move', point: { x: 300, y: 280 } },
      { type: 'line', point: { x: 380, y: 280 } },
    ],
  },
  {
    name: 'a mark and a dot, in one path',
    segments: [
      { type: 'move', point: { x: 40, y: 40 } },
      { type: 'line', point: { x: 200, y: 40 } },
      { type: 'move', point: { x: 300, y: 200 } },
    ],
  },
  {
    name: 'a path that opens with a line rather than a move',
    segments: [{ type: 'line', point: { x: 50, y: 50 } }, { type: 'line', point: { x: 200, y: 200 } }],
  },
  {
    name: 'a curve with no control points, which degrades to its endpoint',
    segments: [
      { type: 'move', point: { x: 10, y: 10 } },
      { type: 'curve', point: { x: 200, y: 200 } },
    ],
  },
  {
    name: 'repeated identical points',
    segments: [
      { type: 'move', point: { x: 100, y: 100 } },
      { type: 'line', point: { x: 100, y: 100 } },
      { type: 'line', point: { x: 100, y: 100 } },
      { type: 'line', point: { x: 300, y: 100 } },
    ],
  },
  {
    name: 'an empty path',
    segments: [],
  },
  {
    name: 'freehand points',
    points: [
      { x: 40, y: 40 },
      { x: 90, y: 60 },
      { x: 160, y: 40 },
      { x: 230, y: 60 },
      { x: 300, y: 40 },
    ],
    smoothing: 3,
  },
  {
    name: 'a single freehand point, which is a dot',
    points: [{ x: 120, y: 120 }],
  },
  {
    name: 'no points at all',
    points: [],
  },
  {
    name: 'simulated pressure on a curve',
    segments: [
      { type: 'move', point: { x: 30, y: 200 } },
      { type: 'curve', cp1: { x: 130, y: 40 }, cp2: { x: 270, y: 40 }, point: { x: 370, y: 200 } },
    ],
    brushSize: 40,
    simulatePressure: true,
  },
  {
    name: 'simulated pressure across two separate marks',
    segments: [
      { type: 'move', point: { x: 20, y: 60 } },
      { type: 'line', point: { x: 140, y: 60 } },
      { type: 'move', point: { x: 240, y: 240 } },
      { type: 'line', point: { x: 380, y: 240 } },
    ],
    brushSize: 30,
    simulatePressure: true,
  },
  {
    name: 'heavy smoothing on a zig-zag',
    segments: [
      { type: 'move', point: { x: 20, y: 150 } },
      { type: 'line', point: { x: 90, y: 60 } },
      { type: 'line', point: { x: 160, y: 150 } },
      { type: 'line', point: { x: 230, y: 60 } },
      { type: 'line', point: { x: 300, y: 150 } },
    ],
    smoothing: 3,
    brushSize: 14,
  },
];

/** The mock's stamp list for a case, rounded so float noise is not a failure. */
function mockStamps(testCase: Case): Array<{ x: number; y: number; r: number }> {
  const path: FlatPath = testCase.points
    ? { points: testCase.points.map((p) => ({ ...p })), starts: testCase.points.length > 0 ? [0] : [] }
    : flattenSegments(testCase.segments ?? []);

  return rasterizeStamps(
    path,
    Math.max(0.5, (testCase.brushSize ?? 5) / 2),
    testCase.smoothing ?? 0,
    testCase.simulatePressure === true,
    4000,
  ).map((s) => ({ x: round(s.x), y: round(s.y), r: round(s.r) }));
}

/** The plugin's stamp list for the same case, through its own entry point. */
function pluginStamps(testCase: Case): Array<{ x: number; y: number; r: number }> {
  const stroke = plugin.buildStroke(testCase.segments, testCase.points, {
    brushSize: testCase.brushSize ?? 5,
    smoothing: testCase.smoothing ?? 0,
    simulatePressure: testCase.simulatePressure === true,
  });

  return stroke.stamps.map((s) => ({ x: round(s.x), y: round(s.y), r: round(s.r) }));
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

describe('mock stroke geometry agrees with the plugin', () => {
  for (const testCase of CASES) {
    it(`emits the same stamps for ${testCase.name}`, () => {
      expect(mockStamps(testCase)).toEqual(pluginStamps(testCase));
    });
  }

  it('covers every case with at least one stamp unless the path is empty', () => {
    // Guards against the table silently rotting: if a "path" stopped producing
    // ink on both sides, the comparisons above would keep passing while testing
    // nothing.
    const withStamps = CASES.filter((c) => pluginStamps(c).length > 0);
    expect(withStamps.length).toBe(CASES.length - 2);
  });
});

describe('the disagreements this test exists to catch', () => {
  it('does not start a curve at its own endpoint', () => {
    // The bug this guards against: using `segment.point` as *both* ends of the
    // cubic, which draws a curve that leaves the endpoint instead of one that
    // arrives at it. Hand-rolled here so the comparison is against the actual
    // mistake rather than a reimplementation of the right answer.
    const from = { x: 20, y: 20 };
    const cp1 = { x: 120, y: 260 };
    const cp2 = { x: 280, y: 260 };
    const to = { x: 380, y: 20 };

    const wrong = [{ x: to.x, y: to.y }];
    for (let i = 1; i <= 24; i += 1) {
      const t = i / 24;
      const mt = 1 - t;
      wrong.push({
        x: mt * mt * mt * to.x + 3 * mt * mt * t * cp1.x + 3 * mt * t * t * cp2.x + t * t * t * to.x,
        y: mt * mt * mt * to.y + 3 * mt * mt * t * cp1.y + 3 * mt * t * t * cp2.y + t * t * t * to.y,
      });
    }

    const right = flattenSegments([
      { type: 'move', point: from },
      { type: 'curve', cp1, cp2, point: to },
    ]).points;

    // Both versions end at the endpoint, so only the middle separates them. The
    // control points are left/right symmetric about x=200, so each curve reaches
    // its widest bulge at t=0.5 — the wrong one does so 45px to the right,
    // because it started from the endpoint instead of from the pen.
    const rightMiddle = right[Math.floor(right.length / 2)]!;
    const wrongMiddle = wrong[Math.floor(wrong.length / 2)]!;
    expect(Math.abs(rightMiddle.y - 200)).toBeLessThan(5);
    expect(Math.abs(wrongMiddle.y - 200)).toBeLessThan(5);
    expect(Math.abs(rightMiddle.x - wrongMiddle.x)).toBeGreaterThan(30);

    // And the correct flattening leaves the pen's own position behind it.
    expect(Math.abs(right[1]!.x - from.x)).toBeLessThan(20);
  });

  it('keeps a move as a subpath boundary so marks are not joined', () => {
    const path = flattenSegments([
      { type: 'move', point: { x: 20, y: 20 } },
      { type: 'line', point: { x: 120, y: 20 } },
      { type: 'move', point: { x: 300, y: 280 } },
      { type: 'line', point: { x: 380, y: 280 } },
    ]);

    expect(path.starts).toEqual([0, 2]);

    const stamps = rasterizeStamps(path, 5, 0, false, 4000);
    // Bridging the gap would force every stamp along the diagonal between the
    // two marks, so a diagonal crossing the middle of the canvas is the tell.
    const crossesTheGap = stamps.some((s) => s.x > 150 && s.x < 280 && s.y > 100 && s.y < 220);
    expect(crossesTheGap).toBe(false);
  });

  it('does not smooth across a move', () => {
    const points = [
      { x: 20, y: 20 },
      { x: 200, y: 20 },
      { x: 200, y: 120 },
      { x: 380, y: 280 },
      { x: 380, y: 200 },
    ];
    const smoothed = smoothPoints({ points, starts: [0, 3] }, 3);

    // Smoothing is meant to round corners *inside* a subpath, so the corner at
    // (200,20) legitimately loses its sharpness. What must not happen is the
    // gap being consumed: each subpath's endpoints are fixed points of the
    // scheme, so the pen-up gap and its two far corners all survive.
    expect(smoothed.starts).toHaveLength(2);
    for (const keep of [
      { x: 20, y: 20 },
      { x: 200, y: 120 },
      { x: 380, y: 280 },
      { x: 380, y: 200 },
    ]) {
      expect(smoothed.points).toContainEqual(keep);
    }

    // No interpolated point may sit in the pen-up gap.
    expect(smoothed.points.some((p) => p.x > 210 && p.x < 370 && p.y > 130 && p.y < 270)).toBe(false);
  });

  it('maps the 0-100 smoothing dial onto a bounded pass count', () => {
    // `smoothing` is a dial, not a pass count. Feeding it in raw would double
    // the point list once per unit, so the mock would hang exactly where the
    // plugin hangs — or, worse, survive where the plugin does not and make
    // this cross-check meaningless.
    expect(smoothingIterations(0)).toBe(0);
    expect(smoothingIterations(-5)).toBe(0);
    expect(smoothingIterations(Number.NaN)).toBe(0);
    expect(smoothingIterations(1)).toBe(1);
    expect(smoothingIterations(50)).toBe(2);
    expect(smoothingIterations(100)).toBe(4);

    const jaggy: FlatPath = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
        { x: 20, y: 0 },
      ],
      starts: [0],
    };
    const raw = rasterizeStamps(jaggy, 2, 0, false, 4000);
    const maxed = rasterizeStamps(jaggy, 2, 100, false, 4000);

    expect(maxed.length).toBeGreaterThan(raw.length);
    expect(maxed.length).toBeLessThanOrEqual(4000);
  });
});

describe('shared helpers', () => {
  it('drops duplicate points without dropping a subpath start', () => {
    const cleaned = dropDuplicatePoints(
      {
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0.001, y: 0 },
          { x: 50, y: 0 },
          { x: 50, y: 0 },
        ],
        starts: [0, 3],
      },
      0.01,
    );

    // Everything repeats, so the second subpath collapses to a single point —
    // but it collapses *as a subpath*, keeping its boundary rather than merging
    // into the first run.
    expect(cleaned.points).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
    expect(cleaned.starts).toEqual([0, 1]);
  });

  it('ramps pressure symmetrically from zero at both ends', () => {
    expect(pressureAt(0)).toBeCloseTo(0, 6);
    expect(pressureAt(0.5)).toBeCloseTo(1, 6);
    expect(pressureAt(1)).toBeCloseTo(0, 6);
    expect(pressureAt(0.25)).toBeCloseTo(pressureAt(0.75), 6);
  });

  it('always spaces discs closer than their radius', () => {
    for (const radius of [0.5, 1, 3, 20, 400]) {
      expect(stampSpacing(radius)).toBeLessThanOrEqual(radius);
      expect(stampSpacing(radius)).toBeGreaterThan(0);
    }
  });
});

/**
 * Tips and spacing: the same agreement test, extended.
 *
 * The soft edge is the one place the mock and the plugin can visibly disagree —
 * the mock is where a painting is rehearsed and previewed, so a ring stack that
 * drifts between the two implementations means the user watches a picture that
 * is not the one they get. Both implementations are compared here rather than
 * trusted.
 */
const TIP_CASES = [
  { name: 'flat', tip: { core: 1, steps: 1, outerAlpha: 1 } },
  { name: 'soft', tip: { core: 0.18, steps: 4, outerAlpha: 0.18 } },
  { name: 'dry', tip: { core: 0.34, steps: 4, outerAlpha: 0.12 } },
  { name: 'glaze', tip: { core: 0.12, steps: 4, outerAlpha: 0.1 } },
  { name: 'no tip', tip: undefined },
];

describe('plugin and mock agree on spacing', () => {
  it('produces identical stamps for every density', () => {
    const path: FlatPath = {
      points: [
        { x: 10, y: 10 },
        { x: 120, y: 60 },
        { x: 260, y: 40 },
      ],
      starts: [0],
    };

    for (const spacing of [0.1, 0.2, 0.28, 0.4, 0.7, 1]) {
      const fromMock = rasterizeStamps(path, 12, 0, false, 4000, spacing);
      const fromPlugin = plugin.buildStroke(undefined, path.points, {
        brushSize: 24,
        maxStamps: 4000,
        spacing,
      }).stamps;
      // Normalised to x/y/r: the plugin also carries a `p` pressure field the
      // mock does not, which is a shape difference rather than a disagreement.
      expect(geometry(fromPlugin)).toEqual(geometry(fromMock));
    }
  });

  it('leaves stamps untouched when no density is given', () => {
    const path: FlatPath = {
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
      starts: [0],
    };
    expect(geometry(plugin.buildStroke(undefined, path.points, { brushSize: 16 }).stamps)).toEqual(
      geometry(rasterizeStamps(path, 8, 0, false, 4000)),
    );
  });
});

describe('plugin and mock agree on tips', () => {
  it('builds the same ring stack', () => {
    for (const { name, tip } of TIP_CASES) {
      const fromMock = tipRings(50, tip ?? null);
      const fromPlugin = pluginGeometry.tipRings(50, tip ?? null);
      expect(fromPlugin, name).toEqual(fromMock);
    }
  });

  it('orders rings largest first in both', () => {
    for (const { name, tip } of TIP_CASES) {
      const rings = tipRings(50, tip ?? null);
      for (let i = 1; i < rings.length; i += 1) {
        expect(rings[i]!.radius, name).toBeLessThanOrEqual(rings[i - 1]!.radius);
      }
    }
  });

  it('computes the same ring alpha', () => {
    for (const { name, tip } of TIP_CASES) {
      const steps = tip?.steps ?? 1;
      for (const weight of [1, 0.5, 0.15]) {
        for (const opacity of [0.25, 0.6, 1]) {
          const fromMock = ringFillAlpha(opacity, 50, 0.3, steps, weight);
          const fromPlugin = pluginGeometry.ringFillAlpha(opacity, 50, 0.3, steps, weight);
          expect(fromPlugin, `${name} w=${weight} o=${opacity}`).toBeCloseTo(fromMock, 12);
        }
      }
    }
  });

  it('computes the same overlap divisor', () => {
    for (const steps of [1, 2, 4, 8]) {
      for (const radius of [1, 10, 200]) {
        expect(pluginGeometry.overlapDivisor(radius, 0.3, steps)).toBeCloseTo(
          overlapDivisor(radius, 0.3, steps),
          12,
        );
      }
    }
  });
});
