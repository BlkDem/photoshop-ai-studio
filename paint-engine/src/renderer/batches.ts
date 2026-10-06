/**
 * Batching, and the cost model behind it.
 *
 * ## The constraint
 *
 * Every stamp is one `selectEllipse` plus one `batchPlay` fill, and `batchPlay`
 * round-trips through Photoshop's action manager. So *fills are wall-clock time*,
 * not strokes. A stroke is only cheap or expensive in proportion to its length and
 * its brush diameter.
 *
 * With a synthesized tip the cost multiplies again: a 4-ring brush is four fills
 * per stamp. Ignoring that is how a plan that estimates 1,200 strokes quietly
 * becomes forty minutes of Photoshop holding a modal scope.
 *
 * ## What this file does about it
 *
 * `budgetStamps` reduces the *number of stamps* to fit a fill budget, by
 * widening spacing rather than by cutting marks. Spacing is the right dial: a
 * coarser stamp along the same path still covers the path, whereas dropping marks
 * leaves gaps. The result is reported as `degraded` so the caller can say so
 * instead of quietly shipping a thinner painting.
 */

import type { PaintBatch, SemanticStroke } from '../types.js';

/**
 * Total fills one MCP call may request.
 *
 * Sized against the bridge's 30s default timeout (600s in local `.env`): at a few
 * milliseconds per fill this is comfortably inside the default, so a stage
 * completes even on a machine nobody tuned the timeout for.
 */
export const DEFAULT_FILL_BUDGET = 900;

/** Fills allowed for one stroke, however large it is. */
const MAX_FILLS_PER_STROKE = 260;

/** Photoshop's own per-stroke ceiling (`brush.js: MAX_STAMPS`). */
export const MAX_STAMPS_PER_STROKE = 4000;

/**
 * Fills one stamp costs: one per ring of the tip.
 */
export function fillsPerStamp(stroke: SemanticStroke): number {
  return Math.max(1, stroke.tip.steps);
}

/**
 * How many stamps a stroke needs at its current spacing.
 *
 * Computed the same way the plugin computes it, so the budget is measured in the
 * units the plugin will actually spend. Path length is measured in pixels because
 * spacing is a pixel distance.
 */
export function stampsNeeded(stroke: SemanticStroke, width: number, height: number): number {
  const points = stroke.points;
  if (points.length === 0) return 0;

  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    length += Math.hypot((b.x - a.x) * width, (b.y - a.y) * height);
  }

  const radius = Math.max(0.5, (stroke.size * Math.min(width, height)) / 2);
  const step = Math.max(0.35, radius * Math.max(0.05, Math.min(1, stroke.spacing)));
  return Math.max(1, Math.ceil(length / step) + 1);
}

/**
 * Fits a stroke into a fill budget by opening up its spacing.
 *
 * `degraded` is set when the spacing had to grow, and `truncated` when even the
 * widest allowed spacing cannot fit — that stroke is shortened rather than sent
 * whole, because a single stroke that exceeds the budget would stall the bridge
 * for the full timeout.
 */
export function budgetStroke(
  stroke: SemanticStroke,
  width: number,
  height: number,
  budget: number,
): { stroke: SemanticStroke; degraded: boolean; truncated: boolean } {
  const rings = fillsPerStamp(stroke);
  const affordable = Math.max(1, Math.floor(budget / rings));
  const needed = stampsNeeded(stroke, width, height);

  if (needed <= affordable) {
    return { stroke, degraded: false, truncated: false };
  }

  // Open the spacing up to whatever puts the stamp count at the affordable
  // number. A spacing of 1 (stamps one radius apart) still leaves a continuous
  // mark, because consecutive discs of radius r overlap out to 2r.
  const requiredSpacing = Math.min(1, (needed / affordable) * stroke.spacing);
  const widened: SemanticStroke = { ...stroke, spacing: Math.max(stroke.spacing, requiredSpacing) };

  const stillNeeded = stampsNeeded(widened, width, height);
  if (stillNeeded <= MAX_STAMPS_PER_STROKE && stillNeeded <= affordable * 1.05) {
    return { stroke: widened, degraded: true, truncated: false };
  }

  return { stroke: widened, degraded: true, truncated: true };
}

export interface BatchOptions {
  width: number;
  height: number;
  /** Total fills allowed across the whole plan. */
  fillBudget?: number;
  /** Fills allowed per MCP call. */
  perCallBudget?: number;
}

/** What the engine did to a plan while batching it, for honest reporting. */
export interface BatchReport {
  batches: PaintBatch[];
  strokes: number;
  fills: number;
  /** Strokes whose spacing had to be opened up to fit. */
  degraded: number;
  /** Strokes shortened to fit. */
  truncated: number;
}

/**
 * Groups a plan's strokes into Photoshop calls.
 *
 * One batch per layer, then split so no single call exceeds the per-call budget.
 * The first batch for a layer is flagged `createLayer`, which is the only signal
 * the adapter has that it needs to make the layer before painting into it.
 */
export function buildBatches(
  byLayer: Map<string, SemanticStroke[]>,
  options: BatchOptions,
): BatchReport {
  const perCall = options.perCallBudget ?? DEFAULT_FILL_BUDGET;
  const report: BatchReport = { batches: [], strokes: 0, fills: 0, degraded: 0, truncated: 0 };

  for (const [layer, strokes] of byLayer) {
    let current: SemanticStroke[] = [];
    let currentFills = 0;
    let seen = false;

    const flush = (): void => {
      if (current.length === 0) return;
      report.batches.push({ layer, strokes: current, createLayer: !seen });
      seen = true;
      report.strokes += current.length;
      report.fills += currentFills;
      current = [];
      currentFills = 0;
    };

    for (const stroke of strokes) {
      const budgeted = budgetStroke(stroke, options.width, options.height, MAX_FILLS_PER_STROKE);
      if (budgeted.degraded) report.degraded += 1;
      if (budgeted.truncated) report.truncated += 1;

      const cost = stampsNeeded(budgeted.stroke, options.width, options.height) * fillsPerStamp(budgeted.stroke);
      if (current.length > 0 && currentFills + cost > perCall) {
        flush();
      }
      current.push(budgeted.stroke);
      currentFills += cost;
    }
    flush();
  }

  return report;
}