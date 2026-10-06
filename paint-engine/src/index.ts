/**
 * The painting engine's public surface.
 *
 * Import order below is deliberate: types first because everything else is
 * expressed in them, then pure helpers, then the facade. A consumer should be
 * able to reach for `buildPalette` or `StrokeGenerator` without pulling in the
 * engine that drives Photoshop.
 */

export type {
  BlendMode,
  BrushPreset,
  CompositionSpec,
  DepthZone,
  NormalizedPoint,
  NormalizedRect,
  PaintBatch,
  PaintPhase,
  PaintProgress,
  PaintingPlan,
  PaintingStyle,
  PaletteRole,
  PaletteSpec,
  PlanStage,
  SemanticStroke,
  StrokePrimitive,
  StrokeRecipe,
  TipModel,
} from './types.js';

export { Rng } from './random.js';

export {
  COUNTED_PRIMITIVES,
  PlanValidationError,
  STROKE_PRIMITIVES,
  validatePaintingPlan,
  type ValidatedPaintingPlan,
} from './validation.js';

export {
  BRUSHES,
  DEPTH_RESPONSE,
  brush,
  brushForDetail,
  brushIds,
  hasBrush,
  withDepth,
  type DepthResponse,
} from './brushes/catalog.js';

export {
  fillAlpha,
  overlapDivisor,
  ringAlpha,
  spacingFor,
  stampSpacing,
  tipRings,
  type TipRing,
} from './brushes/tip.js';

export {
  buildPalette,
  cool,
  darken,
  desaturate,
  hexToRgb,
  hueDistance,
  lighten,
  luminance,
  mix,
  paletteSwatches,
  resolveColor,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  saturate,
  shift,
  warm,
  type Hsl,
  type Rgb,
} from './palette/engine.js';

export {
  CompositionEngine,
  chooseFocalPoint,
  chooseHorizon,
  depthBands,
  frameworkFocalPoints,
  type CompositionFramework,
  type DepthZoneName,
} from './composition/engine.js';

export {
  PRIMITIVES,
  arc,
  cloud,
  crossHatching,
  curve,
  dabs,
  glaze,
  hatching,
  highlight,
  line,
  scatteredDabs,
  wave,
  type Path,
  type PrimitiveName,
} from './strokes/primitives.js';

export { StrokeGenerator } from './strokes/generator.js';

export {
  planLayers,
  paintOrder,
  stackOrder,
  type LayerPlanEntry,
} from './layers/strategy.js';

export {
  brushToPixels,
  regionToPixels,
  shortEdge,
  strokeToPixels,
  toPixels,
  type CanvasSize,
  type PixelStroke,
} from './renderer/coordinates.js';

export {
  DEFAULT_FILL_BUDGET,
  MAX_STAMPS_PER_STROKE,
  budgetStroke,
  buildBatches,
  fillsPerStamp,
  stampsNeeded,
  type BatchOptions,
  type BatchReport,
} from './renderer/batches.js';

export {
  PaintEngine,
  type PaintEngineOptions,
  type PaintReport,
  type PaintTarget,
} from './paint-engine.js';
export {
  direct,
  parseBrief,
  stagesFor,
  layersFor,
  type ArtDirectorOptions,
  type DirectedPlan,
  type Brief,
  type Element,
  type SceneKind,
} from './art-director/director.js';

export { decodePng, type RgbImage } from './critique/png.js';
export { measure, type ImageMetrics, type BandValues } from './critique/metrics.js';
export {
  critique,
  critiquePng,
  formatCritique,
  DEFAULT_THRESHOLDS,
  type Critique,
  type CritiqueOptions,
  type Finding,
  type Severity,
  type Thresholds,
} from './critique/critic.js';
