/**
 * Composition, layer-stack and validation tests.
 *
 * Composition is worth testing precisely because its failures are invisible: a
 * horizon at 0.5 instead of 0.62 produces no error, no exception and no warning,
 * just a blander picture.
 */

import { describe, expect, it } from 'vitest';
import {
  CompositionEngine,
  chooseFocalPoint,
  chooseHorizon,
  depthBands,
  frameworkFocalPoints,
} from '../src/composition/engine.js';
import { planLayers, paintOrder, stackOrder } from '../src/layers/strategy.js';
import { PlanValidationError, validatePaintingPlan } from '../src/validation.js';
import { Rng } from '../src/random.js';
import type { PaintingPlan } from '../src/types.js';

describe('frameworks', () => {
  it('rule of thirds defines four intersections', () => {
    expect(frameworkFocalPoints('ruleOfThirds')).toHaveLength(4);
    expect(frameworkFocalPoints('ruleOfThirds')).toContainEqual({ x: 1 / 3, y: 1 / 3 });
  });

  it('golden ratio sits at 0.382 and 0.618', () => {
    const xs = frameworkFocalPoints('goldenRatio').map((p) => p.x);
    expect(xs).toContain(0.382);
    expect(xs).toContain(0.618);
  });

  it('centre offers exactly one point, and it is the centre', () => {
    expect(frameworkFocalPoints('center')).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it('diagonal favours the corners', () => {
    const points = frameworkFocalPoints('diagonal');
    expect(points.some((p) => p.x < 0.35 && p.y > 0.65)).toBe(true);
  });
});

describe('chooseFocalPoint', () => {
  it('honours an explicit request', () => {
    expect(chooseFocalPoint('center', { x: 0.2, y: 0.8 }, new Rng(1))).toEqual({ x: 0.2, y: 0.8 });
  });

  it('does not sit exactly on the intersection when choosing for itself', () => {
    // A focal point dead on the third line reads as a diagram.
    let offset = false;
    for (let seed = 0; seed < 12; seed += 1) {
      const point = chooseFocalPoint('ruleOfThirds', undefined, new Rng(seed));
      const onGrid =
        (Math.abs(point.x - 1 / 3) < 1e-9 && Math.abs(point.y - 1 / 3) < 1e-9) ||
        (Math.abs(point.x - 2 / 3) < 1e-9 && Math.abs(point.y - 2 / 3) < 1e-9);
      if (!onGrid) offset = true;
    }
    expect(offset).toBe(true);
  });

  it('stays inside the canvas', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const point = chooseFocalPoint('ruleOfThirds', undefined, new Rng(seed));
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });
});

describe('chooseHorizon', () => {
  it('returns null when there is no ground plane', () => {
    expect(chooseHorizon('ruleOfThirds', undefined, false, new Rng(1))).toBeNull();
  });

  it('honours an explicit horizon', () => {
    expect(chooseHorizon('center', 0.4, true, new Rng(1))).toBe(0.4);
  });

  it('keeps an explicit null', () => {
    expect(chooseHorizon('ruleOfThirds', null, true, new Rng(1))).toBeNull();
  });

  it('places the horizon off the exact middle for a landscape', () => {
    const horizon = chooseHorizon('ruleOfThirds', undefined, true, new Rng(3));
    expect(horizon).not.toBeNull();
    expect(Math.abs((horizon ?? 0) - 0.5)).toBeGreaterThan(0.05);
  });

  it('stays inside the canvas', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const horizon = chooseHorizon('diagonal', undefined, true, new Rng(seed));
      expect(horizon).toBeGreaterThanOrEqual(0);
      expect(horizon).toBeLessThanOrEqual(1);
    }
  });
});

describe('depthBands', () => {
  it('fills the canvas height exactly', () => {
    const bands = depthBands(0.6);
    const top = bands.background;
    const mid = bands.midground;
    const near = bands.foreground;
    expect(top.y).toBe(0);
    expect(mid.y).toBeCloseTo(top.y + top.height, 6);
    expect(near.y).toBeCloseTo(mid.y + mid.height, 6);
    expect(near.y + near.height).toBeCloseTo(1, 6);
  });

  it('gives the foreground the tallest band', () => {
    const bands = depthBands(0.6);
    expect(bands.foreground.height).toBeGreaterThan(bands.midground.height);
    expect(bands.background.height).toBeGreaterThan(bands.midground.height);
  });

  it('copes with no horizon by overlapping bands', () => {
    const bands = depthBands(null);
    expect(bands.background.height).toBe(1);
  });
});

describe('CompositionEngine', () => {
  const engine = new CompositionEngine();

  it('resolves a vague brief into a total spec', () => {
    const spec = engine.resolve(undefined, new Rng(1), true);
    expect(spec.framework).toBe('ruleOfThirds');
    expect(spec.horizon).not.toBeNull();
    expect(spec.focalPoint).toBeDefined();
    expect(spec.regions['ground']).toBeDefined();
    expect(spec.regions['sky']).toBeDefined();
  });

  it('adds no ground band when the picture has no horizon', () => {
    const spec = engine.resolve({ horizon: null }, new Rng(1), false);
    expect(spec.horizon).toBeNull();
    expect(spec.regions['ground']).toBeUndefined();
  });

  it('keeps caller-supplied regions', () => {
    const spec = engine.resolve(
      { regions: { sky: { x: 0, y: 0, width: 1, height: 0.5 } } },
      new Rng(1),
      true,
    );
    expect(spec.regions['sky']?.height).toBe(0.5);
  });

  it('scales a subject up as it comes forward', () => {
    const region = { x: 0, y: 0.5, width: 1, height: 0.5 };
    const far = engine.subjectBox(region, 'background', new Rng(1));
    const near = engine.subjectBox(region, 'foreground', new Rng(1));
    expect(near.width).toBeGreaterThan(far.width);
  });
});

// --------------------------------------------------------------------------

const PLAN: PaintingPlan = {
  title: 'ocean',
  canvas: { width: 1920, height: 1080 },
  style: {
    medium: 'oil',
    brushCharacter: 'layered oil',
    contrast: 'high',
    atmosphere: 'dramatic',
    texture: 'moderate',
    edgeCharacter: 'soft',
    colorTemperature: 'cool',
    detailLevel: 0.7,
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
  layers: ['Waves', 'Foam', 'Highlights'],
  stages: [
    {
      id: 'waves',
      layer: 'Waves',
      purpose: 'Wave masses',
      brush: 'oil_large',
      depth: 'midground',
      palette: ['#173b58'],
      density: 0.7,
      detail: 0.4,
      progress: 0.25,
      strokes: [{ primitive: 'wave', region: { x: 0, y: 0.6, width: 1, height: 0.4 } }],
    },
    {
      id: 'foam',
      layer: 'Foam',
      purpose: 'Foam',
      brush: 'soft_blend',
      depth: 'foreground',
      palette: ['#b9d6d8'],
      density: 0.6,
      detail: 0.5,
      progress: 0.8,
      strokes: [{ primitive: 'cloud', region: { x: 0.2, y: 0.7, width: 0.6, height: 0.2 } }],
    },
    {
      id: 'highlight',
      layer: 'Highlights',
      purpose: 'Crest light',
      brush: 'oil_detail',
      depth: 'foreground',
      palette: ['#e4d7b2'],
      density: 0.4,
      detail: 0.9,
      progress: 0.95,
      strokes: [{ primitive: 'highlight', region: { x: 0.5, y: 0.6, width: 0.3, height: 0.2 } }],
    },
  ],
  seed: 7,
  maxIterations: 3,
};

describe('layer strategy', () => {
  it('paints in plan order', () => {
    expect(paintOrder(PLAN).map((l) => l.name)).toEqual(['Waves', 'Foam', 'Highlights']);
  });

  it('stacks in reverse, because Photoshop stacks the first layer lowest', () => {
    expect(stackOrder(PLAN).map((l) => l.name)).toEqual(['Highlights', 'Foam', 'Waves']);
  });

  it('groups stages that share a layer', () => {
    const grouped: PaintingPlan = {
      ...PLAN,
      stages: [
        { ...PLAN.stages[0]!, id: 'a', progress: 0.1 },
        { ...PLAN.stages[0]!, id: 'b', progress: 0.2 },
      ],
    };
    const entries = planLayers(grouped).entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]?.stages).toEqual(['a', 'b']);
  });

  it('keeps a declared layer that has no stage', () => {
    const spare: PaintingPlan = { ...PLAN, layers: [...PLAN.layers, 'Ship'] };
    expect(planLayers(spare).entries.map((l) => l.name)).toContain('Ship');
  });

  it('reports a stage whose layer was never declared', () => {
    const broken: PaintingPlan = {
      ...PLAN,
      stages: [{ ...PLAN.stages[0]!, layer: 'Ghost' }],
    };
    expect(planLayers(broken).undeclared).toContain('Ghost');
  });
});

describe('validatePaintingPlan', () => {
  it('accepts a well-formed plan', () => {
    expect(() => validatePaintingPlan(PLAN)).not.toThrow();
  });

  it('rejects a stage on an undeclared layer, naming the stage', () => {
    const broken: PaintingPlan = {
      ...PLAN,
      stages: [{ ...PLAN.stages[0]!, layer: 'Ghost' }],
    };
    expect(() => validatePaintingPlan(broken)).toThrow(PlanValidationError);
    try {
      validatePaintingPlan(broken);
    } catch (error) {
      expect((error as PlanValidationError).stageId).toBe('waves');
    }
  });

  it('rejects duplicate stage ids', () => {
    const broken: PaintingPlan = {
      ...PLAN,
      stages: [PLAN.stages[0]!, { ...PLAN.stages[0]!, progress: 0.3 }],
    };
    expect(() => validatePaintingPlan(broken)).toThrow(/duplicate stage id/);
  });

  it('rejects progress that goes backwards', () => {
    const broken: PaintingPlan = {
      ...PLAN,
      stages: [
        { ...PLAN.stages[0]!, progress: 0.8 },
        { ...PLAN.stages[1]!, progress: 0.2 },
        PLAN.stages[2]!,
      ],
    };
    expect(() => validatePaintingPlan(broken)).toThrow(/goes backwards/);
  });

  it('rejects a counted primitive with no count, naming the mark', () => {
    const broken: PaintingPlan = {
      ...PLAN,
      stages: [
        {
          ...PLAN.stages[0]!,
          strokes: [{ primitive: 'dabs', region: { x: 0, y: 0, width: 0.5, height: 0.5 } }],
        },
      ],
    };
    try {
      validatePaintingPlan(broken);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PlanValidationError);
      expect((error as PlanValidationError).stageId).toBe('waves');
      expect((error as PlanValidationError).strokeIndex).toBe(0);
    }
  });

  it('rejects a region that runs past the canvas', () => {
    const broken: PaintingPlan = {
      ...PLAN,
      stages: [
        {
          ...PLAN.stages[0]!,
          strokes: [{ primitive: 'wave', region: { x: 0.8, y: 0, width: 0.5, height: 0.5 } }],
        },
      ],
    };
    expect(() => validatePaintingPlan(broken)).toThrow(/past the canvas edge/);
  });

  it('rejects a malformed colour', () => {
    const broken = { ...PLAN, palette: { ...PLAN.palette, shadows: ['not-a-colour'] } };
    expect(() => validatePaintingPlan(broken)).toThrow(PlanValidationError);
  });

  it('rejects a plan with no stages', () => {
    expect(() => validatePaintingPlan({ ...PLAN, stages: [] })).toThrow(PlanValidationError);
  });
});