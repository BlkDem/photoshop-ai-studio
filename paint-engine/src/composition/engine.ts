/**
 * Where things go.
 *
 * A generated painting fails far more often on placement than on colour, and the
 * failure is invisible in the plan: nothing throws, the strokes are all correct,
 * and the picture is still boring. Deciding the horizon, the focal point and the
 * depth bands *before* any mark is made is what stops that.
 *
 * The four frameworks are kept deliberately crude. Rule of thirds and golden
 * ratio are the two the spec names; `center` is there because symmetric subjects
 * (a sun, a horizon, a single ship) genuinely want it and forcing thirds on them
 * looks like a mistake; `diagonal` gives a leaning energy that reads as
 * dramatic in a way an axis-aligned grid cannot.
 */

import type { CompositionSpec, NormalizedPoint, NormalizedRect } from '../types.js';
import type { Rng } from '../random.js';

export type CompositionFramework = CompositionSpec['framework'];

/** The two points a thirds or golden-ratio grid defines. */
export function frameworkFocalPoints(framework: CompositionFramework): NormalizedPoint[] {
  switch (framework) {
    case 'ruleOfThirds':
      return [
        { x: 1 / 3, y: 1 / 3 },
        { x: 2 / 3, y: 1 / 3 },
        { x: 1 / 3, y: 2 / 3 },
        { x: 2 / 3, y: 2 / 3 },
      ];
    case 'goldenRatio':
      return [
        { x: 0.382, y: 0.382 },
        { x: 0.618, y: 0.382 },
        { x: 0.382, y: 0.618 },
        { x: 0.618, y: 0.618 },
      ];
    case 'center':
      return [{ x: 0.5, y: 0.5 }];
    case 'diagonal':
      return [
        { x: 0.28, y: 0.72 },
        { x: 0.72, y: 0.28 },
        { x: 0.5, y: 0.5 },
      ];
  }
}

/**
 * Chooses the focal point.
 *
 * A brief that names a subject ("a small ship", "the break in the cloud") puts
 * the eye there; one that does not gets the framework's strongest point, which is
 * the upper-left or upper-right third rather than the centre — a centred focal
 * point is the least interesting outcome available.
 */
export function chooseFocalPoint(
  framework: CompositionFramework,
  preferred: NormalizedPoint | undefined,
  rng: Rng,
): NormalizedPoint {
  if (preferred) {
    return { x: clamp(preferred.x), y: clamp(preferred.y) };
  }
  const points = frameworkFocalPoints(framework);
  const upper = points.filter((p) => p.y <= 0.62);
  const pool = upper.length > 0 ? upper : points;
  const chosen = rng.pick(pool);
  // A small offset off the exact intersection: sitting precisely on the third
  // line looks like a diagram, and real focal points sit near it, not on it.
  return {
    x: clamp(chosen.x + rng.gaussian() * 0.04),
    y: clamp(chosen.y + rng.gaussian() * 0.04),
  };
}

/**
 * Picks a horizon.
 *
 * A horizon near the middle is the safe answer and also the dull one; thirds and
 * golden-ratio placements both sit lower or higher than the eye expects, which is
 * what gives a landscape its scale. Returns null when the brief has no ground
 * plane at all — an abstract or a portrait should not be given one.
 */
export function chooseHorizon(
  framework: CompositionFramework,
  requested: number | null | undefined,
  hasGround: boolean,
  rng: Rng,
): number | null {
  if (requested !== undefined) return requested === null ? null : clamp(requested);
  if (!hasGround) return null;

  switch (framework) {
    case 'ruleOfThirds':
      return 0.62 + rng.gaussian() * 0.03;
    case 'goldenRatio':
      return 0.618;
    case 'center':
      return 0.5;
    case 'diagonal':
      return 0.55 + rng.gaussian() * 0.05;
  }
}

/**
 * Splits the canvas into the depth bands the plan paints in.
 *
 * Bands are fractions of the whole canvas, not of the region below the horizon,
 * so a sky that is 60% of the picture is 0.6 tall regardless of where the horizon
 * sits. Keeping the arithmetic absolute is what stops a plan from silently
 * changing shape when the horizon moves.
 */
export function depthBands(horizon: number | null): Record<DepthZoneName, NormalizedRect> {
  if (horizon === null) {
    return {
      background: { x: 0, y: 0, width: 1, height: 1 },
      midground: { x: 0, y: 0.1, width: 1, height: 0.8 },
      foreground: { x: 0, y: 0.3, width: 1, height: 0.7 },
    };
  }

  const h = clamp(horizon);
  // Sky is background. The ground splits into a far band that is still receding
  // and a near band that is close enough to need edges — and the near band gets
  // the larger share deliberately: the foreground is where a painting's detail
  // budget has to go, and a large canvas area is how a mark earns it.
  const farGround = Math.min(0.4, (1 - h) * 0.4);
  const nearGround = Math.max(0.05, (1 - h) - farGround);

  return {
    background: { x: 0, y: 0, width: 1, height: h },
    midground: { x: 0, y: h, width: 1, height: farGround },
    foreground: { x: 0, y: h + farGround, width: 1, height: nearGround },
  };
}

export type DepthZoneName = 'background' | 'midground' | 'foreground';

/**
 * Fills in a composition from a partial spec.
 *
 * Every field is optional on the way in and total on the way out, so the Art
 * Director can be as vague as the brief allows without the engine guessing later
 * from strokes that have already been placed.
 */
export class CompositionEngine {
  resolve(spec: Partial<CompositionSpec> | undefined, rng: Rng, hasGround: boolean): CompositionSpec {
    const framework = spec?.framework ?? 'ruleOfThirds';
    const horizon = chooseHorizon(framework, spec?.horizon, hasGround, rng);
    const focalPoint = chooseFocalPoint(framework, spec?.focalPoint, rng);
    const bands = depthBands(horizon);

    const regions: Record<string, NormalizedRect> = {
      ...bands,
      ...(spec?.regions ?? {}),
    };

    if (hasGround && horizon !== null) {
      const below = { x: 0, y: horizon, width: 1, height: 1 - horizon };
      regions['ground'] = regions['ground'] ?? below;
      regions['sky'] = regions['sky'] ?? bands.background;
    }

    return {
      framework,
      horizon,
      focalPoint,
      regions,
      negativeSpace: spec?.negativeSpace ?? 0.4,
    };
  }

  /**
   * Where a subject of a given apparent size should sit.
   *
   * Subjects sit low and large in the foreground band and small and high in the
   * background band, which is the whole of scale in a flat 2D picture.
   */
  subjectBox(region: NormalizedRect, depth: DepthZoneName, rng: Rng): NormalizedRect {
    const scale = depth === 'foreground' ? 0.55 : depth === 'midground' ? 0.32 : 0.16;
    const width = Math.max(0.04, region.width * scale);
    const height = Math.max(0.04, region.height * scale * (depth === 'foreground' ? 1.3 : 1));
    return {
      x: clamp01(region.x + region.width * 0.5 - width * 0.5 + rng.gaussian() * region.width * 0.12),
      y: clamp01(region.y + region.height * 0.5 - height * 0.5 + rng.gaussian() * region.height * 0.08),
      width: Math.min(width, 1),
      height: Math.min(height, 1),
    };
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp01(value: number): number {
  return clamp(value);
}