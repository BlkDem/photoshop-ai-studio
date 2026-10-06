/**
 * Painting plan building.
 *
 * These tests assert the properties that make the expansion trustworthy rather
 * than the shape of its output: that a painting is reachable through the ordinary
 * plan machinery, that it is isolated before it starts, and that the steps it
 * produces describe the painting rather than an approximation of it.
 */

import { describe, expect, it } from 'vitest';
import { PlanSchema } from '@photoshop-ai-studio/shared';
import { buildPaintPlan, paintLayers } from '../src/execution/painting.js';

const REQUEST = 'stormy seascape with a ship and breaking waves, moonlight';

describe('buildPaintPlan', () => {
  it('produces a plan the shared schema accepts', () => {
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    expect(() => PlanSchema.parse(plan)).not.toThrow();
  });

  it('stays inside the one-tool-call-per-step invariant', () => {
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    for (const step of plan.steps) {
      expect(step.params).toBeTypeOf('object');
      // Every paint step carries its own batch, so no step is a loop.
      if (step.tool === 'photoshop.paint_strokes') {
        expect(Array.isArray(step.params.strokes)).toBe(true);
      }
    }
  });

  it('duplicates the document before it paints anything', () => {
    // Undo cannot span the fills (ADR-014), so this is the only thing standing
    // between a half-finished painting and an undiscardable document.
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    expect(plan.steps[0]?.tool).toBe('photoshop.duplicate_document');
  });

  it('omits the duplicate only when the caller says it already isolated', () => {
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540, alreadyIsolated: true });
    expect(plan.steps.some((s) => s.tool === 'photoshop.duplicate_document')).toBe(false);
  });

  it('makes one step per layer, bottom first', () => {
    const { plan, directed } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    const paintSteps = plan.steps.filter((s) => s.tool === 'photoshop.paint_strokes');
    expect(paintSteps.map((s) => s.params.layerName)).toEqual(directed.plan.layers);
  });

  it('creates a layer only for the first step', () => {
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    const paintSteps = plan.steps.filter((s) => s.tool === 'photoshop.paint_strokes');
    expect(paintSteps[0]?.params.newLayer).toBe(true);
    for (const step of paintSteps.slice(1)) expect(step.params.newLayer).toBe(false);
  });

  it('forwards the tip, so the plan does not promise Photoshop a flat disc', () => {
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    const step = plan.steps.find((s) => s.tool === 'photoshop.paint_strokes');
    const strokes = step?.params.strokes as Array<{ tip: { core: number; steps: number; outerAlpha: number } }>;
    expect(strokes.length).toBeGreaterThan(0);
    for (const stroke of strokes) {
      expect(stroke.tip.core).toBeGreaterThan(0);
      expect(stroke.tip.steps).toBeGreaterThan(0);
    }
  });

  it('sends opacity in the units the tool takes', () => {
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    const step = plan.steps.find((s) => s.tool === 'photoshop.paint_strokes');
    for (const stroke of step?.params.strokes as Array<{ opacity: number }>) {
      expect(stroke.opacity).toBeGreaterThan(0);
      expect(stroke.opacity).toBeLessThanOrEqual(100);
    }
  });

  it("carries the assumptions of the director into the plan notes", () => {
    // A painting whose defaults were guessed should say so on the plan a person
    // approves, not only in a log.
    const { plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.notes.join(' ')).toMatch(/composition framework/);
  });

  it('is deterministic for a given seed', () => {
    const a = buildPaintPlan({ request: REQUEST, width: 960, height: 540, seed: 4 });
    const b = buildPaintPlan({ request: REQUEST, width: 960, height: 540, seed: 4 });
    expect(JSON.stringify(a.plan.steps)).toBe(JSON.stringify(b.plan.steps));
  });

  it('gives different strokes for a different seed', () => {
    const a = buildPaintPlan({ request: REQUEST, width: 960, height: 540, seed: 4 });
    const b = buildPaintPlan({ request: REQUEST, width: 960, height: 540, seed: 9 });
    expect(JSON.stringify(a.plan.steps)).not.toBe(JSON.stringify(b.plan.steps));
  });

  it('keeps two paintings in one plan from colliding', () => {
    const a = buildPaintPlan({ request: REQUEST, width: 960, height: 540, idPrefix: 'one' });
    const b = buildPaintPlan({ request: REQUEST, width: 960, height: 540, idPrefix: 'two' });
    const ids = [...a.plan.steps, ...b.plan.steps].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles a request with no ground plane', () => {
    const { plan } = buildPaintPlan({ request: 'stormy sky, nothing but clouds', width: 960, height: 540 });
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    expect(plan.steps.filter((s) => s.tool === 'photoshop.paint_strokes').length).toBeGreaterThan(0);
  });

  it('reports a layer that produced no strokes instead of sending an empty batch', () => {
    const { skippedLayers, plan } = buildPaintPlan({ request: REQUEST, width: 960, height: 540 });
    for (const step of plan.steps) {
      if (step.tool === 'photoshop.paint_strokes') {
        expect((step.params.strokes as unknown[]).length).toBeGreaterThan(0);
      }
    }
    // Whatever it skipped, it said so in the notes.
    if (skippedLayers.length > 0) expect(plan.notes.join(' ')).toContain(skippedLayers[0]!);
  });
});

describe('paintLayers', () => {
  it('reports the layers a painting will touch', () => {
    const layers = paintLayers({ request: REQUEST, width: 960, height: 540 });
    expect(layers).toContain('Sky');
    expect(layers.indexOf('Sky')).toBeLessThan(layers.length - 1);
  });
});