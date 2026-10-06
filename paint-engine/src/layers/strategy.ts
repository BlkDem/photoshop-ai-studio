/**
 * Turning stages into a layer stack.
 *
 * The spec's requirement is that the finished painting stays editable, which
 * means the layer list is a product decision, not a byproduct: someone opening
 * this PSD has to find the sky, the sea and the foam where they expect them.
 *
 * Two things are decided here and nowhere else:
 *
 *  - **Paint order versus stack order.** Stages are painted in the order a
 *    painting is built (background first), but Photoshop stacks the first-created
 *    layer at the *bottom*. So paint order is plan order, and stack order is
 *    plan order reversed. Getting this backwards is what produces a painting
 *    with the sky painted over the waves.
 *  - **One layer per stage, or several?** The spec asks for a layer per major
 *    stage. That is the default; a plan may deliberately group several stages
 *    onto one layer by repeating a layer name, and this file honours that rather
 *    than silently splitting it.
 */

import type { PaintingPlan } from '../types.js';

/** One entry in the layer stack, in Photoshop's bottom-to-top order. */
export interface LayerPlanEntry {
  name: string;
  /** Stage ids painted onto this layer, in paint order. */
  stages: string[];
  /** Depth of the first stage on the layer, used for reporting. */
  depth: string;
}

/**
 * Builds the layer stack, bottom first.
 *
 * Also reports names that were used by a stage but never declared in
 * `plan.layers`, because a stage whose layer is not in the list is a plan bug
 * that `validatePaintingPlan` catches — this second check exists so the engine
 * stays safe when it is handed a plan that skipped validation.
 */
export function planLayers(plan: PaintingPlan): { entries: LayerPlanEntry[]; undeclared: string[] } {
  const order: LayerPlanEntry[] = [];
  const byName = new Map<string, LayerPlanEntry>();
  const undeclared: string[] = [];

  for (const stage of plan.stages) {
    if (!plan.layers.includes(stage.layer)) {
      undeclared.push(stage.layer);
    }
    const existing = byName.get(stage.layer);
    if (existing) {
      existing.stages.push(stage.id);
    } else {
      const entry: LayerPlanEntry = { name: stage.layer, stages: [stage.id], depth: stage.depth };
      byName.set(stage.layer, entry);
      order.push(entry);
    }
  }

  // Any declared layer with no stage still belongs in the stack — an empty layer
  // the user can paint on is more useful than a missing one.
  for (const name of plan.layers) {
    if (!byName.has(name)) {
      const entry: LayerPlanEntry = { name, stages: [], depth: 'midground' };
      byName.set(name, entry);
      order.push(entry);
    }
  }

  return { entries: order, undeclared };
}

/**
 * The stack as Photoshop should see it: topmost first.
 *
 * This is the order the UI shows and the order `create_layer` must be called in,
 * because each new layer lands above the previous one.
 */
export function stackOrder(plan: PaintingPlan): LayerPlanEntry[] {
  return [...planLayers(plan).entries].reverse();
}

/** The paint order: plan order, deduplicated to one entry per layer. */
export function paintOrder(plan: PaintingPlan): LayerPlanEntry[] {
  return planLayers(plan).entries;
}