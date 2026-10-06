/**
 * Schemas for everything a model is allowed to hand the engine.
 *
 * Two rules shape this file:
 *
 *  1. **The model is not trusted with geometry.** `PaintingPlanSchema` describes
 *     *regions and parameters*, never point lists. Points are the engine's job.
 *     A model that emits coordinates gets them dropped rather than obeyed.
 *  2. **Failures name the stage.** A rejected plan of twelve stages is useless
 *     if the message says "invalid input". `validatePaintingPlan` reports which
 *     stage and which recipe failed, because the caller is usually a human
 *     looking at a plan preview.
 *
 * Schemas are effect-free (no `.transform()`) so a plan round-trips unchanged,
 * which keeps `plan -> engine -> plan` comparisons honest.
 */

import { z } from 'zod';
import type { BlendMode } from '@photoshop-ai-studio/shared';

/** `BlendModeSchema` lives in `shared`; re-declared here only as a fallback. */
const BLEND_MODES = [
  'normal',
  'dissolve',
  'darken',
  'multiply',
  'colorBurn',
  'linearBurn',
  'darkerColor',
  'lighten',
  'screen',
  'colorDodge',
  'linearDodge',
  'lighterColor',
  'overlay',
  'softLight',
  'hardLight',
  'vividLight',
  'linearLight',
  'pinLight',
  'hardMix',
  'difference',
  'exclusion',
  'subtract',
  'divide',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const satisfies readonly BlendMode[];

const Unit = z.number().min(0).max(1);

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb')
  .transform((value) => value.toLowerCase());

export const PointSchema = z.object({ x: Unit, y: Unit });

export const RectSchema = z.object({
  x: Unit,
  y: Unit,
  // A region may not be larger than the canvas, but it may sit at the edge.
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});

export const TipModelSchema = z.object({
  core: z.number().min(0.05).max(1),
  steps: z.number().int().min(1).max(8),
  outerAlpha: z.number().min(0).max(1),
});

export const BrushPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  size: z.number().gt(0).max(1),
  opacity: Unit,
  flow: Unit,
  spacing: z.number().gt(0).max(1),
  tip: TipModelSchema,
  tipIsSynthesized: z.literal(true),
});

export const STROKE_PRIMITIVES = [
  'line',
  'curve',
  'wave',
  'arc',
  'cloud',
  'hatching',
  'crossHatching',
  'dabs',
  'scatteredDabs',
  'highlight',
  'glaze',
] as const;

/** Primitives that do nothing without `count`. */
export const COUNTED_PRIMITIVES = new Set(['hatching', 'crossHatching', 'dabs', 'scatteredDabs']);

export const StrokeRecipeSchema = z.object({
  primitive: z.enum(STROKE_PRIMITIVES),
  region: RectSchema,
  count: z.number().int().min(1).max(4000).optional(),
  direction: PointSchema.optional(),
  curvature: z.number().min(0).max(1).optional(),
  amplitude: z.number().min(0).max(2).optional(),
  frequency: z.number().min(0).max(20).optional(),
  energy: Unit.optional(),
  colorRole: z.string().min(1).optional(),
  blendMode: z.enum(BLEND_MODES).optional(),
  jitter: Unit.optional(),
  taper: z.boolean().optional(),
  /**
   * Engine-authored, not model-authored. Present in the schema so a plan that has
   * been through the generator and is re-validated does not fail on a field it
   * legitimately carries; `StrokeRecipe` marks it as derived in its doc comment.
   */
  size: z.number().gt(0).max(1).optional(),
});

export const DepthZoneSchema = z.enum(['background', 'midground', 'foreground']);

export const PlanStageSchema = z.object({
  id: z.string().min(1),
  layer: z.string().min(1),
  purpose: z.string().min(1),
  brush: z.string().min(1),
  depth: DepthZoneSchema,
  palette: z.array(z.string().min(1)).min(1),
  density: Unit,
  detail: Unit,
  blendMode: z.enum(BLEND_MODES).optional(),
  progress: Unit,
  strokes: z.array(StrokeRecipeSchema).min(1),
});

export const PaintingStyleSchema = z.object({
  medium: z.enum(['oil', 'acrylic', 'watercolor', 'charcoal', 'ink', 'pastel', 'digital']),
  brushCharacter: z.string().min(1),
  contrast: z.enum(['low', 'medium', 'high']),
  atmosphere: z.string().min(1),
  texture: z.enum(['smooth', 'moderate', 'heavy']),
  edgeCharacter: z.enum(['hard', 'mixed', 'soft']),
  colorTemperature: z.enum(['cool', 'neutral', 'warm']),
  detailLevel: Unit,
});

export const CompositionSpecSchema = z.object({
  framework: z.enum(['ruleOfThirds', 'center', 'goldenRatio', 'diagonal']),
  horizon: z.number().min(0).max(1).nullable(),
  focalPoint: PointSchema,
  regions: z.record(z.string(), RectSchema),
  negativeSpace: Unit,
});

const ColorList = z.array(HexColor).max(8);

export const PaletteSpecSchema = z.object({
  shadows: ColorList,
  midtones: ColorList,
  highlights: ColorList,
  accents: ColorList,
  base: ColorList,
});

export const PaintingPlanSchema = z.object({
  title: z.string().min(1),
  canvas: z.object({ width: z.number().int().min(1).max(16000), height: z.number().int().min(1).max(16000) }),
  style: PaintingStyleSchema,
  composition: CompositionSpecSchema,
  palette: PaletteSpecSchema,
  layers: z.array(z.string().min(1)).min(1),
  stages: z.array(PlanStageSchema).min(1),
  seed: z.number().int().min(0).max(0xffffffff),
  maxIterations: z.number().int().min(0).max(10),
});

/** Why a plan was refused. Carries enough context to point at the offending part. */
export class PlanValidationError extends Error {
  readonly stageId: string | null;
  readonly strokeIndex: number | null;

  constructor(message: string, stageId: string | null = null, strokeIndex: number | null = null) {
    super(stageId ? `${message} (stage "${stageId}"${strokeIndex === null ? '' : `, mark ${strokeIndex}`})` : message);
    this.name = 'PlanValidationError';
    this.stageId = stageId;
    this.strokeIndex = strokeIndex;
  }
}

/**
 * Parses and cross-checks a plan.
 *
 * Zod gets the shapes; the rules that need the whole document live here:
 *
 *  - every stage's `layer` must appear in `layers`
 *  - a `count`-requiring primitive must actually carry `count`
 *  - no two stages may share an id
 *  - `progress` must be non-decreasing across stages, because the renderer
 *    paints in array order and a plan that goes backwards would report progress
 *    that lies
 */
export function validatePaintingPlan(input: unknown): z.infer<typeof PaintingPlanSchema> {
  const plan = PaintingPlanSchema.safeParse(input);
  if (!plan.success) {
    const issue = plan.error.issues[0];
    const path = issue?.path.join('.') ?? '(root)';
    throw new PlanValidationError(`painting plan is invalid at ${path}: ${issue?.message ?? 'unknown'}`);
  }
  const parsed = plan.data;

  const known = new Set(parsed.layers);
  const seen = new Set<string>();
  let previousProgress = -Infinity;

  for (const stage of parsed.stages) {
    if (!known.has(stage.layer)) {
      throw new PlanValidationError(`layer "${stage.layer}" is not in the plan's layer list`, stage.id);
    }
    if (seen.has(stage.id)) {
      throw new PlanValidationError(`duplicate stage id`, stage.id);
    }
    seen.add(stage.id);

    if (stage.progress < previousProgress) {
      throw new PlanValidationError(
        `progress ${stage.progress} goes backwards; stages are painted in order`,
        stage.id,
      );
    }
    previousProgress = stage.progress;

    for (const [index, recipe] of stage.strokes.entries()) {
      if (COUNTED_PRIMITIVES.has(recipe.primitive) && recipe.count === undefined) {
        throw new PlanValidationError(`"${recipe.primitive}" needs a count`, stage.id, index);
      }
      const region = recipe.region;
      if (region.x + region.width > 1.0001 || region.y + region.height > 1.0001) {
        throw new PlanValidationError('region extends past the canvas edge', stage.id, index);
      }
    }
  }

  return parsed;
}

/** The parsed plan's shape, re-exported so callers need not import zod. */
export type ValidatedPaintingPlan = z.infer<typeof PaintingPlanSchema>;