/**
 * Turning a tip falloff into discs the plugin can actually fill.
 *
 * Photoshop's brush engine builds a soft edge in one pass. Here an edge is
 * approximated by painting a stamp as a stack of concentric discs, each fainter
 * than the one inside it, **drawn largest-first**.
 *
 * Order matters and is not arbitrary. Painting outside-in means the small, dense
 * core is laid down last and therefore wins where the rings overlap, so the
 * centre of the mark ends up opaque while the rim keeps only the faint outer
 * ring. Painting the other way round would let the broad washes dominate and
 * every mark would come out flat.
 *
 * ## Cost
 *
 * A tip with `steps` rings costs `steps` fills per stamp instead of one. Since
 * each fill is a `selectEllipse` plus a `batchPlay` round trip, a 4-ring brush
 * is four times slower than a hard one for the same path length. `budgetStamps`
 * in ../renderer/batches.ts exists to pay that bill by spending marks, not by
 * silently truncating.
 */

import type { TipModel } from '../types.js';

/** One disc of a synthesized tip, in the order it must be filled. */
export interface TipRing {
  /** Disc radius in the same units as the stroke's radius. */
  radius: number;
  /** Alpha multiplier for this ring, 0..1, relative to the stroke opacity. */
  weight: number;
}

/**
 * Mirrors the plugin's spacing rule (`stroke-geometry.js: stampSpacing`).
 *
 * Duplicated rather than imported: that file ships as plain JavaScript inside
 * the UXP plugin, which cannot depend on this workspace. `mcp-server` keeps a
 * third copy in TypeScript and asserts all three agree in a differential test —
 * this is that third copy, and it is the reason the constant lives in a
 * function with a test rather than inline at each use site.
 */
export function stampSpacing(radius: number): number {
  return Math.max(0.35, Math.min(radius, radius * 0.4));
}

/** Spacing honouring a preset's own spacing dial, as a fraction of the radius. */
export function spacingFor(radius: number, spacing: number): number {
  const fraction = Math.max(0.05, Math.min(1, spacing));
  return Math.max(0.35, radius * fraction);
}

/**
 * How many discs overlap any one point along a stroke.
 *
 * Used to solve the same problem `strokeAlpha` solves in the plugin: N overlapping
 * fills at alpha `a` reach `1-(1-a)^N`, so to land a stroke at the requested
 * opacity each fill must be lighter than the stroke. Getting this wrong is why
 * a translucent stroke comes out either invisible or solid.
 */
export function overlapDivisor(radius: number, spacing: number): number {
  const step = spacingFor(radius, spacing);
  return Math.min(Math.max(1, (2 * radius) / step), 24);
}

/**
 * Converts a requested stroke opacity into the alpha a single fill must carry.
 *
 * `steps` is the tip's ring count, which changes the overlap count on its own:
 * a 4-ring tip has four discs stacked on the same pixel.
 */
export function fillAlpha(opacity: number, radius: number, spacing: number, steps: number): number {
  const requested = Math.max(0, Math.min(1, opacity));
  if (requested <= 0) return 0;
  if (requested >= 1) return 1;

  const divisor = overlapDivisor(radius, spacing) * Math.max(1, steps);
  return 1 - Math.pow(1 - requested, 1 / divisor);
}

/**
 * Builds the ring stack for one stamp, outermost first.
 *
 * The profile is deliberately two-segment rather than a smooth curve: a fully
 * opaque core out to `core` of the radius, then a linear fade to `outerAlpha` at
 * the rim. Real brush tips are closer to a power curve, but a linear fade is what
 * a handful of discs can actually represent without the rim banding visibly.
 */
export function tipRings(radius: number, tip: TipModel): TipRing[] {
  const r = Math.max(0.5, radius);
  const steps = Math.max(1, Math.min(8, Math.round(tip.steps)));
  const core = Math.max(0.05, Math.min(1, tip.core));
  const outerAlpha = Math.max(0, Math.min(1, tip.outerAlpha));

  // A hard tip is one disc and is exactly what the un-tipped rasterizer emits,
  // which keeps existing behaviour available to callers that want it.
  if (steps === 1) {
    return [{ radius: r, weight: 1 }];
  }

  const rings: TipRing[] = [];
  // Largest first, spanning the rim in to the core boundary. Spacing the rings
  // evenly from the centre out instead would make `core: 0.55` yield an opaque
  // disc of only 1/steps of the radius, which reads as a donut, not a soft brush.
  for (let index = 0; index < steps; index += 1) {
    const t = index / (steps - 1); // 0 at the rim, 1 at the core
    // Faint at the rim, opaque at the core.
    rings.push({ radius: r * (1 - (1 - core) * t), weight: outerAlpha + (1 - outerAlpha) * t });
  }
  return rings;
}

/**
 * Multiplies a ring weight by the fill alpha to get the alpha that fill needs.
 *
 * Clamped below 1 so a weight of 1 on the core ring is still allowed to be the
 * stroke's own alpha, but no fill ever exceeds full opacity and therefore never
 * punches a hole through what is underneath.
 */
export function ringAlpha(ring: TipRing, strokeOpacity: number, radius: number, spacing: number, steps: number): number {
  // Floored on the base alpha, before the ring's weight: flooring the product would
  // clamp the faint rim up to the core's alpha and flatten the soft edge into a disc.
  const base = Math.max(MIN_FILL_ALPHA, fillAlpha(strokeOpacity, radius, spacing, steps));
  return Math.min(1, base * ring.weight);
}

/**
 * The smallest alpha a single fill may be asked for, as a fraction.
 *
 * Mirrors `MIN_FILL_ALPHA` in the plugin and the mock. Without it, densest spacing
 * drives the per-ring alpha below what Photoshop will deposit — measured at
 * `spacing: 0.12` giving a 2.4% core fill that laid down nothing — so a stroke can
 * complete every fill and still paint no pixels. Conservative rather than
 * characterised: the real threshold sits between the 2.4% that failed and the 7.7%
 * that worked.
 */
export const MIN_FILL_ALPHA = 0.025;