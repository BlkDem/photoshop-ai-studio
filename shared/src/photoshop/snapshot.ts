import * as z from 'zod/v4';

import type { PhotoshopAdapter } from './adapter.js';
import { DocumentInfoSchema } from './document.js';
import type { DocumentInfo } from './document.js';
import { LayerInfoSchema } from './layer.js';
import type { LayerInfo } from './layer.js';

/**
 * Normalised, JSON-serialisable picture of "what Photoshop looks like right now".
 *
 * Snapshots are the input to both diffing (§18) and verification (§17). They are
 * taken before and after a plan so the system can prove the *actual* result
 * rather than trusting `{ success: true }`.
 */
export const DocumentSnapshotSchema = z.object({
  capturedAt: z.string(),
  document: DocumentInfoSchema,
  /** Flat, bottom-to-top, including group children. */
  layers: z.array(LayerInfoSchema),
});

export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;

export function buildSnapshot(document: DocumentInfo, layers: DocumentSnapshot['layers']): DocumentSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    document: normalizeDocumentInfo(document),
    layers: [...layers].sort((a, b) => a.id - b.id),
  };
}

/**
 * Captures a full snapshot. `get_document` already returns metadata plus the
 * layer list, so state capture costs exactly one Photoshop round-trip.
 */
export async function captureSnapshot(
  adapter: PhotoshopAdapter,
  options: { documentId?: string } = {},
): Promise<DocumentSnapshot> {
  const state = await adapter.getDocument(options.documentId);
  return buildSnapshot(state, state.layers);
}

/** Clamps and rounds so diffs are not polluted by float noise. */
export function normalizeDocumentInfo(doc: DocumentInfo): DocumentInfo {
  return {
    ...doc,
    width: Math.round(doc.width * 100) / 100,
    height: Math.round(doc.height * 100) / 100,
    resolution: Math.round(doc.resolution * 1000) / 1000,
    layerCount: doc.layerCount,
  };
}

export function normalizeLayers(
  layers: readonly LayerInfo[],
): DocumentSnapshot['layers'] {
  return layers.map((l) => ({
    ...l,
    opacity: Math.round(l.opacity * 10) / 10,
    x: Math.round(l.x),
    y: Math.round(l.y),
    width: Math.round(l.width),
    height: Math.round(l.height),
  }));
}

export const EMPTY_SNAPSHOT: DocumentSnapshot = {
  capturedAt: new Date(0).toISOString(),
  document: {
    id: 'none',
    name: '(no document)',
    width: 0,
    height: 0,
    resolution: 0,
    colorMode: 'RGB',
    layerCount: 0,
    path: null,
    saved: false,
    active: false,
  },
  layers: [],
};
