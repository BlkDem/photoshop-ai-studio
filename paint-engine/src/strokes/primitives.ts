/**
 * Procedural marks.
 *
 * Each generator turns one `StrokeRecipe` into a list of paths. A path is a
 * flat run of normalized points; the engine hands those to the paint engine, which
 * sweeps a synthesized tip along them.
 *
 * Two decisions run through all of them:
 *
 *  - **Regions, not coordinates.** A generator is told a box and works inside it.
 *    This is what lets a plan be re-rendered at another resolution without
 *    re-deciding the picture.
 *  - **Ends are never square.** Every mark that is not explicitly a straight rule
 *    gets its ends pulled in, because a mark that stops dead reads as a line on
 *    the canvas rather than as a brush that lifted.
 */

import type { NormalizedPoint, NormalizedRect, StrokeRecipe } from '../types.js';
import type { Rng } from '../random.js';

export type Path = NormalizedPoint[];

/** Resolves a recipe's heading to a unit vector, defaulting to horizontal. */
function heading(recipe: StrokeRecipe): NormalizedPoint {
  const raw = recipe.direction ?? { x: 1, y: 0 };
  const length = Math.hypot(raw.x, raw.y);
  if (length < 1e-6) return { x: 1, y: 0 };
  return { x: raw.x / length, y: raw.y / length };
}

/** The centre of a region. */
function center(region: NormalizedRect): NormalizedPoint {
  return { x: region.x + region.width / 2, y: region.y + region.height / 2 };
}

/** A point inside the region, uniform over its area. */
function inside(region: NormalizedRect, rng: Rng): NormalizedPoint {
  return {
    x: region.x + rng.next() * region.width,
    y: region.y + rng.next() * region.height,
  };
}

/** The region's diagonal, used as the default mark length. */
function span(region: NormalizedRect): number {
  return Math.hypot(region.width, region.height);
}

/**
 * Samples a path at a parameter in 0..1, tapering the ends.
 *
 * `taper` pulls the mark's length in slightly and is applied by remapping the
 * parameter rather than by trimming points, so the curve's shape survives.
 */
function taperParam(t: number, amount: number): number {
  if (amount <= 0) return t;
  // Concentrate samples toward the ends without moving them.
  const centred = t * 2 - 1;
  const pulled = Math.sign(centred) * Math.pow(Math.abs(centred), 1 + amount * 0.6);
  return pulled / 2 + 0.5;
}

function samples(count: number): number[] {
  const steps = Math.max(2, Math.round(count));
  return Array.from({ length: steps + 1 }, (_, i) => i / steps);
}

/**
 * Pulls the first and last points toward the interior.
 *
 * The visual effect is a mark that thins as it lands, which is what separates a
 * brush stroke from a line drawn with a round pen.
 */
function softenEnds(path: Path, amount: number, rng: Rng): Path {
  if (path.length < 3 || amount <= 0) return path;
  const first = path[0] as Path[number];
  const last = path[path.length - 1] as Path[number];
  const c = centerOf(path);
  const pull = (point: NormalizedPoint, target: NormalizedPoint): void => {
    point.x += (target.x - point.x) * amount + rng.gaussian() * 0.004;
    point.y += (target.y - point.y) * amount + rng.gaussian() * 0.004;
  };
  pull(first, c);
  pull(last, c);
  return path;
}

function centerOf(path: Path): NormalizedPoint {
  let x = 0;
  let y = 0;
  for (const point of path) {
    x += point.x;
    y += point.y;
  }
  return { x: x / path.length, y: y / path.length };
}

/** Straight mark across a region. */
export function line(recipe: StrokeRecipe, rng: Rng): Path[] {
  const dir = heading(recipe);
  const length = span(recipe.region) * (0.5 + 0.5 * (recipe.energy ?? 0.7));
  const c = center(recipe.region);
  const jitter = (recipe.jitter ?? 0) * 0.05;

  const path: Path = samples(12).map((t) => {
    const offset = (t - 0.5) * length;
    const wobble = rng.gaussian() * jitter * length * 0.1;
    return {
      x: c.x + dir.x * offset - dir.y * wobble,
      y: c.y + dir.y * offset + dir.x * wobble,
    };
  });
  return [path];
}

/** A bowed mark. `curvature` 0 is straight, 1 bows by a quarter of the length. */
export function curve(recipe: StrokeRecipe, rng: Rng): Path[] {
  const dir = heading(recipe);
  const c = center(recipe.region);
  const length = span(recipe.region) * (0.55 + 0.45 * (recipe.energy ?? 0.7));
  const curvature = (recipe.curvature ?? 0.4) * length * 0.35;
  const jitter = (recipe.jitter ?? 0) * 0.04;
  // Perpendicular to the heading, which is where a bow can go.
  const px = -dir.y;
  const py = dir.x;

  const path: Path = samples(16).map((t) => {
    const offset = (t - 0.5) * length;
    const bow = Math.sin(Math.PI * t) * curvature;
    const wobble = rng.gaussian() * jitter * length * 0.08;
    return {
      x: c.x + dir.x * offset + px * (bow + wobble),
      y: c.y + dir.y * offset + py * (bow + wobble),
    };
  });
  return [softenEnds(path, recipe.taper === false ? 0 : 0.12, rng)];
}

/**
 * A travelling wave — the mark that makes water read as water.
 *
 * `amplitude` is peak displacement in canvas-height units and `frequency` is
 * crossings per unit length, so a wave's *shape* is independent of how long the
 * mark is. Envelope tapering damps the oscillation toward both ends, which is
 * what stops it looking like a drawn sine rather than a moving body of water.
 */
export function wave(recipe: StrokeRecipe, rng: Rng): Path[] {
  const dir = heading(recipe);
  const c = center(recipe.region);
  const length = span(recipe.region) * (0.6 + 0.4 * (recipe.energy ?? 0.7));
  const amplitude = (recipe.amplitude ?? 0.05) * recipe.region.height * 2.4;
  const frequency = recipe.frequency ?? 3;
  const px = -dir.y;
  const py = dir.x;

  const path: Path = samples(28).map((t) => {
    const offset = (t - 0.5) * length;
    const envelope = Math.sin(Math.PI * t);
    const displacement = Math.sin(t * Math.PI * 2 * frequency) * amplitude * envelope;
    const noise = rng.gaussian() * amplitude * 0.08;
    return {
      x: c.x + dir.x * offset + px * (displacement + noise),
      y: c.y + dir.y * offset + py * (displacement + noise),
    };
  });
  return [softenEnds(path, 0.1, rng)];
}

/** A circular arc, for crests, rain and the curve of a shoulder. */
export function arc(recipe: StrokeRecipe, rng: Rng): Path[] {
  const c = center(recipe.region);
  // Clamped to half the shorter side: an arc wider than that bulges out of its
  // own region, which for a crest means painting over whatever is next to it.
  const room = Math.min(recipe.region.width, recipe.region.height) / 2;
  const radius = Math.max(0.01, Math.min(room, Math.min(recipe.region.width, recipe.region.height) * (0.35 + 0.5 * (recipe.energy ?? 0.6))));
  const sweep = (recipe.curvature ?? 0.5) * Math.PI * 1.4;
  const start = Math.atan2(recipe.direction?.y ?? -1, recipe.direction?.x ?? 0);

  const path: Path = samples(20).map((s) => {
    const angle = start + sweep * (s - 0.5);
    const wobble = radius * rng.gaussian() * 0.01;
    return {
      x: c.x + Math.cos(angle) * (radius + wobble),
      y: c.y + Math.sin(angle) * (radius + wobble),
    };
  });
  return [softenEnds(path, 0.14, rng)];
}

/**
 * A billow: overlapping lobes along a spine.
 *
 * Clouds, foam banks and breaking water are all the same shape — a run of
 * convex lumps — so one generator covers all three, and the lobe count is driven
 * by the region's width rather than asked for.
 */
export function cloud(recipe: StrokeRecipe, rng: Rng): Path[] {
  const dir = heading(recipe);
  const c = center(recipe.region);
  const length = span(recipe.region);
  const lobes = Math.max(3, Math.round(length * 6 * (0.5 + (recipe.energy ?? 0.6))));
  // Amplitude off the region's *short* axis, so a shallow foam bank is as billowy as
  // a tall cloud. It used to be scaled by the height, which meant the flatter the
  // bank the flatter the lump — exactly backwards for a bank of foam.
  const short = Math.min(recipe.region.width, recipe.region.height);
  // Amplitude and the pass offsets both push sideways from the centre, so they share
  // one budget. Splitting it wrong makes the union of the runs stick out of the
  // region, which the schema rejects and which would paint over a neighbour's marks.
  const budget = short * 0.5 * 0.85;
  const amplitudeParam = recipe.amplitude ?? 0.4;
  // Amplitude against the region's *height*, not against the shared budget.
  //
  // Measured: a cloud asked for a 140x78px region came out 140px long and 21px tall —
  // it filled a quarter of its own box, so it read as a ribbon with lobes rather than
  // as a billow. The budget split was the wrong model: it conflated "how far the whole
  // shape wanders" with "how deep the lobes are", and lobes are a property of the
  // height. A shallow foam bank still comes out shallow, because its region is.
  const amplitude = (amplitudeParam / 0.4) * recipe.region.height * 0.38;
  const px = -dir.y;
  const py = dir.x;
  // Passes stack across the short axis: vertically for a wide sky band, side to side
  // for a tall one.
  const across = recipe.region.width >= recipe.region.height ? { x: px, y: py } : { x: dir.x, y: dir.y };

  const paths: Path[] = [];
  for (const offsetFraction of passOffsets(recipe.region, recipe.count ?? 3, rng)) {
    const shift = offsetFraction * budget * 0.55;
    // A different phase per pass, or every run undulates in step and the three
    // together read as one thick wavy line again.
    const phase = rng.next() * Math.PI * 2;
    const runLength = length * rng.range(0.75, 1);
    const steps = lobes * 6;

    const path: Path = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const offset = (t - 0.5) * runLength;
      const envelope = Math.sin(Math.PI * t) ** 0.6;
      const lobe = Math.sin(t * Math.PI * 2 * lobes + phase);
      const second = Math.sin(t * Math.PI * 2 * lobes * 0.5 + phase * 1.7) * 0.4;
      const displacement = (lobe + second) * amplitude * envelope;
      path.push({
        x: c.x + dir.x * offset + px * displacement + across.x * shift,
        y: c.y + dir.y * offset + py * displacement + across.y * shift,
      });
    }
    paths.push(softenEnds(path, 0.08, rng));
  }
  return paths;
}

/** Parallel lines at a given angle — the classical way to build a value. */
export function hatching(recipe: StrokeRecipe, rng: Rng): Path[] {
  const count = recipe.count ?? 8;
  const angle = (recipe.curvature ?? 0.5) * Math.PI;
  const region = recipe.region;
  const paths: Path[] = [];
  const step = 1 / count;

  for (let i = 0; i < count; i += 1) {
    const offset = (i + 0.5) * step;
    const p0 = offsetPoint(region, offset, angle, -0.05);
    const p1 = offsetPoint(region, offset, angle, 1.05);
    const waviness = (recipe.jitter ?? 0) * 0.01;
    paths.push(
      samples(10).map((t) => {
        const x = p0.x + (p1.x - p0.x) * t;
        const y = p0.y + (p1.y - p0.y) * t;
        const wobble = rng.gaussian() * waviness;
        return { x, y: y + wobble };
      }),
    );
  }
  return paths;
}

/**
 * Two hatch passes at right angles.
 *
 * The second pass is deliberately thinner and fainter: equal-weight cross
 * hatching reads as a woven fabric, which is almost never what a sky or a shadow
 * wants.
 */
export function crossHatching(recipe: StrokeRecipe, rng: Rng): Path[] {
  const first = hatching(recipe, rng);
  const mirrored: StrokeRecipe = {
    ...recipe,
    curvature: 1 - (recipe.curvature ?? 0.5),
    count: recipe.count,
  };
  return [...first, ...hatching(mirrored, rng)];
}

/**
 * Nominal length of a counting mark.
 *
 * Prefers the engine-supplied `size` (the brush diameter) and falls back to the
 * region's smaller side. Sizing from the region instead is what turns a
 * `scatteredDabs` over a wide area into a field of long straight sticks: the
 * region is big, so every mark is long, and a dab two brushes wide is straw.
 */
function markLength(recipe: StrokeRecipe, floor: number): number {
  const scale = typeof recipe.size === 'number' && recipe.size > 0
    ? recipe.size
    : Math.min(recipe.region.width, recipe.region.height);
  return Math.max(floor, scale);
}

/** Short repeated marks — grass, spray, sparkle. */
export function dabs(recipe: StrokeRecipe, rng: Rng): Path[] {
  const count = recipe.count ?? 12;
  const paths: Path[] = [];
  const nominal = markLength(recipe, 0.004);
  for (let i = 0; i < count; i += 1) {
    const origin = inside(recipe.region, rng);
    const length = nominal * (0.4 + 0.7 * rng.next());
    const angle = rng.next() * Math.PI;
    paths.push([
      { x: origin.x, y: origin.y },
      { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length },
    ]);
  }
  return paths;
}

/**
 * Dabs with real scatter.
 *
 * The difference from `dabs` is that position, length and angle are all
 * gaussian-distributed rather than uniform, which is what stops a hundred marks
 * from reading as a regular grid.
 */
export function scatteredDabs(recipe: StrokeRecipe, rng: Rng): Path[] {
  const count = recipe.count ?? 20;
  const spread = recipe.jitter ?? 0.4;
  const paths: Path[] = [];
  const c = center(recipe.region);
  const nominal = markLength(recipe, 0.004);
  for (let i = 0; i < count; i += 1) {
    const origin = inside(recipe.region, rng);
    const pulled = {
      x: origin.x + rng.gaussian() * spread * recipe.region.width * 0.25,
      y: origin.y + rng.gaussian() * spread * recipe.region.height * 0.25,
    };
    const length = nominal * (0.25 + 0.8 * Math.abs(rng.gaussian()));
    const angle = rng.next() * Math.PI * 2;
    paths.push([
      { x: pulled.x, y: pulled.y },
      {
        x: pulled.x + Math.cos(angle) * length + (c.x - pulled.x) * 0.02,
        y: pulled.y + Math.sin(angle) * length + (c.y - pulled.y) * 0.02,
      },
    ]);
  }
  return paths;
}

/**
 * A tapered highlight.
 *
 * Bright marks are the one place where a hard start and a hard stop are both
 * wrong, so the mark is generated along the region's short axis and tapered hard
 * at both ends — this is the shape a loaded brush leaves when it is drawn across
 * a form.
 */
export function highlight(recipe: StrokeRecipe, rng: Rng): Path[] {
  const c = center(recipe.region);
  const length = Math.max(recipe.region.width, recipe.region.height) * (0.5 + 0.4 * (recipe.energy ?? 0.7));
  const thickness = Math.min(recipe.region.width, recipe.region.height) * 0.25;
  const vertical = recipe.region.height < recipe.region.width;

  const path: Path = samples(18).map((raw) => {
    const t = taperParam(raw, 0.8);
    const along = (t - 0.5) * length;
    const across = Math.sin(Math.PI * t) * thickness * rng.range(0.6, 1.1);
    return vertical
      ? { x: c.x + across, y: c.y + along }
      : { x: c.x + along, y: c.y + across };
  });
  return [path];
}

/**
 * Offsets for a set of parallel passes across a region's short axis.
 *
 * A single swept path paints a *line*. Every recipe that says "lay in this field"
 * — sky, water, a cloud, a bank of foam — needs the union of several paths to be a
 * *shape*, and a line with soft ends reads as a capsule with a visible boundary
 * rather than as a wash. That is what a stack of them looks like: the water in the
 * first real render was four or five horizontal tubes, one per glaze, each with a
 * rounded cap and its own value.
 *
 * Three passes is chosen against the cost. Fills dominate painting time — measured,
 * not assumed (§4.4 of the painting notes) — and passes multiply stamps, so the
 * useful range is narrow: two passes still read as one capsule because the second
 * lands inside the first, and eight pass times the fills to buy nothing the eye can
 * name. Three, offset across the region and jittered in length, is enough to break
 * the silhouette without a cost the picture cannot justify.
 *
 * `count` on the recipe overrides, for a field that genuinely needs more.
 */
function passOffsets(region: NormalizedRect, count: number, rng: Rng): number[] {
  const n = Math.max(2, Math.round(count));
  if (n === 2) return [-0.3, 0.3];
  const offsets: number[] = [];
  for (let i = 0; i < n; i += 1) {
    // Evenly across the region, then jittered so the passes do not stack into a
    // regular ladder — which is the same defect one level up.
    const even = n === 1 ? 0 : i / (n - 1) - 0.5;
    offsets.push(even + rng.range(-0.08, 0.08));
  }
  return offsets;
}

/**
 * A broad, nearly transparent sweep across the whole region.
 *
 * Glazes are the trick that makes a synthetic painting stop looking synthetic:
 * one pass of a very soft, very low-opacity mark over a finished area pulls its
 * colours toward each other the way real wet paint does.
 */
export function glaze(recipe: StrokeRecipe, rng: Rng): Path[] {
  const dir = heading(recipe);
  const c = center(recipe.region);
  const length = span(recipe.region) * 1.15;
  const amplitude = (recipe.amplitude ?? 0.15) * recipe.region.height;
  const px = -dir.y;
  const py = dir.x;
  const drift = rng.range(-0.2, 0.2);

  // Offset across the region's *short* axis, so a wide band gets its passes stacked
  // vertically and a tall one gets them side to side. Using the long axis instead
  // would put every pass on top of the first for a band that is wider than it is
  // tall, which is most of them.
  const across = recipe.region.width >= recipe.region.height ? { x: px, y: py } : { x: dir.x, y: dir.y };
  const thickness = recipe.region.width >= recipe.region.height ? recipe.region.height : recipe.region.width;

  const paths: Path[] = [];
  for (const offsetFraction of passOffsets(recipe.region, recipe.count ?? 4, rng)) {
    const shift = offsetFraction * thickness * 0.5 * 0.85;
    // Lengths vary per pass so the ends do not align into a single rounded cap.
    const passLength = length * rng.range(0.82, 1.05);
    const path: Path = samples(20).map((t) => {
      const offset = (t - 0.5) * passLength;
      const bow = Math.sin(Math.PI * t) * amplitude;
      const sweep = Math.sin(Math.PI * 2 * t + drift) * amplitude * 0.4;
      return {
        x: c.x + dir.x * offset + px * (bow + sweep) + across.x * shift,
        y: c.y + dir.y * offset + py * (bow + sweep) + across.y * shift,
      };
    });
    paths.push(softenEnds(path, 0.05, rng));
  }
  return paths;
}

/** Slides a point along a line crossing a region at a given fraction. */
function offsetPoint(region: NormalizedRect, offset: number, angle: number, extend: number): NormalizedPoint {
  const cx = region.x + region.width / 2;
  const cy = region.y + region.height / 2;
  // Work on the region's own diagonal so the hatch always covers it.
  const half = (Math.hypot(region.width, region.height) / 2) * extend;
  const dx = Math.cos(angle) * half;
  const dy = Math.sin(angle) * half;
  // Perpendicular displacement picks which line of the hatch this is.
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const step = (region.width + region.height) / 2;
  return {
    x: cx + nx * (offset - 0.5) * step + dx,
    y: cy + ny * (offset - 0.5) * step + dy,
  };
}

/** The primitive table. Adding a mark shape means adding a line here and a type. */
export const PRIMITIVES = {
  line,
  curve,
  wave,
  arc,
  cloud,
  hatching,
  crossHatching,
  dabs,
  scatteredDabs,
  highlight,
  glaze,
} as const;

export type PrimitiveName = keyof typeof PRIMITIVES;