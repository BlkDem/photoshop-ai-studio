/**
 * The vocabulary the painting engine speaks.
 *
 * ## Why this file exists
 *
 * A language model is good at deciding *what the picture is* and bad at emitting
 * thousands of coordinates. So the contract between the AI and Photoshop is
 * deliberately narrow: the model produces a `PaintingPlan`, the engine expands
 * it into `SemanticStroke`s with real points, and only then does anything reach
 * Photoshop. There is no path where a model is asked for a stroke path.
 *
 * ## What "brush" honestly means here
 *
 * Photoshop's own brush engine is unreachable from UXP on the host this was
 * built against, and equally unreachable from ExtendScript (`app.brushes` does
 * not exist). So a `BrushPreset` here is **not** a Photoshop brush preset: it is
 * a *synthesized tip model* — a diameter plus a radial falloff the paint engine
 * rasterizes out of overlapping discs. `tipIsSynthesized` is `true` on every
 * preset precisely so nothing downstream can quietly present one as a real
 * Photoshop brush. See docs/painting-engine.md.
 */

export type { BlendMode } from '@photoshop-ai-studio/shared';

import type { BlendMode } from '@photoshop-ai-studio/shared';

/** A point in normalized canvas space: 0,0 is top-left, 1,1 is bottom-right. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** An axis-aligned region in normalized canvas space. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Which part of the picture's depth a mark belongs to.
 *
 * Depth is the cheapest available substitute for real perspective: it is what
 * decides how large, how contrasty and how detailed a stroke is allowed to be.
 * A background crest painted with foreground crispness is what makes a generated
 * image read as flat, and it is invisible in the plan until the depth is named.
 */
export type DepthZone = 'background' | 'midground' | 'foreground';

/** The five tonal roles a palette is built from. */
export type PaletteRole = 'shadows' | 'midtones' | 'highlights' | 'accents' | 'base';

/**
 * How a synthesized tip is shaped.
 *
 * `core` is the fraction of the diameter that is fully opaque; the remainder
 * fades to nothing over `steps` concentric discs. `hardness` 1 is a flat disc
 * with no falloff at all — which is exactly what the un-tipped rasterizer
 * already produces — and 0 is the softest brush this engine will synthesize.
 */
export interface TipModel {
  /** Fraction of the diameter painted at full alpha, 0..1. */
  core: number;
  /** Concentric discs used to approximate the falloff, >= 1. */
  steps: number;
  /** Alpha of the outermost ring as a fraction of the core, 0..1. */
  outerAlpha: number;
}

/** A named, reusable brush definition. Sizes are normalized (see below). */
export interface BrushPreset {
  id: string;
  label: string;
  /**
   * Diameter as a fraction of the canvas's smaller side, so one plan renders the
   * same picture at any resolution. A value of 0.1 is a tenth of the short edge
   * on a 1920x1080 canvas, which is 108px.
   */
  size: number;
  /** Stroke opacity, 0..1. */
  opacity: number;
  /** Per-dab flow, 0..1. */
  flow: number;
  /**
   * Stamp spacing as a fraction of the radius. Lower is denser and more opaque
   * per stroke but costs one Photoshop fill per stamp, so it is a quality dial
   * with a wall-clock price.
   */
  spacing: number;
  tip: TipModel;
  /**
   * Always true. Present so that a caller rendering a brush name in the UI or a
   * log cannot imply a Photoshop preset without reading this flag.
   */
  tipIsSynthesized: true;
}

/**
 * A single mark with real coordinates, ready to be rasterized.
 *
 * This is the boundary of the engine: everything above it is description,
 * everything below it is pixels.
 */
export interface SemanticStroke {
  brush: string;
  /** `#rrggbb`. The engine resolves colour roles before a stroke reaches here. */
  color: string;
  /** Diameter in the same normalized units as `BrushPreset.size`. */
  size: number;
  /** 0..1 */
  opacity: number;
  /** 0..1 */
  flow: number;
  /** Spacing as a fraction of the radius. */
  spacing: number;
  tip: TipModel;
  depth: DepthZone;
  /** Free text kept for the plan view and for verification messages. */
  purpose: string;
  points: NormalizedPoint[];
  blendMode?: BlendMode;
}

/**
 * The geometric description of a mark, as an Art Director would state it.
 *
 * A model emits these, never points. Everything a generator needs is here as a
 * number with a default, so a plan that says only `{ primitive: 'dabs',
 * region, count }` is still a complete instruction.
 */
export interface StrokeRecipe {
  primitive: StrokePrimitive;
  /** Where on the canvas the mark lives. Generators work in this box. */
  region: NormalizedRect;
  /** How many marks to emit. Required by the counting primitives, ignored otherwise. */
  count?: number;
  /** Heading in normalized units; length is not significant. */
  direction?: NormalizedPoint;
  /** 0 = straight, 1 = strongly bowed. */
  curvature?: number;
  /** Peak displacement of a wave, in canvas-height units. */
  amplitude?: number;
  /** Crossings per unit length. */
  frequency?: number;
  /** 0..1 — how hard the mark is driven; scales length and contrast. */
  energy?: number;
  /** Palette role to take the colour from, or an explicit `#rrggbb`. */
  colorRole?: PaletteRole | string;
  /** Blend mode for this mark, e.g. 'screen' for light and 'multiply' for shadow. */
  blendMode?: BlendMode;
  /** 0..1 — how much the marks wander off their grid. */
  jitter?: number;
  /** Taper the ends with a pressure ramp. */
  taper?: boolean;
  /**
   * Nominal mark length, filled in by the engine from the brush diameter.
   *
   * Deliberately not authorable: a dab's length has to be tied to the brush that
   * paints it, or a `scatteredDabs` over a wide region produces long sticks the
   * width of a straw instead of specks. The Art Director chooses the brush, not
   * the mark length, so this is derived rather than requested.
   */
  size?: number;
}

/**
 * The mark shapes this engine can synthesize.
 *
 * Named after what the mark *is*, not after how it is drawn, so a new primitive
 * can be added without touching the model that asked for it.
 */
export type StrokePrimitive =
  | 'line'
  | 'curve'
  | 'wave'
  | 'arc'
  | 'cloud'
  | 'hatching'
  | 'crossHatching'
  | 'dabs'
  | 'scatteredDabs'
  | 'highlight'
  | 'glaze';

/** One painting step: a layer's worth of marks. */
export interface PlanStage {
  id: string;
  /** The Photoshop layer these marks land on. */
  layer: string;
  /** Shown in the plan view; also used by the Vision Critic to judge intent. */
  purpose: string;
  brush: string;
  depth: DepthZone;
  /** Palette roles this stage draws from, most-used first. */
  palette: string[];
  /** 0..1 — how many marks relative to the stage's natural density. */
  density: number;
  /** 0..1 — how fine the marks are. Drives brush choice and mark count. */
  detail: number;
  blendMode?: BlendMode;
  /** 0..1 — where this stage sits in progressive rendering. */
  progress: number;
  strokes: StrokeRecipe[];
}

/** A complete, renderable description of a painting. */
export interface PaintingPlan {
  title: string;
  /** Document size the plan was composed against. */
  canvas: { width: number; height: number };
  /** The artistic brief, kept verbatim for the Vision Critic and the UI. */
  style: PaintingStyle;
  composition: CompositionSpec;
  palette: PaletteSpec;
  layers: string[];
  stages: PlanStage[];
  /**
   * Plan-wide random seed. The engine is fully deterministic given a seed, so a
   * painting can be reproduced exactly — which is what makes a diff of two
   * renders meaningful and makes the tests worth writing.
   */
  seed: number;
  maxIterations: number;
}

/** The general visual parameters a request is translated into. */
export interface PaintingStyle {
  medium: 'oil' | 'acrylic' | 'watercolor' | 'charcoal' | 'ink' | 'pastel' | 'digital';
  /** How the marks behave: 'layered' lays colour in, 'broken' leaves texture. */
  brushCharacter: string;
  /** Overall value range. */
  contrast: 'low' | 'medium' | 'high';
  atmosphere: string;
  /** Surface: how much the paint's own texture should show. */
  texture: 'smooth' | 'moderate' | 'heavy';
  /** Edge quality across the whole picture. */
  edgeCharacter: 'hard' | 'mixed' | 'soft';
  colorTemperature: 'cool' | 'neutral' | 'warm';
  detailLevel: number;
}

/** Where things sit. */
export interface CompositionSpec {
  framework: 'ruleOfThirds' | 'center' | 'goldenRatio' | 'diagonal';
  /** Normalized horizontal line, or null for a picture with no horizon. */
  horizon: number | null;
  focalPoint: NormalizedPoint;
  /** Named bands as fractions of canvas height, bottom-up. */
  regions: {
    sky?: NormalizedRect;
    ground?: NormalizedRect;
    subject?: NormalizedRect;
    foreground?: NormalizedRect;
    [key: string]: NormalizedRect | undefined;
  };
  /** How much empty space the picture has. 0 = crowded, 1 = sparse. */
  negativeSpace: number;
}

/** A resolved five-role palette. */
export interface PaletteSpec {
  shadows: string[];
  midtones: string[];
  highlights: string[];
  accents: string[];
  base: string[];
}

/** What the paint engine hands to Photoshop, one layer at a time. */
export interface PaintBatch {
  layer: string;
  strokes: SemanticStroke[];
  /** Set on the first batch for a layer so the adapter knows to create it. */
  createLayer: boolean;
}

/** Progress reported while a plan is being painted. */
export interface PaintProgress {
  stageId: string;
  layer: string;
  purpose: string;
  /** 0..1 across the whole plan. */
  overall: number;
  /** 0..1 within the current stage. */
  stage: number;
  strokesDone: number;
  strokesTotal: number;
  brush: string;
  phase: PaintPhase;
}

/**
 * Progressive rendering phases, in the order a painting is actually built.
 *
 * The order is the point: masses before colours before forms before details
 * means a partially painted picture still reads as the picture, instead of a
 * canvas with a few confident marks on it.
 */
export type PaintPhase =
  | 'composition'
  | 'masses'
  | 'colors'
  | 'forms'
  | 'details'
  | 'highlights'
  | 'final';