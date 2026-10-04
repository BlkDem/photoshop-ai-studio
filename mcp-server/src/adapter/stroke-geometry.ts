import type { Point } from '@photoshop-ai-studio/shared';

/**
 * Mock stroke geometry — a mirror of `photoshop-plugin/lib/ops/stroke-geometry.js`.
 *
 * The mock cannot import the plugin's copy: the plugin is deliberately
 * build-free CommonJS that ships straight to a UXP host, and `shared` is not
 * allowed to depend on it. That leaves two implementations of one algorithm,
 * which is exactly the setup where a mock quietly stops predicting Photoshop.
 *
 * So the duplication is made safe instead of avoided:
 * `mcp-server/test/stroke-geometry.test.ts` runs a shared table of paths through
 * both files and asserts they emit identical stamps. The plugin side is the
 * reference; this side is the one that has to be fixed when it disagrees.
 *
 * Extracted into its own module so that test can reach it — the mock adapter
 * keeps these helpers private for everything else.
 */

type Segment = {
  type: 'move' | 'line' | 'curve';
  point: { x: number; y: number };
  cp1?: { x: number; y: number };
  cp2?: { x: number; y: number };
};

/** A flattened path: the point list plus the index at which each subpath begins. */
type FlatPath = { points: Point[]; starts: number[] };

/**
 * Flattens `stroke_path` segments into points, recording where each subpath
 * begins.
 *
 * A `curve` is sampled as a real cubic Bézier starting from the *previous*
 * endpoint. Two mistakes live here otherwise: treating the curve's own endpoint
 * as the start point draws a visibly different arc, and flattening the whole
 * path into one run of points bridges every `move` — so two separate marks come
 * out joined by an ink line the caller never asked for.
 *
 * Mirrors `flattenSegments` in `photoshop-plugin/lib/ops/stroke-geometry.js`.
 */
function flattenSegments(segments: ReadonlyArray<Segment>): FlatPath {
  const points: Point[] = [];
  const starts: number[] = [];
  let cursor: Point | null = null;

  for (const segment of segments) {
    if (!segment?.point) continue;

    if (segment.type === 'move') {
      starts.push(points.length);
      points.push({ x: segment.point.x, y: segment.point.y });
      cursor = segment.point;
    } else if (segment.type === 'line') {
      // A path that opens with a `line` has no start point yet; the segment's
      // own endpoint is the only position known.
      if (!cursor) {
        starts.push(points.length);
        cursor = segment.point;
      }
      points.push({ x: segment.point.x, y: segment.point.y });
      cursor = segment.point;
    } else if (segment.type === 'curve') {
      if (!cursor) {
        starts.push(points.length);
        points.push({ x: segment.point.x, y: segment.point.y });
        cursor = segment.point;
        continue;
      }
      if (segment.cp1 && segment.cp2) {
        flattenCubic(cursor, segment.cp1, segment.cp2, segment.point, points);
      } else {
        points.push({ x: segment.point.x, y: segment.point.y });
      }
      cursor = segment.point;
    }
  }

  return { points, starts };
}

/**
 * Samples a cubic Bézier, skipping the t=0 endpoint the previous point already
 * contributed.
 *
 * The step count is derived from the control polygon's length rather than fixed:
 * a long curve needs the samples to keep the stamps from cutting the corner,
 * and a short one does not benefit from oversampling — which also inflates the
 * stamp count. Clamped to 2..64 so a degenerate path cannot ask for unbounded
 * work.
 */
function flattenCubic(from: Point, cp1: Point, cp2: Point, to: Point, out: Point[]): void {
  const controlLength =
    Math.hypot(cp1.x - from.x, cp1.y - from.y) +
    Math.hypot(cp2.x - cp1.x, cp2.y - cp1.y) +
    Math.hypot(to.x - cp2.x, to.y - cp2.y);
  const steps = Math.max(2, Math.min(64, Math.ceil(controlLength / 3)));

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    out.push({
      x: a * from.x + b * cp1.x + c * cp2.x + d * to.x,
      y: a * from.y + b * cp1.y + c * cp2.y + d * to.y,
    });
  }
}

/**
 * Maps the public `smoothing` knob (0-100) onto a pass count.
 *
 * Mirrors `photoshop-plugin/lib/ops/stroke-geometry.js`: every pass roughly
 * doubles the point count, so the raw dial would explode, and a mock that
 * exploded where the plugin did not would make the cross-check test lie.
 */
function smoothingIterations(smoothing: number): number {
  const value = Number(smoothing);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // Any positive value earns at least one pass: a caller who asks for a little
  // smoothing and gets a perfectly jaggy line has been ignored, which is the
  // one outcome worse than too much of it.
  return Math.min(4, Math.max(1, Math.round(value / 25)));
}

/**
 * Chaikin corner-cutting run `iterations` times, per subpath.
 *
 * Boundaries are honoured, so smoothing rounds corners inside a subpath without
 * ever pulling a point across a `move`.
 *
 * `iterations` is a pass count, not the user-facing dial: callers go through
 * `smoothingIterations` first.
 */
function smoothPoints(path: FlatPath, iterations: number): FlatPath {
  if (iterations <= 0 || path.points.length < 3) return path;

  let current = path.points;
  let boundaries = path.starts.length > 0 ? path.starts.slice() : [0];

  for (let pass = 0; pass < iterations; pass += 1) {
    const next: Point[] = [];
    const nextBoundaries: number[] = [];

    for (let s = 0; s < boundaries.length; s += 1) {
      const from = boundaries[s]!;
      const to = s + 1 < boundaries.length ? boundaries[s + 1]! : current.length;
      const run = current.slice(from, to);
      if (run.length === 0) continue;

      nextBoundaries.push(next.length);

      // Under three points there is no corner to cut, so the subpath is kept
      // verbatim — a `move`/`line` pair is exactly that.
      if (run.length < 3) {
        next.push(...run);
        continue;
      }

      next.push(run[0]!);
      for (let i = 0; i < run.length - 1; i += 1) {
        const a = run[i]!;
        const b = run[i + 1]!;
        next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      next.push(run[run.length - 1]!);
    }

    current = next;
    boundaries = nextBoundaries;
  }

  return { points: current, starts: boundaries };
}

/**
 * Drops points that sit closer together than `tolerance`.
 *
 * Bézier flattening oversamples, and a replayed mouse drag can repeat one
 * coordinate hundreds of times; keeping them would make the stamp count
 * proportional to the input rather than to the distance travelled.
 */
function dropDuplicatePoints(path: FlatPath, tolerance: number): FlatPath {
  if (path.points.length === 0) return path;
  const minGap = Math.max(0, tolerance);
  const kept: Point[] = [path.points[0]!];
  const keptStarts: number[] = [0];

  for (let i = 1; i < path.points.length; i += 1) {
    const point = path.points[i]!;
    const isSubpathStart = path.starts.includes(i);
    const previous = kept[kept.length - 1]!;
    if (isSubpathStart || Math.hypot(previous.x - point.x, previous.y - point.y) >= minGap) {
      if (isSubpathStart) keptStarts.push(kept.length);
      kept.push(point);
    }
  }

  return { points: kept, starts: keptStarts };
}

/** The pressure profile along a stroke: 0 at both ends, 1 in the middle. */
function pressureAt(t: number): number {
  return Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
}

/** Disc spacing for a given radius, so neighbouring discs always overlap. */
function stampSpacing(radius: number): number {
  return Math.max(0.35, Math.min(radius, radius * 0.4));
}

/**
 * Walks each subpath and emits overlapping discs along it.
 *
 * The subpath's own length drives the pressure ramp, so a stroke of two separate
 * marks tapers each of them rather than the pair as a whole. A single-point
 * subpath is a dot, matching a click with no drag.
 */
function rasterizeStamps(
  path: FlatPath,
  radius: number,
  smoothing: number,
  simulatePressure: boolean,
  maxStamps: number,
): Array<{ x: number; y: number; r: number }> {
  const smoothed = dropDuplicatePoints(smoothPoints(path, smoothingIterations(smoothing)), 0.01);
  const stamps: Array<{ x: number; y: number; r: number }> = [];
  const baseRadius = Math.max(0.5, radius);
  const boundaries = smoothed.starts.length > 0 ? smoothed.starts : [0];

  for (let s = 0; s < boundaries.length && stamps.length < maxStamps; s += 1) {
    const from = boundaries[s]!;
    const to = s + 1 < boundaries.length ? boundaries[s + 1]! : smoothed.points.length;
    const run = smoothed.points.slice(from, to);
    if (run.length === 0) continue;

    let length = 0;
    for (let k = 1; k < run.length; k += 1) {
      length += Math.hypot(run[k]!.x - run[k - 1]!.x, run[k]!.y - run[k - 1]!.y);
    }

    if (run.length === 1 || length < 0.5) {
      stamps.push({ x: run[0]!.x, y: run[0]!.y, r: simulatePressure ? baseRadius * 0.15 : baseRadius });
      continue;
    }

    let walked = 0;

    for (let i = 1; i < run.length && stamps.length < maxStamps; i += 1) {
      const a = run[i - 1]!;
      const b = run[i]!;
      const segLength = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLength < 1e-6) continue;

      const segmentStart = walked;

      // Pressure is sampled before stepping, so the narrowest disc also sets the
      // spacing. Sampling afterwards lets the spacing stay wide while the disc
      // shrinks, which is how a tapered end ends up dotted.
      for (;;) {
        let pressure = simulatePressure ? pressureAt(segmentStart / length) : 1;
        if (pressure < 0.02) pressure = 0.02;
        const step = stampSpacing(baseRadius * pressure);

        const remaining = segLength - (walked - segmentStart);
        if (remaining <= 1e-9) break;

        walked += Math.min(step, remaining);
        const along = (walked - segmentStart) / segLength;
        const stampPressure = simulatePressure ? pressureAt(walked / length) : 1;

        if (stamps.length >= maxStamps) break;
        stamps.push({
          x: a.x + (b.x - a.x) * along,
          y: a.y + (b.y - a.y) * along,
          r: Math.max(0.5, baseRadius * stampPressure),
        });
      }
    }
  }

  return stamps;
}


export type { FlatPath, Segment };
export { flattenSegments, flattenCubic, smoothingIterations, smoothPoints, dropDuplicatePoints, pressureAt, stampSpacing, rasterizeStamps };
