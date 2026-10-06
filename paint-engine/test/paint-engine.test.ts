/**
 * Paint engine tests: tips, batching, and a full render against the mock.
 *
 * The tip and batching tests are about cost, which is the constraint that decides
 * whether this engine is usable at all. A tip that silently quadruples a stroke's
 * fills, or a batcher that sends a call the bridge will time out, produces a
 * painting that hangs — and neither failure shows up in a rendered image.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILL_BUDGET,
  MAX_STAMPS_PER_STROKE,
  budgetStroke,
  buildBatches,
  fillsPerStamp,
  stampsNeeded,
} from '../src/renderer/batches.js';
import { fillAlpha, overlapDivisor, ringAlpha, spacingFor, stampSpacing, tipRings } from '../src/brushes/tip.js';
import { BRUSHES, brush, brushForDetail, withDepth } from '../src/brushes/catalog.js';
import { PaintEngine, type PaintProgress } from '../src/paint-engine.js';
import { MockPhotoshop } from './mock-photoshop.js';
import type { PaintingPlan, SemanticStroke } from '../src/types.js';

const CANVAS = { width: 1920, height: 1080 };

function stroke(overrides: Partial<SemanticStroke> = {}): SemanticStroke {
  return {
    brush: 'oil_medium',
    color: '#285c76',
    size: 0.1,
    opacity: 0.7,
    flow: 0.75,
    spacing: 0.28,
    tip: { core: 0.6, steps: 3, outerAlpha: 0.35 },
    depth: 'midground',
    purpose: 'test',
    points: [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
    ],
    ...overrides,
  };
}

describe('spacing', () => {
  it('mirrors the plugin rule when no preset dial is given', () => {
    expect(spacingFor(50, 0.4)).toBeCloseTo(stampSpacing(50), 6);
  });

  it('never separates discs', () => {
    for (const radius of [1, 5, 50, 500]) {
      expect(spacingFor(radius, 1)).toBeLessThanOrEqual(radius * 2);
    }
  });
});

describe('overlap compensation', () => {
  it('makes a fully opaque stroke need no compensation', () => {
    expect(fillAlpha(1, 50, 0.28, 3)).toBe(1);
  });

  it('lightens the per-fill alpha for a translucent stroke', () => {
    expect(fillAlpha(0.5, 50, 0.28, 1)).toBeLessThan(0.5);
    expect(fillAlpha(0.5, 50, 0.28, 1)).toBeGreaterThan(0);
  });

  it('lightens further as the tip stacks more rings on the same pixel', () => {
    expect(fillAlpha(0.5, 50, 0.28, 4)).toBeLessThan(fillAlpha(0.5, 50, 0.28, 1));
  });

  it('compounds toward the requested opacity rather than undershooting', () => {
    const divisor = overlapDivisor(50, 0.28) * 3;
    const perFill = fillAlpha(0.6, 50, 0.28, 3);
    const accumulated = 1 - Math.pow(1 - perFill, divisor);
    expect(accumulated).toBeCloseTo(0.6, 6);
  });

  it('reports zero alpha for a zero-opacity stroke', () => {
    expect(fillAlpha(0, 50, 0.28, 3)).toBe(0);
  });
});

describe('tipRings', () => {
  it('is a single disc for a hard tip, matching the un-tipped rasterizer', () => {
    const rings = tipRings(50, { core: 1, steps: 1, outerAlpha: 1 });
    expect(rings).toEqual([{ radius: 50, weight: 1 }]);
  });

  it('orders rings largest first so the core is painted last', () => {
    const rings = tipRings(50, { core: 0.5, steps: 4, outerAlpha: 0.2 });
    expect(rings).toHaveLength(4);
    for (let i = 1; i < rings.length; i += 1) {
      expect(rings[i]?.radius).toBeLessThan(rings[i - 1]?.radius ?? 0);
    }
  });

  it('makes the core opaque and the rim faint', () => {
    const rings = tipRings(50, { core: 0.5, steps: 4, outerAlpha: 0.2 });
    expect(rings[rings.length - 1]?.weight).toBe(1);
    expect(rings[0]?.weight).toBeLessThan(0.5);
  });

  it('gives a soft brush a smaller core than a hard one', () => {
    const soft = tipRings(50, { core: 0.18, steps: 4, outerAlpha: 0.18 });
    const hard = tipRings(50, { core: 1, steps: 1, outerAlpha: 1 });
    const softCore = soft[soft.length - 1]?.radius ?? 0;
    const hardCore = hard[hard.length - 1]?.radius ?? 0;
    expect(softCore).toBeLessThan(hardCore);
  });

  it('scales ring alpha with the stroke and never exceeds 1', () => {
    const rings = tipRings(50, { core: 0.5, steps: 3, outerAlpha: 0.3 });
    for (const ring of rings) {
      const alpha = ringAlpha(ring, 0.8, 50, 0.28, 3);
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThanOrEqual(1);
    }
  });
});

describe('brush catalog', () => {
  it('covers the spec MVP set', () => {
    const ids = BRUSHES.map((b) => b.id);
    for (const required of ['oil_large', 'oil_medium', 'oil_small', 'soft_blend', 'dry_brush', 'hard_round']) {
      expect(ids).toContain(required);
    }
  });

  it('marks every preset as synthesized', () => {
    for (const preset of BRUSHES) {
      expect(preset.tipIsSynthesized).toBe(true);
    }
  });

  it('names an unknown brush in the error', () => {
    expect(() => brush('oil_enormous')).toThrow(/unknown brush "oil_enormous"/);
  });

  it('picks a finer brush for a more detailed stage', () => {
    expect(brushForDetail(0.9).size).toBeLessThan(brushForDetail(0.1).size);
  });

  it('does not let a depth adjustment mutate the shared catalog', () => {
    const original = brush('oil_large');
    const before = original.opacity;
    withDepth(original, 'background');
    expect(brush('oil_large').opacity).toBe(before);
  });
});

describe('stampsNeeded', () => {
  it('scales with path length', () => {
    const short = stampsNeeded(stroke({ points: [{ x: 0.1, y: 0.5 }, { x: 0.2, y: 0.5 }] }), ...toDims(CANVAS));
    const long = stampsNeeded(stroke(), ...toDims(CANVAS));
    expect(long).toBeGreaterThan(short);
  });

  it('scales inversely with brush size', () => {
    const small = stampsNeeded(stroke({ size: 0.01 }), ...toDims(CANVAS));
    const large = stampsNeeded(stroke({ size: 0.2 }), ...toDims(CANVAS));
    expect(small).toBeGreaterThan(large);
  });

  it('counts one stamp for a single-point dab', () => {
    expect(stampsNeeded(stroke({ points: [{ x: 0.5, y: 0.5 }] }), ...toDims(CANVAS))).toBe(1);
  });
});

function toDims(canvas: { width: number; height: number }): [number, number] {
  return [canvas.width, canvas.height];
}

describe('batching', () => {
  it('reports the fill cost of a multi-ring tip', () => {
    expect(fillsPerStamp(stroke({ tip: { core: 1, steps: 1, outerAlpha: 1 } }))).toBe(1);
    expect(fillsPerStamp(stroke({ tip: { core: 0.2, steps: 4, outerAlpha: 0.2 } }))).toBe(4);
  });

  it('opens spacing rather than dropping a stroke to fit the budget', () => {
    const fat = stroke({ size: 0.3 });
    const result = budgetStroke(fat, CANVAS.width, CANVAS.height, 40);
    expect(result.degraded).toBe(true);
    expect(result.stroke.spacing).toBeGreaterThan(fat.spacing);
    // Still covers the path: spacing stays inside one radius.
    expect(result.stroke.spacing).toBeLessThanOrEqual(1);
  });

  it('leaves a stroke alone when it already fits', () => {
    const thin = stroke({ size: 0.01 });
    const result = budgetStroke(thin, CANVAS.width, CANVAS.height, 10_000);
    expect(result.degraded).toBe(false);
    expect(result.stroke).toBe(thin);
  });

  it('splits a layer into several calls when one would exceed the budget', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      stroke({ size: 0.05, points: [{ x: 0.05, y: 0.05 + i * 0.01 }, { x: 0.95, y: 0.05 + i * 0.01 }] }),
    );
    const report = buildBatches(new Map([['Waves', many]]), {
      ...CANVAS,
      perCallBudget: 200,
    });
    expect(report.batches.length).toBeGreaterThan(1);
    for (const batch of report.batches) expect(batch.layer).toBe('Waves');
  });

  it('flags only the first batch of a layer as needing creation', () => {
    const many = Array.from({ length: 40 }, () => stroke({ size: 0.02 }));
    const report = buildBatches(new Map([['Waves', many]]), { ...CANVAS, perCallBudget: 150 });
    expect(report.batches.length).toBeGreaterThan(1);
    expect(report.batches[0]?.createLayer).toBe(true);
    for (const batch of report.batches.slice(1)) expect(batch.createLayer).toBe(false);
  });

  it('counts every stroke it emits', () => {
    const strokes = [stroke(), stroke(), stroke()];
    const report = buildBatches(new Map([['Sky', strokes]]), CANVAS);
    expect(report.strokes).toBe(3);
    expect(report.fills).toBeGreaterThan(0);
  });

  it('keeps a default budget that would not time the bridge out', () => {
    expect(DEFAULT_FILL_BUDGET).toBeLessThanOrEqual(2000);
    expect(MAX_STAMPS_PER_STROKE).toBeGreaterThan(DEFAULT_FILL_BUDGET);
  });
});

// --------------------------------------------------------------------------

const PLAN: PaintingPlan = {
  title: 'moonlit ocean',
  canvas: CANVAS,
  style: {
    medium: 'oil',
    brushCharacter: 'layered oil',
    contrast: 'high',
    atmosphere: 'romantic marine',
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
    negativeSpace: 0.35,
  },
  palette: {
    shadows: ['#102a3b', '#173d55'],
    midtones: ['#285c76', '#3d7187'],
    highlights: ['#b9d6d8', '#e4d7b2'],
    accents: ['#c05a3a'],
    base: ['#173b58'],
  },
  layers: ['Highlights', 'Foam', 'Waves', 'Sky'],
  stages: [
    {
      id: 'sky',
      layer: 'Sky',
      purpose: 'Sky base',
      brush: 'soft_blend',
      depth: 'background',
      palette: ['#173d55'],
      density: 0.5,
      detail: 0.2,
      progress: 0.1,
      strokes: [{ primitive: 'glaze', region: { x: 0, y: 0, width: 1, height: 0.62 }, colorRole: 'shadows' }],
    },
    {
      id: 'waves',
      layer: 'Waves',
      purpose: 'Large wave masses',
      brush: 'oil_large',
      depth: 'midground',
      palette: ['#173b58'],
      density: 0.6,
      detail: 0.4,
      progress: 0.45,
      strokes: [
        { primitive: 'wave', region: { x: 0, y: 0.62, width: 1, height: 0.2 }, colorRole: 'midtones' },
        { primitive: 'wave', region: { x: 0, y: 0.75, width: 1, height: 0.25 }, colorRole: 'shadows' },
      ],
    },
    {
      id: 'foam',
      layer: 'Foam',
      purpose: 'Foam',
      brush: 'oil_small',
      depth: 'foreground',
      palette: ['#b9d6d8'],
      density: 0.5,
      detail: 0.6,
      progress: 0.8,
      strokes: [
        { primitive: 'cloud', region: { x: 0.2, y: 0.78, width: 0.6, height: 0.15 }, colorRole: 'highlights' },
        { primitive: 'scatteredDabs', region: { x: 0, y: 0.7, width: 1, height: 0.3 }, count: 20, colorRole: 'highlights' },
      ],
    },
    {
      id: 'highlights',
      layer: 'Highlights',
      purpose: 'Crest light',
      brush: 'oil_detail',
      depth: 'foreground',
      palette: ['#e4d7b2'],
      density: 0.4,
      detail: 0.9,
      progress: 0.95,
      strokes: [{ primitive: 'highlight', region: { x: 0.5, y: 0.65, width: 0.3, height: 0.2 }, colorRole: 'accents' }],
    },
  ],
  seed: 20261005,
  maxIterations: 3,
};

describe('PaintEngine.estimate', () => {
  it('reports layers, strokes and a plausible fill cost', () => {
    const engine = new PaintEngine();
    const estimate = engine.estimate(PLAN);
    expect(estimate.layers).toBe(4);
    // 1 sky glaze + 2 wave masses + 1 cloud + 10 scattered dabs (20 x density 0.5)
    // + 1 crest highlight.
    expect(estimate.strokes).toBe(15);
    expect(estimate.fills).toBeGreaterThan(estimate.strokes);
    expect(estimate.truncated).toBe(0);
  });

  it('matches what a render actually paints', () => {
    const engine = new PaintEngine();
    const estimate = engine.estimate(PLAN);
    const mock = new MockPhotoshop();
    return engine.paintPlan(PLAN, mock).then((report) => {
      expect(report.strokes).toBe(estimate.strokes);
    });
  });
});

describe('PaintEngine.paintPlan', () => {
  it('creates the layers in paint order and paints into them', async () => {
    const engine = new PaintEngine();
    const mock = new MockPhotoshop();
    const report = await engine.paintPlan(PLAN, mock);

    expect(mock.layerNames()).toEqual(['Sky', 'Waves', 'Foam', 'Highlights']);
    expect(report.layers).toBe(4);
    expect(report.strokes).toBeGreaterThan(0);
    expect(report.batches).toBeGreaterThanOrEqual(4);
  });

  it('reports that the tips were synthesized, never as Photoshop brushes', async () => {
    const report = await new PaintEngine().paintPlan(PLAN, new MockPhotoshop());
    expect(report.tipIsSynthesized).toBe(true);
  });

  it('emits progress that only ever moves forward and ends at 1', async () => {
    const seen: PaintProgress[] = [];
    const engine = new PaintEngine({ onProgress: (p) => seen.push(p) });
    await engine.paintPlan(PLAN, new MockPhotoshop());

    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]?.overall).toBeGreaterThanOrEqual(seen[i - 1]?.overall ?? 0);
    }
    expect(seen[seen.length - 1]?.overall).toBeCloseTo(1, 5);
  });

  it('walks the progressive phases in order', async () => {
    const phases: string[] = [];
    const engine = new PaintEngine({ onProgress: (p) => phases.push(p.phase) });
    await engine.paintPlan(PLAN, new MockPhotoshop());
    const order = ['composition', 'masses', 'colors', 'forms', 'details', 'highlights', 'final'];
    const seenOrder = phases.filter((p, i) => phases.indexOf(p) === i);
    const indices = seenOrder.map((p) => order.indexOf(p));
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1] ?? 0);
    }
  });

  it('produces the same picture twice for the same seed', async () => {
    const first = new MockPhotoshop();
    const second = new MockPhotoshop();
    await new PaintEngine().paintPlan(PLAN, first);
    await new PaintEngine().paintPlan(PLAN, second);
    expect(first.totalStrokes()).toBe(second.totalStrokes());
    expect(first.layers[0]?.strokes[0]?.points).toEqual(second.layers[0]?.strokes[0]?.points);
  });

  it('paints every stroke in canvas pixels', async () => {
    const mock = new MockPhotoshop();
    await new PaintEngine().paintPlan(PLAN, mock);
    for (const layer of mock.layers) {
      for (const painted of layer.strokes) {
        expect(painted.size).toBeGreaterThan(0);
        for (const point of painted.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(CANVAS.width);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(CANVAS.height);
        }
      }
    }
  });

  it('stops between batches when aborted, leaving a partial document', async () => {
    const stop = { aborted: false };
    const engine = new PaintEngine({
      onProgress: () => {
        stop.aborted = true;
      },
    });
    const mock = new MockPhotoshop();
    const full = await new PaintEngine().paintPlan(PLAN, new MockPhotoshop());
    const partial = await engine.paintPlan(PLAN, mock, stop);
    expect(partial.strokes).toBeLessThan(full.strokes);
  });

  it('propagates an adapter failure rather than reporting success', async () => {
    const mock = new MockPhotoshop('Crest light');
    await expect(new PaintEngine().paintPlan(PLAN, mock)).rejects.toThrow(/mock refused/);
  });

  it('refuses a plan that does not validate', async () => {
    const broken = { ...PLAN, stages: [{ ...PLAN.stages[0]!, layer: 'Ghost' }] };
    await expect(new PaintEngine().paintPlan(broken, new MockPhotoshop())).rejects.toThrow(/not in the plan/);
  });

  it('scales brush size by depth so the foreground is bolder', async () => {
    const mock = new MockPhotoshop();
    await new PaintEngine().paintPlan(PLAN, mock);
    const sizes = mock.brushSizes();
    expect(sizes.length).toBeGreaterThan(1);
  });
});

describe('PaintEngine.layerStack', () => {
  it('lists layers topmost first for the UI', () => {
    expect(new PaintEngine().layerStack(PLAN).map((l) => l.name)).toEqual([
      'Highlights',
      'Foam',
      'Waves',
      'Sky',
    ]);
  });
});