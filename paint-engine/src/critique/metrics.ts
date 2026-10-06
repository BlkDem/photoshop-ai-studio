/**
 * What can be measured about a rendered painting.
 *
 * Every number here is computed from pixels, not from the plan. That distinction is
 * the whole point: a critic that reads the plan can only say what was *asked* for,
 * and a plan that asks for a dramatic sky will pass a dramatic-sky check while
 * producing a grey fog. Reading the output is the only way to catch the case where
 * the intent was fine and the execution lost it.
 *
 * Percentiles rather than min and max, everywhere. A single stray pixel — one
 * saturated dab, one anti-aliased edge — sets a min/max pair, and a critic built
 * on extremes reports a healthy value range for a picture with none.
 */

import type { RgbImage } from './png.js';

export interface BandValues {
  /** Mean luminance 0..1. */
  mean: number;
  /** P2..P98 luminance spread within the band, 0..1. */
  spread: number;
  pixels: number;
}

export interface ImageMetrics {
  width: number;
  height: number;
  /** Robust luminance range across the whole image, 0..1. */
  valueRange: [number, number];
  /** RMS contrast: standard deviation of luminance over its mean. */
  contrast: number;
  /** Mean HSV-style saturation, 0..1. */
  saturation: number;
  /**
   * Fraction of pixels that differ from the image's own median colour by more than
   * a just-noticeable amount. A low value means the picture is mostly ground.
   */
  coverage: number;
  /**
   * Mean luminance above the horizon minus mean luminance below it, 0..1.
   *
   * Reported even when the plan has no horizon, in which case both sides are sampled
   * at the geometric middle, which is still the most useful single number for
   * "is the top of this picture different from the bottom".
   */
  horizonDelta: number;
  /** Luminance means of the bands above, at, and below the horizon line. */
  bands: { above: BandValues; across: BandValues; below: BandValues };
  /**
   * Local contrast inside a box around the focal point, minus local contrast
   * elsewhere. Positive means the eye is led where the composition put it.
   */
  focalEmphasis: number;
  /** Share of pixels that are effectively the lightest or darkest in the image. */
  extremeShare: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rec. 709 luminance, the weighting the eye actually reports. */
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Saturation as distance from grey, which is what reads as "coloured" to the eye. */
function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[at]!;
}

interface Accumulator {
  sum: number;
  /**
   * Sum of squares, kept for the focal comparison and skipped by the band
   * accumulators, which only need a spread. Not every accumulator needs every
   * field it can grow.
   */
  sumSquares: number;
  count: number;
  values: number[];
}

const empty = (): Accumulator => ({ sum: 0, sumSquares: 0, count: 0, values: [] });

function finish(acc: Accumulator): BandValues {
  const mean = acc.count === 0 ? 0 : acc.sum / acc.count;
  const sorted = Float64Array.from(acc.values).sort();
  return { mean, spread: percentile(sorted, 0.98) - percentile(sorted, 0.02), pixels: acc.count };
}

export interface MeasureOptions {
  /** Normalized horizon. Falls back to the geometric middle. */
  horizon?: number | null;
  /** Normalized focal point. */
  focalPoint?: { x: number; y: number };
  /** Half-width of the focal box, as a fraction of the image. */
  focalBox?: number;
}

/** Measures a rendered image. */
export function measure(image: RgbImage, options: MeasureOptions = {}): ImageMetrics {
  const { width, height, rgb } = image;
  const total = width * height;

  const all = empty();
  const above = empty();
  const across = empty();
  const below = empty();
  const focal = empty();
  const rest = empty();

  const horizon = options.horizon ?? null;
  const horizonRow = Math.max(0, Math.min(height - 1, Math.round((horizon ?? 0.5) * height)));
  // A band around the horizon, wide enough to be a strip rather than a line: a
  // single row of pixels measures the horizon's sharpness, not its presence.
  const acrossRows = Math.max(2, Math.round(height * 0.04));

  const fx = options.focalPoint ? Math.round(options.focalPoint.x * width) : Math.round(width / 2);
  const fy = options.focalPoint ? Math.round(options.focalPoint.y * height) : Math.round(height / 2);
  const box = Math.round((options.focalBox ?? 0.15) * Math.min(width, height));
  const boxX0 = Math.max(0, fx - box);
  const boxX1 = Math.min(width - 1, fx + box);
  const boxY0 = Math.max(0, fy - box);
  const boxY1 = Math.min(height - 1, fy + box);

  const luminances = new Float64Array(total);
  const saturations = new Float64Array(total);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const j = i * 3;
      const r = rgb[j]!;
      const g = rgb[j + 1]!;
      const b = rgb[j + 2]!;
      const lum = luminance(r, g, b);
      luminances[i] = lum;
      saturations[i] = saturation(r, g, b);

      all.sum += lum;
      all.sumSquares += lum * lum;
      all.count += 1;
      all.values.push(lum);
      const target = y < horizonRow - acrossRows ? above : y > horizonRow + acrossRows ? below : across;
      target.sum += lum;
      target.count += 1;
      target.values.push(lum);

      const inBox = x >= boxX0 && x <= boxX1 && y >= boxY0 && y <= boxY1;
      (inBox ? focal : rest).sum += lum;
      (inBox ? focal : rest).sumSquares += lum * lum;
      (inBox ? focal : rest).count += 1;
    }
  }

  const bandAll = finish(all);
  const meanLum = bandAll.mean;
  const contrast = meanLum === 0 ? 0 : Math.sqrt(Math.max(0, bandAll.spread / bandAll.mean));

  let saturationSum = 0;
  for (let i = 0; i < total; i += 1) saturationSum += saturations[i]!;

  // Coverage against the median colour: a picture on a white ground with thin
  // marks covers little of it, and "little of the canvas has paint on it" is a
  // real and common failure that a value-range check sails straight past.
  const sorted = Float64Array.from(all.values).sort();
  const median = percentile(sorted, 0.5);
  let painted = 0;
  for (let i = 0; i < total; i += 1) {
    if (Math.abs(luminances[i]! - median) > 0.06) painted += 1;
  }

  const aboveBand = finish(above);
  const belowBand = finish(below);

  // Focal emphasis: the local variation around the focal point against the picture
  // as a whole. A flat fog has the same local contrast everywhere, so this is what
  // separates "busy in the middle" from "focused".
  const focalMean = focal.count === 0 ? meanLum : focal.sum / focal.count;
  const restMean = rest.count === 0 ? meanLum : rest.sum / rest.count;
  const focalVar = focal.count === 0 ? 0 : Math.max(0, focal.sumSquares / focal.count - focalMean * focalMean);
  const restVar = rest.count === 0 ? 0 : Math.max(0, rest.sumSquares / rest.count - restMean * restMean);

  let extremes = 0;
  const [low, high] = bandAll.spread > 0
    ? [percentile(sorted, 0.02), percentile(sorted, 0.98)]
    : [median, median];
  for (let i = 0; i < total; i += 1) {
    const v = luminances[i]!;
    if (v <= low + 0.04 || v >= high - 0.04) extremes += 1;
  }

  return {
    width,
    height,
    valueRange: [low, high],
    contrast: clamp01(contrast),
    saturation: clamp01(saturationSum / Math.max(1, total)),
    coverage: painted / Math.max(1, total),
    horizonDelta: clamp01(Math.abs(aboveBand.mean - belowBand.mean)),
    bands: { above: aboveBand, across: finish(across), below: belowBand },
    focalEmphasis: clamp01(Math.sqrt(focalVar) - Math.sqrt(restVar) + 0.5),
    extremeShare: extremes / Math.max(1, total),
  };
}