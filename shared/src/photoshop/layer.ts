import * as z from 'zod/v4';
import { StudioException } from '../errors.js';

/**
 * Normalised layer model.
 *
 * `LayerInfo` is deliberately *flat*: hierarchy is expressed with `parentId`
 * so that diffing, snapshotting and JSON-schema generation stay trivial. The
 * tree is reconstructed by `buildLayerTree` in the orchestrator's state layer.
 */

export const LayerKindSchema = z.enum([
  'pixel',
  'text',
  'smartObject',
  'group',
  'shape',
  'solidFill',
  'gradientFill',
  'patternFill',
  'adjustment',
  'video',
  'layer3d',
  'other',
]);

export type LayerKind = z.infer<typeof LayerKindSchema>;

/**
 * Photoshop's layer blend modes, named the way the DOM names them.
 *
 * These are the UXP `Layer.blendMode` values, not the Photoshop UI labels:
 * "Colour Dodge" is `colorDodge`, "Soft Light" is `softLight`. The plugin
 * consults `constants.BlendMode` first and falls back to this list, so a build
 * that renames a member does not break the mapping — and a model that invents a
 * mode is rejected here rather than silently becoming `normal`.
 */
export const BlendModeSchema = z.enum([
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
]);
export type BlendMode = z.infer<typeof BlendModeSchema>;

/**
 * A blend mode *as the host reports it*.
 *
 * Loose on purpose, and deliberately not the enum above. The enum is for
 * requests, where a strict list turns a model's typo into a clear error. A
 * report is evidence: if Photoshop 26.11 answers `darkerColor` as something the
 * list does not contain, the useful thing to pass on is what it actually said,
 * not a value the schema would have preferred.
 */
export const ReportedBlendModeSchema = z.string().min(1);

/** Axis-aligned bounds in document pixels. Zero-sized for empty layers. */
export const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type Bounds = z.infer<typeof BoundsSchema>;

export const LayerInfoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: LayerKindSchema,
  visible: z.boolean(),
  /** 0..100, rounded to one decimal by the adapter. */
  opacity: z.number().min(0).max(100),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  /** `null` for a top-level layer. */
  parentId: z.number().int().nullable(),

  // --- optional enrichment ------------------------------------------------
  fillOpacity: z.number().min(0).max(100).optional(),
  blendMode: ReportedBlendModeSchema.optional(),
  /**
   * Whether the layer still overlaps the canvas.
   *
   * Derived, and read by verification: a transform that pushed the content off
   * the frame looks exactly like a successful edit otherwise.
   */
  withinCanvas: z.boolean().optional(),
  isBackground: z.boolean().optional(),
  isClippingMask: z.boolean().optional(),
  isLocked: z.boolean().optional(),
  /** Child layer ids, in Photoshop stacking order (index 0 = bottom). */
  children: z.array(z.number().int()).optional(),
  /** Present when `type === 'text'`. */
  hasText: z.boolean().optional(),
});

export type LayerInfo = z.infer<typeof LayerInfoSchema>;

/**
 * How a tool addresses a layer.
 *
 * Exactly one of `layerId` / `layerName` must be supplied. Cross-field
 * exclusivity is enforced by `assertLayerSelector` rather than by a zod
 * refinement so the generated JSON Schema stays a plain `object` (which is what
 * MCP clients and LLM tool definitions consume most reliably).
 */
export const LayerSelectorSchema = z.object({
  /** Preferred: numeric Photoshop layer id. Stable across reordering. */
  layerId: z.number().int().optional(),
  /** Convenience for humans and for LLM-produced plans. Ambiguous if duplicated. */
  layerName: z.string().min(1).optional(),
});

export type LayerSelector = z.infer<typeof LayerSelectorSchema>;

export function hasLayerSelector(v: LayerSelector): boolean {
  return v.layerId !== undefined || v.layerName !== undefined;
}

/**
 * Validates the "exactly one of" rule and returns the concrete selector.
 * Throws `StudioException('INVALID_PARAMS')` on violation.
 */
export type ResolvedLayerSelector = { layerId: number } | { layerName: string };

export function assertLayerSelector(sel: LayerSelector): ResolvedLayerSelector {
  const byId = sel.layerId !== undefined;
  const byName = sel.layerName !== undefined;
  if (byId === byName) {
    throw new StudioException(
      'INVALID_PARAMS',
      byId ? '`layerName` must be omitted when `layerId` is given' : 'Provide either `layerId` or `layerName`',
    );
  }
  return byId ? { layerId: sel.layerId as number } : { layerName: sel.layerName as string };
}

/** Where a layer should end up, both in space and in the stacking order. */
export const ElementPlacementSchema = z.enum([
  'placeInside',
  'placeBefore',
  'placeAfter',
  'placeAtBeginning',
  'placeAtEnd',
]);

export type ElementPlacement = z.infer<typeof ElementPlacementSchema>;

export const LayerPositionSchema = z.object({
  /** Target top-left corner. Omitted means "keep current". */
  x: z.number().optional(),
  y: z.number().optional(),
});

export type LayerPosition = z.infer<typeof LayerPositionSchema>;

/** Builds `parentId`-based tree nodes from a flat layer list. */
export interface LayerTreeNode extends LayerInfo {
  /** 0-based depth from the document root. */
  depth: number;
  /** Ordered children, bottom layer first (Photoshop stacking order). */
  childLayers: LayerTreeNode[];
}

export function buildLayerTree(layers: readonly LayerInfo[]): LayerTreeNode[] {
  const byId = new Map<number, LayerTreeNode>();
  for (const layer of layers) {
    byId.set(layer.id, { ...layer, depth: 0, childLayers: [] });
  }
  const roots: LayerTreeNode[] = [];
  for (const layer of layers) {
    const node = byId.get(layer.id);
    if (!node) continue;
    const parent = layer.parentId !== null ? byId.get(layer.parentId) : undefined;
    if (parent) {
      parent.childLayers.push(node);
      node.depth = parent.depth + 1;
    } else {
      roots.push(node);
    }
  }
  // Deterministic ordering: bottom-most first, then by id for stability.
  roots.sort((a, b) => a.id - b.id);
  for (const node of byId.values()) {
    node.childLayers.sort((a, b) => a.id - b.id);
  }
  return roots;
}

/** Depth-first flattening of a tree back into a flat list (root → leaves). */
export function flattenLayerTree(roots: readonly LayerTreeNode[]): LayerTreeNode[] {
  const out: LayerTreeNode[] = [];
  const visit = (nodes: readonly LayerTreeNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      visit(n.childLayers);
    }
  };
  visit(roots);
  return out;
}

/** Resolves a selector against a flat layer list. Returns `null` when missing. */
export function findLayer(layers: readonly LayerInfo[], sel: LayerSelector): LayerInfo | null {
  if (sel.layerId !== undefined) {
    return layers.find((l) => l.id === sel.layerId) ?? null;
  }
  if (sel.layerName !== undefined) {
    return layers.find((l) => l.name === sel.layerName) ?? null;
  }
  return null;
}
