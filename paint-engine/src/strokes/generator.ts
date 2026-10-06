/**
 * Recipe to stroke.
 *
 * This is the boundary the whole design exists to protect: an Art Director — or a
 * language model — describes a mark as a primitive inside a region, and this file
 * is the only place that turns that description into coordinates. The model never
 * sees a point list, so it cannot emit ten thousand of them, and the picture stays
 * reproducible because every random choice comes from the plan's seed.
 *
 * Brush, colour and depth are all resolved here rather than by the caller, which
 * is why a plan can name `oil_medium` and `midtones` and get a stroke that is
 * correctly sized, correctly toned and correctly softened for its distance.
 */

import type {
  DepthZone,
  PaintingPlan,
  PlanStage,
  SemanticStroke,
  StrokeRecipe,
} from '../types.js';
import { PRIMITIVES, type Path } from './primitives.js';
import { brush, withDepth } from '../brushes/catalog.js';
import { resolveColor } from '../palette/engine.js';
import { Rng } from '../random.js';

/** Per-stage RNG, so adding a stage does not reshuffle the ones before it. */
function stageRng(seed: number, stageId: string): Rng {
  let hash = 2166136261;
  for (let i = 0; i < stageId.length; i += 1) {
    hash ^= stageId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return new Rng((seed ^ hash) >>> 0);
}

/** Multiplies a stage's density into how many marks a primitive produces. */
function scaledCount(recipe: StrokeRecipe, density: number): number {
  const base = recipe.count ?? 1;
  return Math.max(1, Math.round(base * Math.max(0.05, Math.min(2, density))));
}

export interface StrokeGeneratorOptions {
  plan: PaintingPlan;
  stage: PlanStage;
}

/**
 * How firmly a recipe is laid down, as a multiple of the brush's own opacity.
 *
 * `energy` was in the plan schema from the start and nothing read it: opacity came
 * straight from the brush preset, so the director could ask for a sky at full
 * strength and get the softest wash the preset happened to define. On a white
 * ground that is the difference between a sky and a faint stain, and the ceiling
 * was set by the brush rather than by the request.
 *
 * The range runs above 1 on purpose. A glaze brush is defined at 0.18 because a
 * glaze *should* be thin, but a recipe that asks for energy 1 is asking for that
 * colour at full strength, and the way to get it is more passes of a thin brush —
 * which costs the same fills and looks better than one opaque pass — so the
 * multiplier is capped at 1 and the recipes stack instead. Only the soft end is
 * scaled down: energy below the brush's natural weight is what makes a mark read
 * as a scumble rather than as a statement.
 */
function applyEnergy(base: number, energy: number | undefined): number {
  if (energy === undefined) return base;
  if (energy <= 0) return 0;
  return Math.max(0, Math.min(1, base * (0.35 + 0.65 * energy)));
}

export class StrokeGenerator {
  private readonly plan: PaintingPlan;
  private readonly stage: PlanStage;
  private readonly rng: Rng;

  constructor(options: StrokeGeneratorOptions) {
    this.plan = options.plan;
    this.stage = options.stage;
    this.rng = stageRng(options.plan.seed, options.stage.id);
  }

  /**
   * Expands one recipe into strokes.
   *
   * `variant` is threaded through colour selection so two recipes in the same
   * stage that both asked for `midtones` get different colours from the list —
   * otherwise a whole stage lands on one colour and the depth reads as flat.
   */
  generate(recipe: StrokeRecipe, variant: number): SemanticStroke[] {
    const primitive = PRIMITIVES[recipe.primitive];
    if (!primitive) return [];

    const counted = scaledCount(recipe, this.stage.density);
    // `size` is set here rather than asked of the plan: mark length follows the
    // brush, and the brush is the engine's decision once the stage names one.
    const effective: StrokeRecipe = { ...recipe, count: counted, size: brush(this.stage.brush).size };
    const paths: Path[] = primitive(effective, this.rng);
    if (paths.length === 0) return [];

    const baseBrush = brush(this.stage.brush);
    const depth: DepthZone = this.stage.depth;
    const preset = withDepth(baseBrush, depth);
    const color = resolveColor(recipe.colorRole, this.plan.palette, this.rng, variant);

    return paths
      .filter((path) => path.length > 0)
      .map((points) => ({
        brush: preset.id,
        color,
        size: preset.size,
        opacity: applyEnergy(preset.opacity, recipe.energy),
        flow: preset.flow,
        spacing: preset.spacing,
        tip: preset.tip,
        depth,
        purpose: `${this.stage.purpose} (${recipe.primitive})`,
        points,
        ...(recipe.blendMode ?? this.stage.blendMode
          ? { blendMode: (recipe.blendMode ?? this.stage.blendMode) as SemanticStroke['blendMode'] }
          : {}),
      }));
  }

  /** Every stroke for a stage, in recipe order. */
  generateStage(): SemanticStroke[] {
    const strokes: SemanticStroke[] = [];
    for (const [index, recipe] of this.stage.strokes.entries()) {
      strokes.push(...this.generate(recipe, index));
    }
    return strokes;
  }

  /**
   * Total marks a stage will produce, without building them.
   *
   * The plan view needs this before committing to a render — "estimated strokes"
   * has to be honest, and building every stroke to count them is the one thing
   * that must not happen on the critical path.
   */
  static estimate(stage: PlanStage): number {
    let total = 0;
    for (const recipe of stage.strokes) {
      const counted = scaledCount(recipe, stage.density);
      total += estimatePaths(recipe.primitive, counted);
    }
    return total;
  }
}

/**
 * How many paths a primitive yields for a given count.
 *
 * Only the counting primitives are exact. For the rest this is a deliberate
 * under-estimate: a plan promising 1,200 strokes and delivering 900 is a
 * disappointment, one promising 900 and delivering 900 is merely dull, and the
 * progress bar is only useful if it finishes.
 */
function estimatePaths(primitive: string, count: number): number {
  switch (primitive) {
    case 'hatching':
    case 'crossHatching':
      return primitive === 'crossHatching' ? count * 2 : count;
    case 'dabs':
    case 'scatteredDabs':
      return count;
    default:
      return 1;
  }
}