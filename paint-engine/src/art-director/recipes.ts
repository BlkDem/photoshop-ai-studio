/**
 * Scene recipes.
 *
 * This is where a brief becomes marks, and it is the part worth arguing about:
 * every recipe encodes something about how paint behaves that is not derivable
 * from the schema. The ordering is the argument. A painting is built sky first,
 * then masses, then form, then light, and each recipe only assumes the earlier ones
 * have happened — which is what lets a run stop halfway and still read as the
 * picture rather than as a canvas with some confident marks on it.
 *
 * Depth is the quiet lever throughout. A crest painted with foreground crispness is
 * what makes a generated image read as flat, and it is invisible in the plan, so
 * every recipe states its depth explicitly rather than leaving it to the brush.
 */

import type { PlanStage, StrokeRecipe } from '../types.js';
import type { Brief } from './brief.js';

type Rng = { range(min: number, max: number): number; gaussian(): number; chance(p: number): boolean };

type Rect = { x: number; y: number; width: number; height: number };

/**
 * A value gradient, built the way a painter builds one.
 *
 * Disjoint bands do not blend: each is a flat value and the seam between them is a
 * hard edge, which is why three stacked glazes produced a sky made of slabs rather
 * than of air. The fix is overlap. Every pass here spans most of the area and carries
 * one value, and the values step across the passes — so where two meet they mix, and
 * no boundary is ever visible because there is no boundary: only the average of
 * everything laid over that part of the canvas.
 *
 * Passes walk from the far edge of the region toward the near one, reading `roles` in
 * order, so `['shadows', 'midtones', 'highlights']` darkens from the far edge inward.
 */
function gradientWashes(
  region: Rect,
  roles: NonNullable<StrokeRecipe['colorRole']>[],
  options: { passes?: number; rng: Rng; energy?: number },
): StrokeRecipe[] {
  const passes = Math.max(2, options.passes ?? roles.length * 2);
  const rng = options.rng;
  const out: StrokeRecipe[] = [];

  for (let i = 0; i < passes; i += 1) {
    const t = passes === 1 ? 0 : i / (passes - 1);
    // Centre walks the *short* intended span, while the region below deliberately
    // reaches far past it.
    const intended = region.height * 0.35;
    const centre = region.y + intended / 2 + (region.height - intended) * t;

    // The region overshoots the area it is meant to describe, and always has.
    //
    // Three attempts got this far, and the third one is the one that works. The first
    // stacked disjoint bands and the seams showed. The second overlapped them heavily
    // and the values blended — but every pass still ended *somewhere*, and where it
    // ended was a hard edge: two attempts at breaking that inside the glaze primitive
    // failed, and a real render showed why. Clipping a pass to a sub-region makes its
    // own boundary the gradient.
    //
    // So the passes span the whole area and reach past it, and the gradient comes from
    // how much of each colour is laid down rather than from where each pass stops. The
    // energy ramps with the pass so the far edge is dominated by the dark and the near
    // edge by the light, with every colour present everywhere in between.
    const reach = region.height * 1.5;
    out.push({
      primitive: 'glaze',
      region: fit({
        x: region.x - 0.12,
        y: centre - reach / 2,
        width: Math.min(1, region.width + 0.24),
        height: reach,
      }),
      colorRole: roles[Math.min(roles.length - 1, Math.floor(t * roles.length))],
      // Ramp the strength along the gradient as well as changing the colour, so the
      // dark end is not just a different hue but a heavier hand.
      energy: (options.energy ?? 0.75) * (0.45 + 0.55 * (1 - t)) * rng.range(0.9, 1.05),
      jitter: rng.range(0.15, 0.4),
    });
  }
  return out;
}

/** Vertical band as a normalized region, from a horizon down to the bottom. */
function band(y: number, height: number): Rect {
  return fit({ x: 0, y, width: 1, height });
}

/**
 * Clamps a region to the canvas, keeping its size where it fits and shrinking it
 * where it does not.
 *
 * Every recipe here composes regions out of random offsets against a horizon and
 * a depth, which means the arithmetic will occasionally land a mark a few percent
 * past an edge. Clamping once, in one place, is better than making each recipe
 * remember to: the plan schema rejects an overhanging region outright, and a
 * generated plan that fails its own validator is not worth the convenience of a
 * per-recipe bounds check.
 *
 * Shrinking before moving keeps a band's height intact — the water recipe depends
 * on that — and only reduces width when the right edge is the problem.
 */
function fit(rect: Rect): Rect {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  const width = Math.max(0, Math.min(rect.width, 1 - x));
  const height = Math.max(0, Math.min(rect.height, 1 - y));
  return { x, y, width, height };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Sky: two or three broad glazes before anything else.
 *
 * A glaze is a very wide, very soft, very transparent sweep. That is deliberate:
 * a sky painted with strokes reads as strokes, because every mark keeps its own
 * shape no matter how faint it is. Stacking fades is what stops that.
 */
function skyStage(brief: Brief, horizon: number, rng: Rng): PlanStage {
  // Dark above, light toward the horizon, built from overlapping washes. Far edge is
  // the top of the sky.
  const strokes: StrokeRecipe[] = gradientWashes(
    { x: 0, y: 0, width: 1, height: horizon * 0.98 },
    ['shadows', 'midtones', 'highlights'],
    { passes: 5, rng, energy: 0.8 },
  );

  if (brief.atmosphere === 'golden' || brief.colorTemperature === 'warm') {
    // Warm light low in the sky, near the horizon, because that is where a low sun
    // puts it. Two overlapping passes, not one: a single accent band is another seam.
    strokes.push(
      ...gradientWashes({ x: 0, y: horizon * 0.45, width: 1, height: horizon * 0.55 }, ['accents', 'highlights'], {
        passes: 2,
        rng,
        energy: 0.5,
      }),
    );
  }

  return {
    id: 'sky',
    layer: 'Sky',
    purpose: 'Sky, dark above and light toward the horizon',
    // oil_large, not soft_blend. soft_blend is defined at 0.3 opacity and 0.18 for
    // glaze, which is right for a glaze and useless for laying in a sky: on a
    // white ground two passes of it produced a picture with no tone in it at all.
    brush: 'oil_large',
    depth: 'background',
    palette: ['shadows', 'midtones', 'highlights'],
    density: 1,
    detail: 0.15,
    progress: 0.08,
    strokes,
  };
}

/**
 * Clouds: overlapping lobes, biggest first, no outline.
 *
 * `cloud` is the same primitive for a cloud, a foam bank and breaking water — a
 * run of convex lumps. What separates them is scale, depth and colour, not shape.
 */
function cloudStage(brief: Brief, horizon: number, rng: Rng): PlanStage {
  const lobes = 3 + Math.round(rng.range(0, 2));
  const strokes: StrokeRecipe[] = [];

  for (let i = 0; i < lobes; i += 1) {
    // Aspect ratio decides whether this is a lump or a bar.
    //
    // Measured off a real render: the sky's clouds came out as 507px wide and 20px
    // tall. That is not a cloud, it is a shelf, and it is what the region asked for —
    // `cloud` walks a lobe run along the region's long axis, so a region three times
    // wider than it is tall produces a shape three times wider than it is tall. A
    // billow needs proportions near one, and a cloud is a *cluster* of them.
    //
    // So: several small ones, each roughly square, placed to overlap. Coverage comes
    // from the number of clusters rather than from the size of each.
    const perCluster = 2 + Math.round(rng.range(0, 1));
    for (let k = 0; k < perCluster; k += 1) {
      const width = rng.range(0.14, 0.3);
      const height = width * rng.range(0.55, 0.95);
      strokes.push({
        primitive: 'cloud',
        region: {
          x: rng.range(-0.05, 0.95 - width),
          y: rng.range(0, Math.max(0.03, horizon - height)),
          width,
          height,
        },
        colorRole: i % 2 === 0 ? 'shadows' : 'midtones',
        energy: rng.range(0.5, 0.95),
      });
    }
  }

  // A lit top on the cloud mass. This was a `highlight` over a wide shallow region,
  // and `highlight` picked the wrong axis for it: the plan asked for a band 0.6 wide
  // and 0.18 tall and got a stroke 34px wide and 136px tall — a pale column standing
  // in the middle of the sky. `cloud` is the primitive that renders as a form now
  // that its aspect and amplitude are right, so the lit top is another small one.
  const litWidth = rng.range(0.12, 0.22);
  strokes.push({
    primitive: 'cloud',
    region: {
      x: rng.range(0.1, 0.7),
      y: horizon * rng.range(0.15, 0.4),
      width: litWidth,
      height: litWidth * rng.range(0.5, 0.85),
    },
    colorRole: 'midtones',
    energy: 0.35,
    blendMode: 'screen',
  });

  if (brief.lightThrough) {
    // The break in the cloud: a bright lobe *inside* the mass, not on its edge.
    strokes.push({
      primitive: 'cloud',
      region: { x: 0.35, y: horizon * 0.18, width: 0.35, height: horizon * 0.3 },
      colorRole: 'highlights',
      energy: 0.8,
      blendMode: 'screen',
    });
  }

  return {
    id: 'clouds',
    layer: 'Clouds',
    purpose: brief.lightThrough ? 'Cloud masses with a break for the light' : 'Cloud masses',
    brush: 'soft_blend',
    depth: 'background',
    palette: ['shadows', 'midtones'],
    density: 0.9,
    detail: 0.3,
    progress: 0.18,
    strokes,
  };
}

/** Distant land: one soft band, low contrast, near the horizon. */
function landStage(horizon: number, rng: Rng): PlanStage {
  return {
    id: 'land',
    layer: 'Land',
    purpose: 'Distant land, held back by contrast',
    brush: 'soft_blend',
    depth: 'background',
    palette: ['shadows'],
    density: 0.7,
    detail: 0.2,
    progress: 0.14,
    strokes: [
      {
        primitive: 'cloud',
        region: band(Math.max(0, horizon - rng.range(0.04, 0.12)), rng.range(0.05, 0.12)),
        colorRole: 'shadows',
        energy: 0.35,
      },
    ],
  };
}

/**
 * Water: a dark base, then wave masses in bands that get coarser downward.
 *
 * The band structure is the whole trick. Perspective in a flat 2D picture is
 * spacing and size, so the marks nearest the horizon are small and tight and the
 * ones at the bottom edge are large and loose. A sea painted with one consistent
 * wave size looks like wallpaper.
 */
function waterStage(horizon: number, rng: Rng, detail: number): PlanStage {
  const depth = 1 - horizon;
  // Lighter at the horizon, darker toward the viewer, built from overlapping washes
  // for the same reason the sky is: stacked flat bands show their seams, and seams
  // are what made this look like sheets of plywood.
  const strokes: StrokeRecipe[] = [
    ...gradientWashes({ x: 0, y: horizon, width: 1, height: depth }, ['midtones', 'shadows', 'shadows'], {
      passes: 5,
      rng,
      energy: 0.85,
    }),
  ];

  const bands = 3 + Math.round(detail * 3);
  for (let i = 0; i < bands; i += 1) {
    const t = i / Math.max(1, bands - 1);
    const bandTop = horizon + depth * t * 0.85;
    // Clamped so the deepest band's jitter cannot push a region past the bottom
    // edge. Overlapping bands are fine and desirable; running off the canvas is
    // not, and the plan schema rejects it.
    const bandHeight = Math.min(depth - (bandTop - horizon), (depth / bands) * rng.range(0.9, 1.5));
    if (bandHeight <= 0.01) continue;
    // Segments, not one band across the canvas. A `wave` region spanning the full
    // width is a single horizontal line from edge to edge, and the water in every
    // render so far has been a stack of those — ropes. Real water is not continuous
    // across a frame: it is a run of separate swells at different lengths and
    // offsets, and breaking the band is what lets them overlap into a surface.
    const segments = 2 + Math.round(rng.range(0, 2));
    for (let k = 0; k < segments; k += 1) {
      const width = Math.min(1, rng.range(0.35, 0.8));
      strokes.push({
        primitive: 'wave',
        region: fit({
          x: rng.range(-0.08, Math.max(0, 1 - width)),
          // Reaches past the band above and below it. A swell that stops exactly at
          // its band draws a rounded edge there, and a run of them is the plywood.
          y: bandTop - bandHeight * 0.6 + rng.range(-0.02, 0.02),
          width,
          height: bandHeight * 2.2,
        }),
        // Texture, not value.
        //
        // The wash below already carries the water's value, dark toward the viewer.
        // Giving the waves a value of their own put a dark capsule on top of a dark
        // field and the segment's own length became its silhouette — the rounded dark
        // rectangles in the last render. Waves are how a *value field* is broken up,
        // not a second value field laid over the first, so they take the same role as
        // the water under them and only a little more of it.
        colorRole: t < 0.35 ? 'shadows' : 'midtones',
        // High frequency and a small amplitude keep the wave path tight so
        // consecutive stamps overlap into a sheet. Wide spacing and big amplitudes
        // gave chains of separate blobs, which read as beads on a string.
        frequency: rng.range(6, 9 + t * 6),
        amplitude: 0.012 + t * 0.02,
        energy: 0.14 + t * 0.12,
        jitter: 0.1 + t * 0.15,
      });
    }
  }

  return {
    id: 'water',
    layer: 'Water',
    purpose: 'Sea, banded so it recedes',
    brush: 'oil_large',
    depth: 'midground',
    palette: ['shadows', 'midtones'],
    density: 0.9,
    detail: 0.4,
    progress: 0.4,
    strokes,
  };
}

/**
 * Foam: bright, soft, and only at the tops of the near waves.
 *
 * Foreground by construction. Foam is the closest thing in the picture and it is
 * the first thing that looks wrong if it is painted at midground softness.
 */
function foamStage(horizon: number, rng: Rng, strength: number): PlanStage {
  const depth = 1 - horizon;
  const strokes: StrokeRecipe[] = [];
  const banks = 6 + Math.round(strength * 8);

  for (let i = 0; i < banks; i += 1) {
    // Width first, height from it, and only then a position that can hold the whole
    // thing. The first version placed the bank and derived its height afterwards,
    // which put banks at the very bottom edge where `fit` clamped them from 20px to
    // 2px — a row of hairlines across the front of the picture.
    const width = rng.range(0.05, 0.14);
    const height = width * rng.range(0.5, 0.9);
    const top = Math.min(1 - height, horizon + depth * rng.range(0.45, 0.99));
    strokes.push({
      primitive: 'cloud',
      region: {
        x: rng.range(-0.05, 0.95),
        // Weighted low: spray belongs at the front of the picture, and foam scattered
        // evenly from the horizon to the bottom edge reads as dust on a lens.
        y: top,
        width,
        height,
      },
      colorRole: 'highlights',
      energy: rng.range(0.5, 0.95),
    });
  }

  strokes.push({
    primitive: 'scatteredDabs',
    region: band(horizon + depth * 0.45, depth * 0.55),
    // Spread over the whole foreground rather than concentrated. Forty-plus dabs of
    // one colour into one region meant the later ones landed on the colour the
    // earlier ones had just produced — nine of fifty-three strokes reported nothing
    // changed, which was the plan's fault and not the verifier's.
    count: Math.round(14 + strength * 20),
    jitter: 0.5,
    colorRole: 'highlights',
  });

  return {
    id: 'foam',
    layer: 'Foam',
    purpose: 'Foam and spray, foreground crispness',
    brush: 'oil_small',
    depth: 'foreground',
    palette: ['highlights'],
    density: 0.8,
    detail: 0.6,
    progress: 0.75,
    strokes,
  };
}

/** A subject: small, sharp, and placed off-centre near the focal point. */
function subjectStage(brief: Brief, horizon: number, focal: { x: number; y: number }): PlanStage {
  const isShip = brief.elements.includes('ship');
  const name = isShip ? 'Ship' : 'Light source';
  // A ship stays small — it is what makes it a ship in a seascape. The moon was
  // made small by the same arithmetic and came out as a nick of paint, so the two
  // are now sized separately.
  const size = isShip ? 0.16 : 0.22;

  const strokes: StrokeRecipe[] = [
    {
      primitive: 'glaze',
      region: { x: focal.x - size / 2, y: focal.y - size * 0.2, width: size, height: size * 0.5 },
      colorRole: 'shadows',
      energy: 0.7,
    },
  ];

  if (isShip) {
    // Hull, sail, mast. Each is a fraction of the subject box rather than the full
    // width of it: the first version drew the hull across the whole box and the
    // ship came out as a black barcode with a hat.
    const hullWidth = size * 0.55;
    strokes.push(
      {
        primitive: 'line',
        region: { x: focal.x - hullWidth / 2, y: focal.y + size * 0.04, width: hullWidth, height: size * 0.012 },
        colorRole: 'shadows',
        energy: 0.9,
      },
      {
        // The sail is the bright note, and it is the tallest thing in the picture.
        primitive: 'arc',
        region: { x: focal.x - size * 0.1, y: focal.y - size * 0.62, width: size * 0.26, height: size * 0.66 },
        colorRole: 'highlights',
        energy: 0.6,
      },
      {
        primitive: 'line',
        region: { x: focal.x - size * 0.005, y: focal.y - size * 0.68, width: size * 0.014, height: size * 0.74 },
        colorRole: 'shadows',
        energy: 0.85,
      },
    );
  }

  if (!isShip) {
    // Light in the sky around the disc, not a bright edge on it. A disc with a
    // halo reads as a light; a disc alone reads as a sticker.
    strokes.push({
      primitive: 'glaze',
      region: { x: focal.x - size * 0.75, y: focal.y - size * 0.75, width: size * 1.5, height: size * 1.5 },
      colorRole: 'highlights',
      energy: 0.5,
      blendMode: 'screen',
    });
  }

  strokes.push({
    // A highlight just inside the form, not on its edge — the difference between
    // light in something and light painted onto it.
    primitive: 'highlight',
    region: { x: focal.x - size * 0.2, y: focal.y - size * 0.15, width: size * 0.5, height: size * 0.4 },
    colorRole: 'accents',
    energy: 0.8,
    blendMode: 'screen',
  });

  return {
    id: 'subject',
    layer: name,
    purpose: isShip ? 'The ship, small and off-centre' : 'The light, held inside the form',
    brush: 'oil_detail',
    depth: 'midground',
    palette: ['shadows', 'accents'],
    density: 1,
    detail: 0.9,
    progress: 0.88,
    strokes,
  };
}

/**
 * Final unifying pass: one broad glaze, low down, at very low opacity.
 *
 * It used to cover the entire canvas. A single colour over everything is by
 * construction a device for removing value differences — the critic measured the
 * result and reported the picture living inside a luminance band of 0.08, with the
 * horizon invisible, which is exactly what a full-canvas wash does and no accident
 * of colour choice can rescue.
 *
 * Atmospheric unification belongs near the horizon, where the air actually is, so
 * that is where it goes: a band sitting across the horizon line, light enough to
 * tie the two halves together without painting over either.
 */
function glazeStage(brief: Brief, horizon: number, rng: Rng): PlanStage {
  const depth = 1 - horizon;
  return {
    id: 'glaze',
    layer: 'Glaze',
    purpose: 'Unifying wash across the horizon, where the air is',
    brush: 'glaze',
    depth: 'midground',
    palette: ['midtones'],
    density: 0.5,
    detail: 0.1,
    progress: 0.93,
    strokes: [
      {
        primitive: 'glaze',
        region: band(Math.max(0, horizon - depth * 0.35), depth * 0.7),
        colorRole: 'highlights',
        energy: 0.25,
        jitter: rng.range(0.1, 0.3),
      },
    ],
  };
}

/**
 * Builds the ordered stages for a brief.
 *
 * Order is the contract: sky, then far land, then water, then foam, then the
 * subject, then the unifying glaze. Each recipe only assumes what came before it,
 * so `progress` is monotonic by construction and a run that stops after stage *n*
 * still reads as the picture at a rougher stage of itself.
 */
export function stagesFor(brief: Brief, horizon: number, focal: { x: number; y: number }, rng: Rng): PlanStage[] {
  const stages: PlanStage[] = [skyStage(brief, horizon, rng)];

  if (brief.elements.includes('clouds')) stages.push(cloudStage(brief, horizon, rng));
  if (brief.scene === 'landscape' && brief.elements.includes('mountains')) {
    stages.push(landStage(horizon, rng));
  }
  if (brief.hasGround && brief.scene === 'ocean') {
    const water = waterStage(horizon, rng, brief.detailLevel);
    // Crests belong to the water stage, so they ride the same bands and inherit
    // their depth. Painting them separately from the water is how they end up
    // floating at one uniform distance.
    // Crests. Light marks riding the swells, so they read as light on water rather
    // than as a pale sheet laid over it.
    for (let i = 0; i < 3; i += 1) {
      const width = rng.range(0.2, 0.55);
      water.strokes.push({
        primitive: 'highlight',
        region: fit({
          x: rng.range(-0.05, Math.max(0, 1 - width)),
          y: horizon + (1 - horizon) * rng.range(0.35, 0.9),
          width,
          height: (1 - horizon) * rng.range(0.02, 0.06),
        }),
        colorRole: 'highlights',
        energy: rng.range(0.3, 0.6),
        jitter: 0.4,
      });
    }
    stages.push(water);
  }
  if (brief.hasGround && brief.scene === 'landscape' && !brief.elements.includes('mountains')) {
    stages.push(landStage(horizon, rng));
  }

  if (brief.elements.includes('foam')) {
    const stormy = brief.atmosphere === 'dramatic' || brief.atmosphere === 'stormy';
    stages.push(foamStage(horizon, rng, stormy ? 1 : 0.5));
  }

  if (brief.elements.includes('ship') || brief.elements.includes('moon') || brief.elements.includes('sun')) {
    stages.push(subjectStage(brief, horizon, focal));
  }

  if (brief.texture !== 'smooth') stages.push(glazeStage(brief, horizon, rng));

  // Fitted only once every stage has been added, so later stages are covered too.
  return stages.map(fitStage);
}

/** Fits every region in a stage, leaving the rest of the recipe untouched. */
function fitStage(stage: PlanStage): PlanStage {
  return {
    ...stage,
    strokes: stage.strokes.map((stroke) => (stroke.region ? { ...stroke, region: fit(stroke.region) } : stroke)),
  };
}

/** Layer names, bottom-first: the order Photoshop stacks them in. */
export function layersFor(stages: PlanStage[]): string[] {
  const seen: string[] = [];
  for (const stage of stages) {
    if (!seen.includes(stage.layer)) seen.push(stage.layer);
  }
  return seen;
}

export type { StrokeRecipe };