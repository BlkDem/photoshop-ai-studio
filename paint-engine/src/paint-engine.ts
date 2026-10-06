/**
 * The paint engine's front door.
 *
 * `PaintEngine` is deliberately ignorant of where a stroke ends up. It turns a
 * validated `PaintingPlan` into batches of pixel-space strokes and hands them to
 * whatever adapter it is given, which means the same engine drives the real UXP
 * bridge, the in-memory mock in tests, and — later — a different medium without
 * changing a line of the painting logic.
 *
 * It is also LLM-agnostic by construction: it never calls a model, and a model
 * never calls it. The Art Director produces the plan; this file consumes it.
 */

import type {
  PaintBatch,
  PaintPhase,
  PaintProgress,
  PaintingPlan,
  PlanStage,
  SemanticStroke,
} from './types.js';
import { StrokeGenerator } from './strokes/generator.js';
import { buildBatches, DEFAULT_FILL_BUDGET, type BatchReport } from './renderer/batches.js';
import { strokeToPixels, type CanvasSize, type PixelStroke } from './renderer/coordinates.js';
import { planLayers, stackOrder, type LayerPlanEntry } from './layers/strategy.js';
import { validatePaintingPlan } from './validation.js';

/**
 * Where batches go.
 *
 * Deliberately the smallest possible interface: an engine that can express "do
 * this batch" needs to know nothing about MCP, WebSockets or Photoshop.
 */
export interface PaintTarget {
  /** Create the layer if it is not there yet, and make it the active one. */
  ensureLayer(layer: string): Promise<void>;
  /** Paint a batch of pixel strokes onto the active layer. */
  paint(strokes: PixelStroke[]): Promise<void>;
}

export interface PaintEngineOptions {
  /** Fills allowed per adapter call. */
  perCallBudget?: number;
  onProgress?: (progress: PaintProgress) => void;
}

/**
 * Phase thresholds, as the fraction of a painting that is complete.
 *
 * These are the spec's progressive stages. They exist so the progress bar reports
 * something meaningful: a painting that is 30% through the mark count is not 30%
 * through the painting, because the sky is mostly done long before the foam.
 */
const PHASES: { at: number; phase: PaintPhase }[] = [
  { at: 0.1, phase: 'composition' },
  { at: 0.25, phase: 'masses' },
  { at: 0.45, phase: 'colors' },
  { at: 0.65, phase: 'forms' },
  { at: 0.8, phase: 'details' },
  { at: 0.95, phase: 'highlights' },
  { at: 1, phase: 'final' },
];

function phaseFor(fraction: number): PaintPhase {
  let current: PaintPhase = 'composition';
  for (const step of PHASES) {
    if (fraction >= step.at) current = step.phase;
  }
  return current;
}

/** What a completed render cost, for the UI and for the Vision Critic. */
export interface PaintReport {
  layers: number;
  strokes: number;
  batches: number;
  fills: number;
  degraded: number;
  truncated: number;
  tipIsSynthesized: true;
}

export class PaintEngine {
  private readonly perCallBudget: number;
  private readonly onProgress: ((progress: PaintProgress) => void) | undefined;

  constructor(options: PaintEngineOptions = {}) {
    this.perCallBudget = options.perCallBudget ?? DEFAULT_FILL_BUDGET;
    this.onProgress = options.onProgress;
  }

  /**
   * Generates every stroke for a stage without painting anything.
   *
   * Exposed because the plan view has to show real stroke counts and cost before
   * the user commits, and building them twice is cheap next to painting them once.
   */
  strokesForStage(plan: PaintingPlan, stage: PlanStage): SemanticStroke[] {
    return new StrokeGenerator({ plan, stage }).generateStage();
  }

  /**
   * Works out the cost of a whole plan without painting it.
   *
   * Feeds the plan preview's "estimated strokes / fills / seconds" line. The
   * seconds figure is a rough per-fill cost; it is labelled an estimate in the UI
   * for exactly that reason.
   */
  estimate(plan: PaintingPlan): BatchReport & { layers: number } {
    const byLayer = new Map<string, SemanticStroke[]>();
    for (const stage of plan.stages) {
      const strokes = this.strokesForStage(plan, stage);
      const list = byLayer.get(stage.layer) ?? [];
      list.push(...strokes);
      byLayer.set(stage.layer, list);
    }
    const report = buildBatches(byLayer, {
      width: plan.canvas.width,
      height: plan.canvas.height,
      perCallBudget: this.perCallBudget,
    });
    return { ...report, layers: planLayers(plan).entries.length };
  }

  /** The layer stack as Photoshop should show it, topmost first. */
  layerStack(plan: PaintingPlan): LayerPlanEntry[] {
    return stackOrder(plan);
  }

  /**
   * Paints a whole plan, stage by stage, reporting progress as it goes.
   *
   * `stop` is checked between batches rather than between strokes: a batch is
   * already committed to Photoshop by the time it is sent, so checking earlier
   * than this would only ever stop the picture on a batch boundary anyway. The
   * consequence is stated plainly — a stopped painting is a partially painted
   * document, not a rolled-back one, which is why the plan is meant to be run on
   * a checkpointed duplicate.
   */
  async paintPlan(plan: PaintingPlan, target: PaintTarget, stop?: { aborted: boolean }): Promise<PaintReport> {
    const validated = validatePaintingPlan(plan);
    const canvas: CanvasSize = validated.canvas;

    const totals = validated.stages.map((stage) => StrokeGenerator.estimate(stage));
    const grandTotal = totals.reduce((sum, n) => sum + n, 0) || 1;

    let strokesDone = 0;
    let fills = 0;
    let batches = 0;
    let degraded = 0;
    let truncated = 0;
    const layersSeen = new Set<string>();

    for (const [index, stage] of validated.stages.entries()) {
      if (stop?.aborted) break;

      const strokes = this.strokesForStage(validated, stage);
      const pixelStrokes = strokes
        .map((stroke) => strokeToPixels(stroke, canvas))
        .filter((stroke): stroke is PixelStroke => stroke !== null);

      const report = buildBatches(
        new Map([[stage.layer, strokes]]),
        { width: canvas.width, height: canvas.height, perCallBudget: this.perCallBudget },
      );
      degraded += report.degraded;
      truncated += report.truncated;

      const stageTotal = totals[index] ?? pixelStrokes.length;

      for (const batch of report.batches) {
        if (stop?.aborted) break;

        await target.ensureLayer(batch.layer);
        const toPaint = pixelsFor(batch, canvas);
        if (toPaint.length === 0) continue;

        await target.paint(toPaint);

        batches += 1;
        fills += estimateBatchFills(batch, canvas);
        strokesDone += toPaint.length;
        layersSeen.add(batch.layer);

        this.onProgress?.({
          stageId: stage.id,
          layer: stage.layer,
          purpose: stage.purpose,
          overall: Math.min(1, strokesDone / grandTotal),
          stage: Math.min(1, strokesDone / grandTotal),
          strokesDone,
          strokesTotal: grandTotal,
          brush: stage.brush,
          phase: phaseFor(strokesDone / grandTotal),
        });
      }

      void stageTotal;
    }

    return {
      layers: layersSeen.size,
      strokes: strokesDone,
      batches,
      fills,
      degraded,
      truncated,
      tipIsSynthesized: true,
    };
  }
}

/** Converts a batch to pixel strokes, dropping anything that fell off the canvas. */
function pixelsFor(batch: PaintBatch, canvas: CanvasSize): PixelStroke[] {
  const out: PixelStroke[] = [];
  for (const stroke of batch.strokes) {
    const pixels = strokeToPixels(stroke, canvas);
    if (pixels) out.push(pixels);
  }
  return out;
}

function estimateBatchFills(batch: PaintBatch, canvas: CanvasSize): number {
  return buildBatches(new Map([[batch.layer, batch.strokes]]), {
    width: canvas.width,
    height: canvas.height,
    perCallBudget: Number.MAX_SAFE_INTEGER,
  }).fills;
}