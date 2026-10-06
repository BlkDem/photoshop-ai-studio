/**
 * Normalized coordinates to canvas pixels.
 *
 * The whole engine works in 0..1 so a plan composed against 1920x1080 renders the
 * same picture at 3840x2160. The adapter is the only place that knows about
 * pixels, which is why a plan never has to be regenerated when the document
 * changes size.
 *
 * ## The one subtlety: brush diameter
 *
 * Brush sizes are a fraction of the canvas's **shorter** side, not of the width.
 * A brush sized against the width would be twice as fat on a portrait canvas as
 * on a landscape one for the same document width, which makes a plan look
 * correct in every preview and wrong on export. Sizing against the short edge
 * keeps a brush round.
 */

import type { NormalizedPoint, NormalizedRect, SemanticStroke, TipModel } from '../types.js';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface PixelStroke {
  points: { x: number; y: number }[];
  /** Diameter in pixels. */
  size: number;
  color: string;
  opacity: number;
  flow: number;
  spacing: number;
  /**
   * The synthesized tip, carried all the way to the adapter.
   *
   * This is the only reason a soft edge can exist on this host, so dropping it
   * here would silently flatten every soft brush into a hard disc on the way to
   * Photoshop — with nothing downstream to notice.
   */
  tip: TipModel;
  blendMode?: string;
  purpose: string;
  depth: SemanticStroke['depth'];
}

/** Converts a normalized point to pixels. */
export function toPixels(point: NormalizedPoint, canvas: CanvasSize): { x: number; y: number } {
  return {
    x: Math.round(point.x * canvas.width),
    y: Math.round(point.y * canvas.height),
  };
}

/** Converts a normalized region to a pixel box. */
export function regionToPixels(region: NormalizedRect, canvas: CanvasSize) {
  return {
    left: Math.round(region.x * canvas.width),
    top: Math.round(region.y * canvas.height),
    right: Math.round((region.x + region.width) * canvas.width),
    bottom: Math.round((region.y + region.height) * canvas.height),
  };
}

/** The canvas's shorter side — the unit every brush diameter is measured in. */
export function shortEdge(canvas: CanvasSize): number {
  return Math.min(canvas.width, canvas.height);
}

/** Converts a normalized brush diameter to pixels. */
export function brushToPixels(normalizedSize: number, canvas: CanvasSize): number {
  return Math.max(1, Math.round(normalizedSize * shortEdge(canvas)));
}

/**
 * Clamps a path to the canvas.
 *
 * Photoshop rejects a point outside the document with a confusing error, and a
 * mark that overshoots an edge is normal rather than exceptional — a wave that
 * runs off the bottom of the picture is doing its job. Clamping keeps the visible
 * part and drops the rest.
 */
function clampPath(
  points: NormalizedPoint[],
  canvas: CanvasSize,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const point of points) {
    const x = Math.max(0, Math.min(canvas.width, Math.round(point.x * canvas.width)));
    const y = Math.max(0, Math.min(canvas.height, Math.round(point.y * canvas.height)));
    out.push({ x, y });
  }
  return out;
}

/**
 * Converts one semantic stroke to pixels.
 *
 * Returns null when nothing visible survives clamping — a mark that was entirely
 * off-canvas is dropped rather than sent as a zero-length path.
 */
export function strokeToPixels(stroke: SemanticStroke, canvas: CanvasSize): PixelStroke | null {
  const points = clampPath(stroke.points, canvas);
  if (points.length === 0) return null;

  // A path that was entirely off-canvas clamps down to a single corner and must
  // be dropped, or it paints a stray dab in the corner. A stroke that was
  // *authored* as one point is not that case: `eachStamp` in the plugin treats a
  // single-point subpath as a deliberate dot, which is how dabs are made.
  const authoredCount = stroke.points.length;
  const collapsed =
    authoredCount > 1 && points.every((p) => p.x === points[0]?.x && p.y === points[0]?.y);
  if (collapsed) return null;

  const size = brushToPixels(stroke.size, canvas);
  return {
    points,
    size,
    color: stroke.color,
    opacity: stroke.opacity,
    flow: stroke.flow,
    spacing: stroke.spacing,
    tip: stroke.tip,
    ...(stroke.blendMode ? { blendMode: stroke.blendMode } : {}),
    purpose: stroke.purpose,
    depth: stroke.depth,
  };
}