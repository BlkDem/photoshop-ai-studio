import * as z from 'zod/v4';

import { LayerInfoSchema } from './layer.js';

/**
 * Normalised Photoshop document model.
 *
 * These types are the contract between the UXP adapter (inside Photoshop) and
 * everything else in the system. They intentionally mirror the shape requested
 * in the product brief while staying free of UXP/Adobe specifics.
 */

export const DocumentColorModeSchema = z.enum([
  'RGB',
  'CMYK',
  'GRAYSCALE',
  'LAB',
  'BITMAP',
  'DUOTONE',
  'INDEXEDCOLOR',
  'MULTICHANNEL',
]);

export type DocumentColorMode = z.infer<typeof DocumentColorModeSchema>;

export const DocumentInfoSchema = z.object({
  /** Stable within a Photoshop session. Not persisted across restarts. */
  id: z.string(),
  name: z.string(),
  width: z.number(),
  height: z.number(),
  resolution: z.number(),
  colorMode: DocumentColorModeSchema,
  layerCount: z.number(),

  // --- optional enrichment, always present in practice but optional in schema
  /** Absolute path of the .psd on disk, or null when never saved. */
  path: z.string().nullable().optional(),
  /** True when the document has no unsaved changes. */
  saved: z.boolean().optional(),
  /** True when this is the document the user is currently looking at. */
  active: z.boolean().optional(),
  colorProfile: z.string().nullable().optional(),
  bitsPerChannel: z.number().int().optional(),
  pixelAspectRatio: z.number().optional(),
  /** 0..1 UI zoom level. Presentation only. */
  zoom: z.number().optional(),
});

export type DocumentInfo = z.infer<typeof DocumentInfoSchema>;

/**
 * `get_document` result: metadata **and** the complete layer list.
 *
 * This is the shape the AI is expected to fetch first (§13) — one round trip
 * gives it the canvas geometry and the full hierarchy. The metadata-only shape
 * required by the brief is a strict subset, exposed as `get_document_info`.
 */
export const DocumentStateSchema = DocumentInfoSchema.extend({
  /** Flat, bottom-to-top, including nested group children. */
  layers: z.array(LayerInfoSchema),
  /**
   * The active selection, or `null` when nothing is selected.
   *
   * Part of the state because a selection is real, user-visible state: a plan that
   * sets one and then acts on the document should be able to say what was
   * selected, and verification needs something to check `set_selection` against.
   */
  /**
   * Whether anything is selected, independent of how much.
   *
   * Separate from `selection` because deselecting is a real outcome with nothing
   * to read back, and "the selection is absent" is the fact to verify.
   */
  selectionActive: z.boolean().optional(),
  selection: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      feather: z.number().optional(),
    })
    .nullable()
    .optional(),
});

export type DocumentState = z.infer<typeof DocumentStateSchema>;

/** Result of `duplicate_document` — the new document becomes active. */
export const DocumentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type DocumentRef = z.infer<typeof DocumentRefSchema>;

export const SaveResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative().optional(),
  overwritten: z.boolean(),
});

export type SaveResult = z.infer<typeof SaveResultSchema>;
