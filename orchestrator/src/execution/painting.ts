/**
 * Turning a painting request into ordinary plan steps.
 *
 * A `PlanStep` is one MCP tool call, and that invariant is worth more than the
 * convenience of a single "paint this" step: the executor, the safety gate, the
 * approval UI and the verification pass all work off it, and a painting that ran
 * outside that machinery would be invisible to every one of them. So the request is
 * expanded here, at plan-build time, into one `paint_strokes` step per layer plus
 * the checkpoint around them. The plan that gets approved is a plan a person can
 * read, step by step, before anything touches the document.
 *
 * The checkpoint is not optional. `suspendHistory` cannot span more than one bridge
 * request (ADR-014), so there is no way to bracket thousands of fills in an undo
 * group — a painting that fails halfway leaves the document with marks on it and no
 * way back. Every painting therefore runs against a duplicated document, and the
 * duplicate is left in place rather than flattened, so the user can see what happened
 * and choose to keep it or throw it away.
 */

import type { Plan, PlanStep } from '@photoshop-ai-studio/shared';
import {
  PaintEngine,
  direct,
  strokeToPixels,
  type ArtDirectorOptions,
  type DirectedPlan,
  type PaintingPlan,
  type PixelStroke,
} from '@photoshop-ai-studio/paint-engine';

export interface BuildPaintPlanOptions {
  request: string;
  /** Size of the document to paint into. */
  width: number;
  height: number;
  resolution?: number;
  seed?: number;
  director?: ArtDirectorOptions;
  /**
   * Skip the checkpoint duplicate.
   *
   * A parameter rather than a default, so that skipping it is a thing somebody has
   * to write down. Only for a caller that has already isolated the document, or that
   * is painting into a throwaway one.
   */
  alreadyIsolated?: boolean;
  /** Prefix for generated ids, so two paintings in one plan do not collide. */
  idPrefix?: string;
  /** How the plan was reached, recorded on the plan itself. */
  route?: Plan['route'];
}

export interface BuiltPaintPlan {
  plan: Plan;
  directed: DirectedPlan;
  /** Layers that ended up with no strokes and so produced no step. */
  skippedLayers: string[];
}

/**
 * Compiles one layer's stages into pixel strokes, without touching a document.
 *
 * This is the seam that keeps the orchestrator out of the paint engine's business:
 * the engine already knows how to turn a stage into strokes and where they clamp to
 * the canvas, and reimplementing either here would be a second implementation to
 * keep in step with the first — including its opinion about strokes that collapse to
 * a single point and must be dropped.
 */
function strokesForLayer(plan: PaintingPlan, layer: string): PixelStroke[] {
  const engine = new PaintEngine();
  const strokes: PixelStroke[] = [];
  for (const stage of plan.stages) {
    if (stage.layer !== layer) continue;
    for (const semantic of engine.strokesForStage(plan, stage)) {
      const pixel = strokeToPixels(semantic, plan.canvas);
      if (pixel) strokes.push(pixel);
    }
  }
  return strokes;
}

/** One `paint_strokes` payload, shared by every layer step. */
function strokeParams(strokes: PixelStroke[]): PlanStep['params'] {
  return {
    strokes: strokes.map((s) => ({
      points: s.points,
      brushSize: s.size,
      color: s.color,
      opacity: Math.round(s.opacity * 100),
      spacing: s.spacing,
      // Forwarded, not defaulted: dropping the tip would silently turn every soft
      // brush into a flat disc, and the plan would promise Photoshop something the
      // engine never asked for.
      tip: { core: s.tip.core, steps: s.tip.steps, outerAlpha: s.tip.outerAlpha },
      ...(s.blendMode ? { blendMode: s.blendMode } : {}),
    })),
  };
}

/** Expands a painting request into a plan. */
export function buildPaintPlan(options: BuildPaintPlanOptions): BuiltPaintPlan {
  const prefix = options.idPrefix ?? 'paint';
  const seed = options.seed ?? 1;

  const directed = direct(options.request, {
    seed,
    canvas: { width: options.width, height: options.height },
    ...options.director,
  });

  const steps: PlanStep[] = [];

  if (!options.alreadyIsolated) {
    steps.push({
      id: `${prefix}-checkpoint`,
      tool: 'photoshop.duplicate_document',
      params: { name: `${directed.plan.title} (working)` },
      intent: 'Duplicate the document so the painting can be discarded whole; undo cannot span the fills.',
      expect: [],
      destructive: false,
    });
  }

  const skippedLayers: string[] = [];
  let first = true;

  for (const [index, layer] of directed.plan.layers.entries()) {
    const strokes = strokesForLayer(directed.plan, layer);
    if (strokes.length === 0) {
      // A layer the plan declared but nothing landed on is not an error, and making
      // a step for it would send an empty batch over the wire. Record it instead:
      // a layer that silently goes missing is how a plan quietly stops matching the
      // document it claims to describe.
      skippedLayers.push(layer);
      continue;
    }

    steps.push({
      id: `${prefix}-layer-${index + 1}`,
      tool: 'photoshop.paint_strokes',
      params: {
        documentId: 'active',
        // Only the first layer creates; the rest stack on it. The engine's plan
        // already ordered the layers bottom-first, so "first" here means bottom.
        newLayer: first,
        layerName: layer,
        ...strokeParams(strokes),
      },
      intent: `Paint "${layer}" with ${strokes.length} strokes`,
      expect: [],
      destructive: false,
    });
    first = false;
  }

  const plan: Plan = {
    id: `${prefix}-${seed}`,
    goal: options.request,
    steps,
    createdAt: new Date().toISOString(),
    model: { role: 'rule', provider: 'none', model: 'art-director' },
    route: options.route ?? 'rule',
    requiresConfirmation: false,
    confirmations: [],
    notes: [...directed.assumptions, ...(skippedLayers.length > 0 ? [`No strokes landed on: ${skippedLayers.join(', ')}.`] : [])],
  };

  return { plan, directed, skippedLayers };
}

/** The layers a painting will touch, bottom-first. */
export function paintLayers(options: BuildPaintPlanOptions): string[] {
  return direct(options.request, { seed: options.seed ?? 1, canvas: { width: options.width, height: options.height }, ...options.director })
    .plan.layers;
}

