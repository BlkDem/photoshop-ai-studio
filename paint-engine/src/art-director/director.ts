/**
 * The Art Director: a request in, a PaintingPlan out.
 *
 * No model is involved. That is a design constraint, not a limitation of
 * ambition — the paint engine must not depend on any particular LLM, and the only
 * honest way to honour that is for the thing that decides *what to paint* to be
 * plain, inspectable code. A model-backed director can be layered on top later and
 * must produce the same `PaintingPlan` shape, because the engine cannot tell the
 * two apart.
 *
 * The brief is parsed, the composition is resolved, the palette is derived, and
 * the recipes emit stages in a fixed order. Given the same request and seed this
 * returns a byte-identical plan.
 */

import { Rng } from '../random.js';
import { CompositionEngine, type CompositionFramework } from '../composition/engine.js';
import { buildPalette } from '../palette/engine.js';
import type { PaintingPlan, PaintingStyle } from '../types.js';
import { parseBrief, type Brief } from './brief.js';
import { layersFor, stagesFor } from './recipes.js';

export interface ArtDirectorOptions {
  seed?: number;
  canvas?: { width: number; height: number };
  /** Overrides for anything the request could say but the parser did not catch. */
  framework?: CompositionFramework;
  horizon?: number | null;
  focalPoint?: { x: number; y: number };
  /** Merged over the parsed brief; lets a caller pin style without rewriting prose. */
  style?: Partial<PaintingStyle>;
  maxIterations?: number;
  /**
   * Reported rather than resolved. A caller can show the user what was understood
   * and let them correct it, which is the alternative to the parser quietly
   * guessing.
   */
  notes?: string[];
}

export interface DirectedPlan {
  plan: PaintingPlan;
  brief: Brief;
  /** Things the request implied but the brief had to invent a default for. */
  assumptions: string[];
}

const DEFAULT_CANVAS = { width: 1024, height: 683 };

/** Reads the named framework out of the request, if the request names one. */
function frameworkFrom(request: string): CompositionFramework | undefined {
  const map: Array<[CompositionFramework, RegExp]> = [
    ['goldenRatio', /\b(golden|phi|fibonacci)\b/i],
    ['diagonal', /\b(diagonal|dynamic|slanted)\b/i],
    ['center', /\b(centered|centred|central|frontal|symmetric\w*)\b/i],
    ['ruleOfThirds', /\b(thirds|rule of thirds)\b/i],
  ];
  return map.find(([, pattern]) => pattern.test(request))?.[0];
}

/**
 * Directs a painting.
 *
 * Returns the plan plus the assumptions it made, so an artist who meant something
 * else can see exactly which default overrode them.
 */
export function direct(request: string, options: ArtDirectorOptions = {}): DirectedPlan {
  const seed = options.seed ?? 1;
  const canvas = options.canvas ?? DEFAULT_CANVAS;
  const brief = parseBrief(request, seed);
  const rng = new Rng(seed);
  const assumptions: string[] = [];

  const requestedFramework = options.framework ?? frameworkFrom(request);
  if (!requestedFramework) {
    assumptions.push('No composition framework named; used rule of thirds.');
  }

  const composition = new CompositionEngine().resolve(
    {
      framework: requestedFramework ?? 'ruleOfThirds',
      horizon: options.horizon,
      focalPoint: options.focalPoint,
    },
    rng,
    brief.hasGround,
  );

  if (!brief.hasGround && composition.horizon === null) {
    assumptions.push('No ground plane; the horizon is null.');
  } else if (options.horizon === undefined) {
    assumptions.push(`Horizon placed by the composition framework at ${composition.horizon?.toFixed(2)}.`);
  }

  // A scene-appropriate proposal is used only where the request said nothing, and
  // it is reported rather than applied silently. Left to itself the palette engine
  // returns a neutral grey ramp for an unseeded request, which paints a fog — a
  // seascape in grey is not a painting of the sea, it is a picture with the sea
  // removed from it.
  const named = Object.values(brief.paletteSeeds).flat();
  const paletteSeeds = { ...brief.paletteSeeds };
  if (named.length === 0) {
    for (const [role, colours] of Object.entries(sceneSeeds(brief))) {
      paletteSeeds[role] = [...colours];
    }
    assumptions.push(`No colours named; proposed a ${brief.scene} palette.`);
  }
  const palette = buildPalette(paletteSeeds);

  // Recipes are written against a horizon. A picture with none gets one anyway for
  // the purposes of laying out the sky, because a sky still occupies the top of
  // the canvas; it is simply not used as a ground boundary.
  const layoutHorizon = composition.horizon ?? 0.72;

  const stages = stagesFor(brief, layoutHorizon, composition.focalPoint, rng);

  const style: PaintingStyle = {
    medium: brief.medium,
    brushCharacter: `${brief.medium}, ${brief.texture} texture`,
    contrast: brief.contrast,
    atmosphere: brief.atmosphere,
    texture: brief.texture,
    edgeCharacter: brief.edgeCharacter,
    colorTemperature: brief.colorTemperature,
    detailLevel: brief.detailLevel,
    ...options.style,
  };

  const plan: PaintingPlan = {
    title: request.trim() === '' ? 'Untitled' : request.trim(),
    canvas,
    style,
    composition,
    palette,
    layers: layersFor(stages),
    stages,
    seed,
    maxIterations: options.maxIterations ?? 3,
  };

  return { plan, brief, assumptions };
}

/**
 * Palette seeds proposed for a scene when the request named no colours.
 *
 * Chosen as the four or five values an artist would block in first, in the tonal
 * order the plan asks for them: a dark for the deepest shadows, a midtone for the
 * mass, a light for the foam and the lit edges, and one accent that belongs to the
 * light source rather than to the scene.
 */
function sceneSeeds(brief: Brief): Record<string, string[]> {
  const stormy = brief.atmosphere === 'dramatic' || brief.atmosphere === 'stormy';
  const warm = brief.colorTemperature === 'warm' || brief.atmosphere === 'golden';

  if (brief.scene === 'ocean') {
    return {
      shadows: stormy ? ['#141d2b', '#1e2c3e'] : ['#12293c', '#1d3d52'],
      midtones: stormy ? ['#3c5468', '#54748a'] : ['#2f6d84', '#4d8b9b'],
      highlights: ['#c3d3d8', '#e6ecec'],
      // The accent is the light on the water, so it takes its colour from whether
      // the request said the light was warm.
      accents: warm ? ['#c8a24a', '#e0b463'] : ['#8fb6bd', '#a8c6c9'],
    };
  }

  if (brief.scene === 'landscape') {
    return {
      shadows: ['#2a3128', '#3c4535'],
      midtones: warm ? ['#7a7a4e', '#9a8b5c'] : ['#4a7a55', '#6b8f5e'],
      highlights: ['#d8dcc4', '#eceee0'],
      accents: warm ? ['#c8a24a', '#b8873a'] : ['#8aa08a'],
    };
  }

  return {
    shadows: stormy ? ['#1a1c26', '#282b38'] : ['#2c3a4a', '#3f5266'],
    midtones: warm ? ['#b08a5e', '#c9a878'] : ['#6d8296', '#8ba0b2'],
    highlights: ['#e4e6e8', '#f2f0ea'],
    accents: warm ? ['#d9a45c', '#c98f36'] : ['#b9c7d2'],
  };
}

export { parseBrief } from './brief.js';
export type { Brief, Element, SceneKind } from './brief.js';
export { stagesFor, layersFor } from './recipes.js';