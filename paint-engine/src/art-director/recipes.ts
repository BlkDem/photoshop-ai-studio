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
function skyStage(brief: Brief, horizon: number): PlanStage {
  const strokes: StrokeRecipe[] = [
    // Midtones, not shadows. A dark sky over a dark sea has no horizon: the first
    // version built both from `shadows` and the two thirds of the picture collapsed
    // into one flat field with an invisible line down the middle of it.
    { primitive: 'glaze', region: band(0, horizon * 0.98), colorRole: 'midtones', energy: 1 },
    // Light at the horizon, and the value falling away above it. A sky painted at
    // one value is a backdrop, not weather.
    { primitive: 'glaze', region: band(horizon * 0.62, horizon * 0.38), colorRole: 'highlights', energy: 0.9 },
  ];

  // A dark weight at the top of the sky, always. This is the top of the value range
  // on the sky side, and without it a bright sky has no ceiling for the clouds to
  // be darker than.
  strokes.unshift({ primitive: 'glaze', region: band(0, horizon * 0.5), colorRole: 'shadows', energy: 1 });

  if (brief.atmosphere === 'golden' || brief.colorTemperature === 'warm') {
    // Warm light low in the sky, near the horizon, because that is where a low
    // sun puts it.
    strokes.push({
      primitive: 'glaze',
      region: band(horizon * 0.55, horizon * 0.45),
      colorRole: 'accents',
      energy: 0.45,
      blendMode: 'screen',
    });
  }

  return {
    id: 'sky',
    layer: 'Sky',
    purpose: 'Sky base and depth',
    // oil_large, not soft_blend. soft_blend is defined at 0.3 opacity and 0.18 for
    // glaze, which is right for a glaze and useless for laying in a sky: on a
    // white ground two passes of it produced a picture with no tone in it at all.
    brush: 'oil_large',
    depth: 'background',
    palette: ['shadows', 'midtones'],
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
    // Wider and taller than a literal cloud. The critic reported that a third of the
    // canvas was untouched ground while every one of these looked reasonable in the
    // plan: a lobe 0.4 wide covers 4% of the picture, and a sky with three of them
    // is mostly still sky.
    const height = rng.range(0.22, 0.42) * horizon;
    strokes.push({
      primitive: 'cloud',
      region: {
        x: rng.range(-0.05, 0.5),
        y: rng.range(0, Math.max(0.05, horizon - height)),
        width: rng.range(0.5, 0.9),
        height,
      },
      colorRole: i % 2 === 0 ? 'shadows' : 'midtones',
      energy: rng.range(0.5, 0.95),
    });
  }

  // A lit top on each lobe. Without it the clouds are a single dark mass and a
  // stormy sky has no form in it at all.
  strokes.push({
    primitive: 'highlight',
    region: { x: 0.18, y: horizon * 0.1, width: 0.6, height: horizon * 0.3 },
    colorRole: 'midtones',
    energy: 0.3,
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
  const strokes: StrokeRecipe[] = [
    // Three passes: one dark, then two lighter, because a single glaze over a
    // ground the sky already darkened has nothing to build on and reads as a
    // flat sheet of the darkest value in the palette.
    { primitive: 'glaze', region: band(horizon, depth), colorRole: 'shadows', energy: 0.9 },
    { primitive: 'glaze', region: band(horizon, depth * 0.5), colorRole: 'shadows', energy: 0.5 },
    { primitive: 'glaze', region: band(horizon + depth * 0.45, depth * 0.55), colorRole: 'midtones', energy: 0.45 },
    // The deepest value in the picture, at the front. Water gets darker toward the
    // viewer because it is further from the light and in its own shadow, and a
    // painting with no dark in it has nothing for its lights to read against.
    //
    // Four passes, because one does not reach. A single stroke of the darkest colour
    // in the palette lands nowhere near it: the tip is a soft blob with a partial
    // core and the preview splits it into rings that each deposit a fraction of the
    // opacity. The critic measured the result at a luminance of 0.78 when the
    // palette's darkest is 0.10, so the value has to be built the way a painter
    // builds it — repeatedly, and never in one pass.
    { primitive: 'glaze', region: band(horizon + depth * 0.72, depth * 0.28), colorRole: 'shadows', energy: 1 },
    { primitive: 'glaze', region: band(horizon + depth * 0.6, depth * 0.4), colorRole: 'shadows', energy: 1 },
    { primitive: 'glaze', region: band(horizon + depth * 0.5, depth * 0.5), colorRole: 'shadows', energy: 0.9, jitter: 0.25 },
    { primitive: 'glaze', region: band(horizon, depth), colorRole: 'shadows', energy: 0.8, jitter: 0.3 },
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
    strokes.push({
      primitive: 'wave',
      region: band(bandTop, bandHeight),
      // Near the horizon the marks are small and dark; near the viewer, large and
      // lighter, which is how reflected light behaves on a moving surface.
      colorRole: t < 0.4 ? 'shadows' : 'midtones',
      // High frequency and a small amplitude keep the wave path tight so
      // consecutive stamps overlap into a sheet. Wide spacing and big amplitudes
      // gave chains of separate blobs, which read as beads on a string.
      frequency: rng.range(6, 9 + t * 6),
      amplitude: 0.012 + t * 0.02,
      energy: 0.35 + t * 0.25,
      jitter: 0.1 + t * 0.15,
    });
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
  const banks = 2 + Math.round(strength * 3);

  for (let i = 0; i < banks; i += 1) {
    strokes.push({
      primitive: 'cloud',
      region: {
        x: rng.range(0, 0.6),
        // Weighted low. Spray belongs at the front of the picture; foam scattered
        // evenly from the horizon to the bottom edge reads as dust on a lens.
        y: horizon + depth * rng.range(0.55, 0.99),
        width: rng.range(0.35, 0.7),
        height: depth * rng.range(0.04, 0.1),
      },
      colorRole: 'highlights',
      energy: rng.range(0.5, 0.95),
    });
  }

  strokes.push({
    primitive: 'scatteredDabs',
    region: band(horizon + depth * 0.6, depth * 0.4),
    count: Math.round(20 + strength * 40),
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
  const stages: PlanStage[] = [skyStage(brief, horizon)];

  if (brief.elements.includes('clouds')) stages.push(cloudStage(brief, horizon, rng));
  if (brief.scene === 'landscape' && brief.elements.includes('mountains')) {
    stages.push(landStage(horizon, rng));
  }
  if (brief.hasGround && brief.scene === 'ocean') {
    const water = waterStage(horizon, rng, brief.detailLevel);
    // Crests belong to the water stage, so they ride the same bands and inherit
    // their depth. Painting them separately from the water is how they end up
    // floating at one uniform distance.
    water.strokes.push({
      primitive: 'highlight',
      region: band(horizon + (1 - horizon) * 0.45, (1 - horizon) * 0.55),
      colorRole: 'highlights',
      energy: 0.35,
      jitter: 0.4,
    });
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