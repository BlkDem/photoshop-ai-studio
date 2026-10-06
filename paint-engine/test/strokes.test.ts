/**
 * Stroke primitive and generator tests.
 *
 * The properties asserted here are the ones that decide whether a generated
 * painting reads as paint: marks stay inside their region, marks are continuous
 * rather than a scatter of disconnected fragments, counts are respected, and the
 * whole thing is reproducible from a seed.
 */

import { describe, expect, it } from 'vitest';
import {
  PRIMITIVES,
  arc,
  cloud,
  crossHatching,
  curve,
  dabs,
  glaze,
  hatching,
  highlight,
  line,
  scatteredDabs,
  wave,
  type Path,
} from '../src/strokes/primitives.js';
import { StrokeGenerator } from '../src/strokes/generator.js';
import { Rng } from '../src/random.js';
import type { PaintingPlan, PlanStage, StrokeRecipe } from '../src/types.js';

const REGION = { x: 0.1, y: 0.1, width: 0.5, height: 0.4 };

function pathsIn(
  fn: (recipe: StrokeRecipe, rng: Rng) => Path[],
  recipe: Partial<StrokeRecipe> = {},
): Path[] {
  return fn({ primitive: 'line', region: REGION, ...recipe }, new Rng(11));
}

/** Longest gap between consecutive points, as a fraction of the region diagonal. */
function maxGap(path: Path, region = REGION): number {
  const diagonal = Math.hypot(region.width, region.height);
  let worst = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;
    worst = Math.max(worst, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return worst / diagonal;
}

describe('primitives stay inside their region', () => {
  const cases: [string, (r: StrokeRecipe, g: Rng) => Path[], Partial<StrokeRecipe>][] = [
    ['line', line, {}],
    ['curve', curve, {}],
    ['wave', wave, {}],
    ['arc', arc, {}],
    ['cloud', cloud, {}],
    ['highlight', highlight, {}],
  ];

  for (const [name, fn, extra] of cases) {
    it(`${name} stays within the region plus a small margin`, () => {
      for (const path of pathsIn(fn, extra)) {
        for (const point of path) {
          expect(point.x).toBeGreaterThan(REGION.x - 0.06);
          expect(point.x).toBeLessThan(REGION.x + REGION.width + 0.06);
          expect(point.y).toBeGreaterThan(REGION.y - 0.06);
          expect(point.y).toBeLessThan(REGION.y + REGION.height + 0.06);
        }
      }
    });
  }
});

describe('glaze covers its region rather than staying inside it', () => {
  it('sweeps past the edges so the whole region is washed', () => {
    const paths = pathsIn(glaze);
    expect(paths.length).toBeGreaterThan(0);
    const xs = paths.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(REGION.x);
    expect(Math.max(...xs)).toBeGreaterThan(REGION.x + REGION.width);
  });

  it('is continuous', () => {
    for (const path of pathsIn(glaze)) {
      expect(maxGap(path)).toBeLessThan(0.15);
    }
  });
});

describe('primitives produce continuous marks', () => {
  it('line is continuous rather than a scatter of points', () => {
    for (const path of pathsIn(line)) {
      expect(maxGap(path)).toBeLessThan(0.12);
    }
  });

  it('wave is continuous', () => {
    for (const path of pathsIn(wave)) {
      expect(maxGap(path)).toBeLessThan(0.12);
    }
  });

  it('dabs are short two-point marks', () => {
    const paths = pathsIn(dabs, { count: 5 });
    expect(paths).toHaveLength(5);
    for (const path of paths) {
      expect(path).toHaveLength(2);
    }
  });
});

describe('wave shape responds to its parameters', () => {
  it('higher frequency gives more crossings', () => {
    const crossings = (frequency: number): number => {
      const path = pathsIn(wave, { frequency })[0];
      if (!path) return 0;
      let changes = 0;
      for (let i = 2; i < path.length; i += 1) {
        const a = path[i - 1];
        const b = path[i];
        const c = path[i - 2];
        if (!a || !b || !c) continue;
        const d1 = a.y - c.y;
        const d2 = b.y - a.y;
        if (d1 * d2 < 0) changes += 1;
      }
      return changes;
    };
    expect(crossings(6)).toBeGreaterThan(crossings(1));
  });

  it('higher amplitude gives a larger excursion', () => {
    const excursion = (amplitude: number): number => {
      const path = pathsIn(wave, { amplitude })[0];
      if (!path) return 0;
      const ys = path.map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(excursion(0.2)).toBeGreaterThan(excursion(0.02));
  });

  it('damps the oscillation at both ends so it does not end abruptly', () => {
    const path = pathsIn(wave, { amplitude: 0.5, frequency: 4 })[0];
    if (!path) throw new Error('wave produced no path');
    const spine = REGION.y + REGION.height / 2;
    const excursion = Math.abs(path[0]!.y - spine);
    let peak = 0;
    for (const point of path) peak = Math.max(peak, Math.abs(point.y - spine));
    expect(excursion).toBeLessThan(peak * 0.5);
  });
});

describe('counting primitives honour count', () => {
  it('hatching emits exactly count lines', () => {
    expect(pathsIn(hatching, { count: 12 })).toHaveLength(12);
  });

  it('crossHatching emits twice count', () => {
    expect(pathsIn(crossHatching, { count: 6 })).toHaveLength(12);
  });

  it('scatteredDabs emits count', () => {
    expect(pathsIn(scatteredDabs, { count: 30 })).toHaveLength(30);
  });
});

describe('scatter is genuinely scattered', () => {
  it('produces varied positions, lengths and angles', () => {
    const paths = pathsIn(scatteredDabs, { count: 40, jitter: 0.6 });
    const angles = paths.map((path) => {
      const a = path[0];
      const b = path[1];
      if (!a || !b) return 0;
      return Math.atan2(b.y - a.y, b.x - a.x);
    });
    const unique = new Set(angles.map((a) => a.toFixed(3)));
    expect(unique.size).toBeGreaterThan(20);
  });
});

describe('primitive table', () => {
  it('covers every primitive the schema allows', () => {
    expect(Object.keys(PRIMITIVES).sort()).toEqual([
      'arc',
      'cloud',
      'crossHatching',
      'curve',
      'dabs',
      'glaze',
      'hatching',
      'highlight',
      'line',
      'scatteredDabs',
      'wave',
    ]);
  });
});

// --------------------------------------------------------------------------

const PLAN: PaintingPlan = {
  title: 'test',
  canvas: { width: 1920, height: 1080 },
  style: {
    medium: 'oil',
    brushCharacter: 'layered',
    contrast: 'high',
    atmosphere: 'storm',
    texture: 'moderate',
    edgeCharacter: 'soft',
    colorTemperature: 'cool',
    detailLevel: 0.6,
  },
  composition: {
    framework: 'ruleOfThirds',
    horizon: 0.62,
    focalPoint: { x: 0.68, y: 0.58 },
    regions: {},
    negativeSpace: 0.4,
  },
  palette: {
    shadows: ['#102a3b'],
    midtones: ['#285c76'],
    highlights: ['#b9d6d8'],
    accents: ['#c05a3a'],
    base: ['#173b58'],
  },
  layers: ['Waves'],
  stages: [],
  seed: 1234,
  maxIterations: 3,
};

const STAGE: PlanStage = {
  id: 'waves-main',
  layer: 'Waves',
  purpose: 'Establish large wave masses',
  brush: 'oil_large',
  depth: 'midground',
  palette: ['#173B58', '#275A78', '#456F85'],
  density: 0.7,
  detail: 0.4,
  progress: 0.45,
  strokes: [
    { primitive: 'wave', region: { x: 0, y: 0.6, width: 1, height: 0.4 }, colorRole: 'midtones' },
    { primitive: 'dabs', region: { x: 0.3, y: 0.6, width: 0.4, height: 0.3 }, count: 12, colorRole: 'highlights' },
  ],
};

describe('StrokeGenerator', () => {
  it('resolves brush, colour and depth for every stroke', () => {
    const strokes = new StrokeGenerator({ plan: PLAN, stage: STAGE }).generateStage();
    expect(strokes.length).toBeGreaterThan(1);
    for (const stroke of strokes) {
      expect(stroke.brush).toBe('oil_large');
      expect(stroke.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(stroke.depth).toBe('midground');
    }
  });

  it('is deterministic for a given seed', () => {
    const a = new StrokeGenerator({ plan: PLAN, stage: STAGE }).generateStage();
    const b = new StrokeGenerator({ plan: PLAN, stage: STAGE }).generateStage();
    expect(a).toEqual(b);
  });

  it('changes with the seed', () => {
    const a = new StrokeGenerator({ plan: PLAN, stage: STAGE }).generateStage();
    const b = new StrokeGenerator({
      plan: { ...PLAN, seed: 9999 },
      stage: STAGE,
    }).generateStage();
    expect(a).not.toEqual(b);
  });

  it('scales mark count with density', () => {
    const sparse = new StrokeGenerator({ plan: PLAN, stage: { ...STAGE, density: 0.25 } }).generateStage();
    const dense = new StrokeGenerator({ plan: PLAN, stage: { ...STAGE, density: 1 } }).generateStage();
    expect(dense.length).toBeGreaterThan(sparse.length);
  });

  it('softens background marks relative to foreground ones', () => {
    const far = new StrokeGenerator({ plan: PLAN, stage: { ...STAGE, depth: 'background' } }).generateStage();
    const near = new StrokeGenerator({ plan: PLAN, stage: { ...STAGE, depth: 'foreground' } }).generateStage();
    const first = far[0];
    const second = near[0];
    expect(first?.opacity).toBeLessThan(second?.opacity ?? 0);
    expect(first?.tip.core).toBeLessThan(second?.tip.core ?? 1);
  });

  it('estimates exactly what the generator builds, density included', () => {
    // The estimate drives the progress bar, so any drift from the real count
    // makes the bar lie. Equality is the only acceptable relationship.
    const actual = new StrokeGenerator({ plan: PLAN, stage: STAGE }).generateStage().length;
    expect(StrokeGenerator.estimate(STAGE)).toBe(actual);
  });

  it('estimates scale with density', () => {
    const dense = StrokeGenerator.estimate({ ...STAGE, density: 1 });
    const sparse = StrokeGenerator.estimate({ ...STAGE, density: 0.2 });
    expect(dense).toBeGreaterThan(sparse);
  });

  it('returns nothing for a primitive it does not know', () => {
    const strokes = new StrokeGenerator({ plan: PLAN, stage: STAGE }).generate(
      { primitive: 'spiral' as never, region: REGION },
      0,
    );
    expect(strokes).toEqual([]);
  });
});
describe('recipe energy reaches the brush', () => {
  const stage = (recipe: StrokeRecipe): PlanStage => ({
    id: 's',
    layer: 'L',
    purpose: 'p',
    brush: 'soft_blend',
    depth: 'midground',
    palette: ['midtones'],
    density: 1,
    detail: 0.5,
    progress: 0.5,
    strokes: [recipe],
  });

  const plan: PaintingPlan = {
    title: 't',
    canvas: { width: 100, height: 100 },
    style: {
      medium: 'oil',
      brushCharacter: 'oil',
      contrast: 'medium',
      atmosphere: 'a',
      texture: 'moderate',
      edgeCharacter: 'mixed',
      colorTemperature: 'neutral',
      detailLevel: 0.5,
    },
    composition: { framework: 'center', horizon: 0.5, focalPoint: { x: 0.5, y: 0.5 }, regions: {} },
    palette: { shadows: ['#000000'], midtones: ['#808080'], highlights: ['#ffffff'], accents: ['#ff0000'], base: ['#808080'] },
    layers: ['L'],
    stages: [stage({ primitive: 'line', region: REGION, colorRole: 'midtones' })],
    seed: 1,
    maxIterations: 1,
  };

  const opacityAt = (energy: number | undefined): number => {
    const s = stage({ primitive: 'line', region: REGION, colorRole: 'midtones', ...(energy === undefined ? {} : { energy }) });
    return new StrokeGenerator({ plan, stage: s, seed: 3 }).generateStage()[0]!.opacity;
  };

  it('uses the brush weight when a recipe states no energy', () => {
    // No energy means "paint it as this brush paints", not "paint it at zero" —
    // otherwise every recipe written before energy was honoured would go mute.
    expect(opacityAt(undefined)).toBeGreaterThan(0);
    expect(opacityAt(undefined)).toBeGreaterThan(opacityAt(0.5));
  });

  it('lets a recipe mute a mark entirely', () => {
    expect(opacityAt(0)).toBe(0);
  });

  it('lays a mark down harder as energy rises', () => {
    expect(opacityAt(1)).toBeGreaterThan(opacityAt(0.5));
    expect(opacityAt(0.5)).toBeGreaterThan(opacityAt(0.2));
  });

  it('keeps the strongest mark at or below the brush ceiling', () => {
    expect(opacityAt(1)).toBeLessThanOrEqual(1);
  });
});
