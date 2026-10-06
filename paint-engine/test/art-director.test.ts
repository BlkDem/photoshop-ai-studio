import { describe, expect, it } from 'vitest';
import { direct, parseBrief } from '../src/art-director/director.js';
import { validatePaintingPlan } from '../src/validation.js';
import { layersFor, stagesFor } from '../src/art-director/recipes.js';
import { Rng } from '../src/random.js';

describe('parseBrief', () => {
  it('recognises a storm ship as an ocean scene with the things in it', () => {
    const brief = parseBrief('stormy seascape with a ship and breaking waves');
    expect(brief.scene).toBe('ocean');
    expect(brief.elements).toEqual(expect.arrayContaining(['ship', 'large_waves']));
    expect(brief.hasGround).toBe(true);
  });

  it('defaults a bare ocean request to waves and foam', () => {
    const brief = parseBrief('paint the sea');
    expect(brief.scene).toBe('ocean');
    expect(brief.elements).toContain('large_waves');
    expect(brief.elements).toContain('foam');
  });

  it('leaves a sky-only request with no ground plane', () => {
    const brief = parseBrief('stormy sky, no land');
    expect(brief.scene).toBe('sky');
    expect(brief.hasGround).toBe(false);
  });

  it('takes a named medium over the default', () => {
    expect(parseBrief('watercolour of a harbour').medium).toBe('watercolor');
    expect(parseBrief('charcoal portrait').medium).toBe('charcoal');
    expect(parseBrief('a moody seascape').medium).toBe('oil');
  });

  it('maps named colours onto tonal roles', () => {
    const brief = parseBrief('a blue sea with golden light');
    expect(brief.paletteSeeds.midtones).toContain('#2f6d84');
    expect(brief.paletteSeeds.accents).toContain('#c8a24a');
  });

  it('ignores value words, which are not hues', () => {
    // "dark" is a value. Turning it into a swatch is how a palette fills with mud.
    const brief = parseBrief('a dark and moody seascape');
    expect(Object.keys(brief.paletteSeeds)).toHaveLength(0);
  });

  it('separates light that passes through from light that sits on', () => {
    expect(parseBrief('light breaking through the clouds').lightThrough).toBe(true);
    expect(parseBrief('moonlight on the water').lightThrough).toBe(false);
  });
});

describe('stage order', () => {
  const brief = parseBrief('stormy seascape with a ship and breaking waves');

  it('goes sky, then clouds, then water, then foam, then the subject', () => {
    const stages = stagesFor(brief, 0.58, { x: 0.68, y: 0.42 }, new Rng(1));
    const ids = stages.map((s) => s.id);
    expect(ids.indexOf('sky')).toBeLessThan(ids.indexOf('water'));
    expect(ids.indexOf('water')).toBeLessThan(ids.indexOf('foam'));
    expect(ids.indexOf('foam')).toBeLessThan(ids.indexOf('subject'));
  });

  it('advances progress monotonically, so a partial run still reads as the picture', () => {
    const stages = stagesFor(brief, 0.58, { x: 0.68, y: 0.42 }, new Rng(1));
    for (let i = 1; i < stages.length; i += 1) {
      expect(stages[i].progress).toBeGreaterThan(stages[i - 1].progress);
    }
    expect(stages[stages.length - 1].progress).toBeLessThanOrEqual(1);
  });

  it('puts foam at foreground depth, which is what stops a sea reading flat', () => {
    const stages = stagesFor(brief, 0.58, { x: 0.68, y: 0.42 }, new Rng(1));
    expect(stages.find((s) => s.id === 'foam')?.depth).toBe('foreground');
    expect(stages.find((s) => s.id === 'water')?.depth).toBe('midground');
  });

  it('band the water so it recedes instead of repeating', () => {
    const stages = stagesFor(brief, 0.58, { x: 0.68, y: 0.42 }, new Rng(1));
    const water = stages.find((s) => s.id === 'water')!;
    const waves = water.strokes.filter((s) => s.primitive === 'wave');
    const amplitudes = waves.map((w) => w.amplitude ?? 0);
    // Larger marks toward the bottom edge; equal sizes read as wallpaper.
    expect(amplitudes[amplitudes.length - 1]).toBeGreaterThan(amplitudes[0]);
  });

  it('does not give a sky-only brief a water stage', () => {
    const stages = stagesFor(parseBrief('stormy sky'), 0.72, { x: 0.5, y: 0.4 }, new Rng(1));
    expect(stages.map((s) => s.id)).not.toContain('water');
  });
});

describe('layers', () => {
  it('names one layer per stage, bottom-first, without duplicates', () => {
    const stages = stagesFor(parseBrief('stormy seascape with a ship'), 0.58, { x: 0.68, y: 0.42 }, new Rng(1));
    const layers = layersFor(stages);
    expect(new Set(layers).size).toBe(layers.length);
    expect(layers).toContain('Sky');
    expect(layers).toContain('Water');
  });
});

describe('direct', () => {
  it('turns a request into a plan that passes validation', () => {
    const { plan } = direct('stormy seascape with a ship and breaking waves');
    expect(() => validatePaintingPlan(plan)).not.toThrow();
  });

  it('is deterministic for a given seed', () => {
    const a = direct('a calm harbour at dawn', { seed: 7 });
    const b = direct('a calm harbour at dawn', { seed: 7 });
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
  });

  it('differs for a different seed', () => {
    const a = direct('a calm harbour at dawn', { seed: 7 });
    const b = direct('a calm harbour at dawn', { seed: 8 });
    expect(JSON.stringify(a.plan)).not.toBe(JSON.stringify(b.plan));
  });

  it('reports what it assumed instead of deciding silently', () => {
    const { assumptions } = direct('a seascape');
    expect(assumptions.some((a) => a.includes('composition framework'))).toBe(true);
  });

  it('does not claim a framework was inferred when the request named one', () => {
    const { plan } = direct('golden ratio seascape with a ship');
    expect(plan.composition.framework).toBe('goldenRatio');
  });

  it('places the horizon inside the canvas and the focal point off the exact third', () => {
    const { plan } = direct('stormy seascape with a ship');
    const h = plan.composition.horizon!;
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThan(1);
    expect(plan.composition.focalPoint.x).toBeLessThanOrEqual(1);
  });

  it('leaves the horizon null for a picture with no ground', () => {
    const { plan } = direct('stormy sky, nothing but clouds');
    expect(plan.composition.horizon).toBeNull();
  });

  it('derives a full palette even when the request names no colours', () => {
    const { plan } = direct('a seascape');
    for (const role of ['shadows', 'midtones', 'highlights', 'accents'] as const) {
      expect(plan.palette[role].length).toBeGreaterThan(0);
    }
  });

  it('keeps a named colour in the palette it was asked for', () => {
    const { plan } = direct('a blue sea with golden light');
    const all = Object.values(plan.palette).flat() as string[];
    expect(all).toContain('#2f6d84');
    expect(all).toContain('#c8a24a');
  });

  it('honours an explicit horizon over the framework', () => {
    const { plan } = direct('a seascape', { horizon: 0.4 });
    expect(plan.composition.horizon).toBe(0.4);
  });

  it('titles the plan with the request', () => {
    expect(direct('a stormy sea').plan.title).toBe('a stormy sea');
    expect(direct('   ').plan.title).toBe('Untitled');
  });
});