/**
 * The Vision Critic, minus the vision.
 *
 * It reads a rendered image and a plan and reports where the picture failed, using
 * only measurements. That is a narrower claim than "judges the art", and it is the
 * one that holds: a critic that cannot be wrong about a number cannot be trusted
 * when it makes a qualitative claim either, and the three failures that cost the
 * most while building the Art Director were all measurable — an invisible horizon,
 * a value range with no room in it, a picture that was mostly ground.
 *
 * No model is involved, for the same reason the Art Director has none: the engine
 * must not depend on an LLM. A model-backed critic that writes these findings as
 * prose, or adds judgement the measurements cannot support, slots in behind
 * `critique()` without changing anything above it.
 *
 * **What this does not measure.** Structure only. `structureScore` reaching 94 on a
 * seascape whose waves are still full-width ropes and whose ship is still a
 * scribble is the honest limit of this critic, and it is worth stating plainly: a
 * picture can have a full value range, real contrast and a visible horizon and still
 * be a bad painting, because nothing here looks at whether the marks are *of*
 * anything. Form is a judgement call and belongs to whoever looks at the picture —
 * or to a model-backed critic, once one exists. What these numbers do is stop the
 * failures that are invisible to the eye from hiding behind a picture that looks
 * merely soft.
 *
 * Every threshold is a default, not a law. They are collected in `THRESHOLDS` so a
 * caller can argue with them in one place, and every finding reports the number it
 * fired on so nobody has to take the threshold on faith.
 */

import type { PaintingPlan } from '../types.js';
import { measure, type ImageMetrics, type MeasureOptions } from './metrics.js';
import { decodePng, type RgbImage } from './png.js';

export type Severity = 'note' | 'warning' | 'fault';

export interface Finding {
  /** Stable identifier, so a finding can be tracked across renders. */
  id: string;
  severity: Severity;
  /** One line, stated as an observation rather than an opinion. */
  summary: string;
  /** The measurement that produced it. */
  measured: string;
  /** What to try. */
  suggestion: string;
}

export interface Critique {
  metrics: ImageMetrics;
  findings: Finding[];
  /**
   * 100 minus the cost of the findings. Named for what it is: structure, not
   * quality. Use it to sort renders or to fail a build, never to claim a picture is
   * good.
   */
  structureScore: number;
}

export interface Thresholds {
  /** Minimum robust value spread for a picture to have any depth. */
  minValueRange: number;
  /** Minimum RMS contrast. */
  minContrast: number;
  /** Minimum share of the canvas that differs from the ground. */
  minCoverage: number;
  /** Minimum mean luminance difference across the horizon. */
  minHorizonDelta: number;
  /** Minimum saturation for a picture to be a colour picture. */
  minSaturation: number;
  /** Below this the composition does not lead the eye. */
  minFocalEmphasis: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minValueRange: 0.3,
  minContrast: 0.35,
  minCoverage: 0.35,
  minHorizonDelta: 0.06,
  minSaturation: 0.04,
  minFocalEmphasis: 0.5,
};

const SEVERITY_COST: Record<Severity, number> = { fault: 12, warning: 5, note: 1 };

export interface CritiqueOptions extends MeasureOptions {
  thresholds?: Partial<Thresholds>;
  /** Name for the render being judged, for the report. */
  label?: string;
}

/**
 * Critiques a rendered image against what the plan asked for.
 *
 * Returns the metrics even when it returns no findings: a caller tuning recipes
 * needs the numbers, and a critic that only speaks up when it is unhappy is useless
 * for showing that a change helped.
 */
export function critique(plan: PaintingPlan, image: RgbImage, options: CritiqueOptions = {}): Critique {
  const t = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const horizon = options.horizon ?? plan.composition.horizon;
  const metrics = measure(image, {
    horizon,
    focalPoint: options.focalPoint ?? plan.composition.focalPoint,
    ...(options.focalBox !== undefined ? { focalBox: options.focalBox } : {}),
  });

  const findings: Finding[] = [];
  const [low, high] = metrics.valueRange;
  const range = high - low;

  if (range < t.minValueRange) {
    findings.push({
      id: 'value-range',
      severity: 'fault',
      summary: 'The picture has almost no value range: it cannot read as lit or unlit.',
      measured: `P2..P98 luminance spans ${range.toFixed(3)} (${low.toFixed(2)}..${high.toFixed(2)}), below ${t.minValueRange}.`,
      suggestion:
        'Lay in the darkest dark and the lightest light explicitly. Nothing here asks for a value, so the palette engine returns a neutral ramp and every mark lands mid-grey.',
    });
  }

  if (metrics.contrast < t.minContrast) {
    findings.push({
      id: 'contrast',
      severity: range < t.minValueRange ? 'warning' : 'fault',
      summary: 'Values cluster in the middle of the scale.',
      measured: `RMS contrast ${metrics.contrast.toFixed(3)}, below ${t.minContrast}.`,
      suggestion: 'Push the extremes apart rather than raising everything: a glaze over everything flattens what is already flat.',
    });
  }

  if (metrics.coverage < t.minCoverage) {
    findings.push({
      id: 'coverage',
      severity: 'warning',
      summary: 'Most of the canvas is untouched ground.',
      measured: `${(metrics.coverage * 100).toFixed(1)}% of pixels differ from the median, below ${(t.minCoverage * 100).toFixed(0)}%.`,
      suggestion:
        'Widen the regions the marks live in. A recipe that draws into a small box leaves the picture mostly empty however many times it repeats.',
    });
  }

  if (horizon !== null && metrics.horizonDelta < t.minHorizonDelta) {
    findings.push({
      id: 'horizon',
      severity: 'fault',
      summary: 'The horizon is invisible: the two halves are the same value.',
      measured: `Mean luminance differs by ${metrics.horizonDelta.toFixed(4)} across the horizon, below ${t.minHorizonDelta}.`,
      suggestion:
        'Build the two halves from different roles. Painting sky and sea from the same palette slot gives one flat field with a line drawn through it.',
    });
  }

  if (metrics.saturation < t.minSaturation) {
    findings.push({
      id: 'saturation',
      severity: 'note',
      summary: 'The picture is effectively grey.',
      measured: `Mean saturation ${metrics.saturation.toFixed(4)}, below ${t.minSaturation}.`,
      suggestion: 'Seed the palette from the scene. An unseeded request produces a neutral ramp by default.',
    });
  }

  if (metrics.focalEmphasis < t.minFocalEmphasis) {
    findings.push({
      id: 'focal-emphasis',
      severity: 'note',
      summary: 'The focal point is not distinguished from the rest of the picture.',
      measured: `Local contrast at the focal point minus local contrast elsewhere: ${metrics.focalEmphasis.toFixed(3)}, below ${t.minFocalEmphasis}.`,
      suggestion: 'Give the subject a hard edge and a value the surroundings do not use.',
    });
  }

  const structureScore = Math.max(
    0,
    100 - findings.reduce((sum, f) => sum + SEVERITY_COST[f.severity], 0),
  );

  return { metrics, findings, structureScore };
}

/**
 * Critiques raw PNG bytes.
 *
 * Returns null when the image cannot be read, and says why in `unreadable`. The
 * alternative — measuring whatever the decoder guessed — is how a critic ends up
 * reporting confident numbers about a picture nobody looked at.
 */
export function critiquePng(
  plan: PaintingPlan,
  png: Uint8Array,
  options: CritiqueOptions = {},
): { critique: Critique } | { critique: null; unreadable: string } {
  const image = decodePng(png);
  if (!image) {
    return {
      critique: null,
      unreadable: 'PNG is 8-bit non-interlaced RGB or RGBA; this one is not.',
    };
  }
  return { critique: critique(plan, image, options) };
}

/** One-screen report. */
export function formatCritique(result: Critique, label = 'render'): string {
  const lines: string[] = [];
  const m = result.metrics;
  lines.push(`${label}  structure ${result.structureScore}/100  (not a quality score)`);
  lines.push(
    `  value ${m.valueRange[0].toFixed(2)}..${m.valueRange[1].toFixed(2)}  contrast ${m.contrast.toFixed(2)}  ` +
      `sat ${m.saturation.toFixed(3)}  cover ${(m.coverage * 100).toFixed(0)}%  ` +
      `horizon ${m.horizonDelta.toFixed(3)}  focal ${m.focalEmphasis.toFixed(2)}`,
  );
  if (result.findings.length === 0) {
    lines.push('  no findings');
    return lines.join('\n');
  }
  for (const f of result.findings) {
    lines.push(`  [${f.severity}] ${f.id}: ${f.summary}`);
    lines.push(`      ${f.measured}`);
    lines.push(`      try: ${f.suggestion}`);
  }
  return lines.join('\n');
}