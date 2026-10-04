/**
 * Gradient geometry, mirrored from `photoshop-plugin/lib/ops/gradient-geometry.js`.
 *
 * The plugin cannot be imported here — it ships as build-free CommonJS for a UXP
 * host — so this is a second copy of the same arithmetic, and
 * `mcp-server/test/stroke-geometry.test.ts` runs both through the same cases. A
 * divergence would mean a plan rehearsed against gradients the finished document
 * will not have.
 */
import type { Point } from '@photoshop-ai-studio/shared';

const MAX_BANDS = 256;
const BAND_EPSILON = 0.01;

export interface GradientStopInput {
  position: number;
  color: { r: number; g: number; b: number };
}

export interface NormalizedStop {
  position: number;
  color: { r: number; g: number; b: number };
}

export interface GradientBand {
  bounds: { left: number; top: number; right: number; bottom: number };
  color: { r: number; g: number; b: number };
  t: number;
}

const AXES: Record<string, { x: number; y: number }> = {
  topToBottom: { x: 0, y: 1 },
  bottomToTop: { x: 0, y: -1 },
  leftToRight: { x: 1, y: 0 },
  rightToLeft: { x: -1, y: 0 },
};

const clampByte = (value: unknown): number =>
  Math.round(Math.max(0, Math.min(255, typeof value === 'number' ? value : 0)));

export function normalizeStops(stops: GradientStopInput[] | undefined): NormalizedStop[] {
  const sorted = (stops ?? [])
    .map((stop) => {
      const raw = Number(stop.position);
      return {
        position: Math.min(100, Math.max(0, isFinite(raw) ? raw : 0)),
        color: { r: clampByte(stop.color?.r), g: clampByte(stop.color?.g), b: clampByte(stop.color?.b) },
      };
    })
    .sort((a, b) => a.position - b.position);

  if (sorted.length >= 2 && sorted[0]!.position === sorted[1]!.position) {
    sorted[1] = {
      position: Math.min(100, sorted[0]!.position + BAND_EPSILON),
      color: sorted[1]!.color,
    };
  }

  return sorted;
}

export function colorAt(stops: NormalizedStop[], t: number): { r: number; g: number; b: number } {
  const clamped = Math.min(1, Math.max(0, Number(t)));
  if (clamped <= stops[0]!.position / 100) return stops[0]!.color;
  const last = stops[stops.length - 1]!;
  if (clamped >= last.position / 100) return last.color;

  for (let i = 0; i < stops.length - 1; i += 1) {
    const from = stops[i]!;
    const to = stops[i + 1]!;
    if (clamped < from.position / 100 || clamped > to.position / 100) continue;
    const span = (to.position - from.position) / 100;
    if (span <= 0) return to.color;
    const local = (clamped - from.position / 100) / span;
    return {
      r: Math.round(from.color.r + (to.color.r - from.color.r) * local),
      g: Math.round(from.color.g + (to.color.g - from.color.g) * local),
      b: Math.round(from.color.b + (to.color.b - from.color.b) * local),
    };
  }
  return last.color;
}

export function resolveBands(requested: number | undefined): { bands: number; truncated: boolean } {
  const asked = Math.round(Number(requested));
  const safe = !isFinite(asked) || asked < 2 ? 2 : asked;
  return { bands: Math.min(MAX_BANDS, safe), truncated: safe > MAX_BANDS };
}

/**
 * Blend modes under which overlapping rings add up, and the one formula they share.
 *
 * Mirrors the plugin: `screen` and `linearDodge` compose as `1 - (1-a)(1-b)`, so
 * a stack of overlapping fills multiplies out the other way round. That is what
 * makes them the right modes for light, and why a radial ramp needs its ring
 * colours corrected when one of them is used.
 */
const ACCUMULATING_MODES: Record<string, boolean> = { screen: true, linearDodge: true };

/** Rec. 601 luma: what a blend mode effectively integrates. */
function luminance(color: { r: number; g: number; b: number }): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/**
 * Ring colours for a radial ramp painted under an accumulating mode.
 *
 * After rings up to and including `k` the result is `1 - Π(1 - c)`; requiring
 * that to equal the ramp at that radius gives `c_k = 1 - (1 - T_k)/(1 - T_{k-1})`.
 * The colours look wrong in isolation and composite to exactly the ramp asked
 * for, which is the point: without this a screen-blended glow saturates to flat
 * white across its whole middle.
 */
export function additiveIncrements(targets: number[]): Array<{ r: number; g: number; b: number }> {
  const out: Array<{ r: number; g: number; b: number }> = [];
  let carried = 1;

  for (let i = 0; i < targets.length; i += 1) {
    const remaining = 1 - targets[i]!;
    const increment = carried > 0 ? 1 - remaining / carried : 1;
    const level = Math.round(Math.min(255, Math.max(0, increment * 255)));
    out.push({ r: level, g: level, b: level });
    carried = remaining > 0 ? remaining : 0;
  }
  return out;
}

export interface LinearBandOptions {
  stops: GradientStopInput[] | undefined;
  width: number;
  height: number;
  bands?: number;
  reverse?: boolean;
  direction?: string;
}

export function linearBands(options: LinearBandOptions): { bands: GradientBand[]; truncated: boolean } {
  const stops = normalizeStops(options.stops);
  const resolved = resolveBands(options.bands);
  const axis = AXES[options.direction ?? 'topToBottom'] ?? AXES.topToBottom!;
  const reverse = options.reverse === true;
  const { width, height } = options;
  const extent = axis.x !== 0 ? width : height;
  const bands: GradientBand[] = [];

  for (let i = 0; i < resolved.bands; i += 1) {
    const from = i / resolved.bands;
    const to = (i + 1) / resolved.bands;
    const lo = Math.floor(from * extent);
    const hi = i === resolved.bands - 1 ? extent : Math.floor(to * extent);
    if (hi <= lo) continue;
    // Mirrors the plugin: `reverse` flips about the midpoint, it does not shift.
    const mid = (from + to) / 2;
    const t = reverse ? 1 - mid : mid;
    bands.push({
      bounds:
        axis.x !== 0
          ? { left: lo, top: 0, right: hi, bottom: height }
          : { left: 0, top: lo, right: width, bottom: hi },
      color: colorAt(stops, t),
      t,
    });
  }

  return { bands, truncated: resolved.truncated };
}

export interface RadialBandOptions {
  stops: GradientStopInput[] | undefined;
  width: number;
  height: number;
  bands?: number;
  reverse?: boolean;
  center?: Point;
  radius?: number;
  /** Composite the bands are painted with; decides whether they accumulate. */
  blendMode?: string;
}

export function radialBands(options: RadialBandOptions): { bands: GradientBand[]; truncated: boolean } {
  const stops = normalizeStops(options.stops);
  const resolved = resolveBands(options.bands);
  const centerX = options.center && isFinite(options.center.x) ? options.center.x : options.width / 2;
  const centerY = options.center && isFinite(options.center.y) ? options.center.y : options.height / 2;
  const halfDiagonal = Math.sqrt(options.width * options.width + options.height * options.height) / 2;
  const radius = options.radius && options.radius > 0 ? options.radius : halfDiagonal;
  const reverse = options.reverse === true;

  // Outermost first, because that is the order the bands are painted in.
  const bands: GradientBand[] = [];
  const targets: number[] = [];
  for (let i = resolved.bands - 1; i >= 0; i -= 1) {
    const from = i / resolved.bands;
    const to = (i + 1) / resolved.bands;
    const r = radius * to;
    // Mirrors the plugin: `reverse` flips about the midpoint, it does not shift.
    const mid = (from + to) / 2;
    const t = reverse ? 1 - mid : mid;
    const rampColor = colorAt(stops, t);
    bands.push({
      bounds: { left: centerX - r, top: centerY - r, right: centerX + r, bottom: centerY + r },
      color: rampColor,
      t,
    });
    targets.push(luminance(rampColor) / 255);
  }

  if (ACCUMULATING_MODES[options.blendMode ?? '']) {
    const increments = additiveIncrements(targets);
    for (let k = 0; k < bands.length; k += 1) bands[k]!.color = increments[k]!;
  }

  return { bands, truncated: resolved.truncated };
}

export interface VerificationOptions {
  type: string;
  direction?: string;
  width: number;
  height: number;
  center?: Point;
  radius?: number;
}

export function gradientVerificationPoints(options: VerificationOptions, limit?: number): Point[] {
  const cap = Math.max(2, Math.min(64, limit ?? 12));
  const points: Point[] = [];

  if (options.type === 'radial') {
    const centerX = options.center && isFinite(options.center.x) ? options.center.x : options.width / 2;
    const centerY = options.center && isFinite(options.center.y) ? options.center.y : options.height / 2;
    const radius =
      options.radius && options.radius > 0
        ? options.radius
        : Math.sqrt(options.width * options.width + options.height * options.height) / 2;
    for (let i = 0; i < cap; i += 1) {
      const t = cap === 1 ? 0 : i / (cap - 1);
      points.push({ x: Math.round(centerX + radius * t * 0.8), y: Math.round(centerY) });
      points.push({ x: Math.round(centerX), y: Math.round(centerY + radius * t * 0.8) });
    }
    return points;
  }

  const axis = AXES[options.direction ?? 'topToBottom'] ?? AXES.topToBottom!;
  const steps = Math.min(cap, 12);
  for (let k = 0; k < steps; k += 1) {
    const f = steps === 1 ? 0.5 : k / (steps - 1);
    points.push(
      axis.x !== 0
        ? { x: Math.round(f * options.width), y: Math.round(options.height / 2) }
        : { x: Math.round(options.width / 2), y: Math.round(f * options.height) },
    );
  }
  return points;
}