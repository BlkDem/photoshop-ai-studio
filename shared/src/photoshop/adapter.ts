import * as z from 'zod/v4';

import type { DocumentInfo, DocumentRef, DocumentState, SaveResult } from './document.js';
import type { DocumentListResult } from './operations.js';import type { LayerInfo, LayerSelector, LayerPosition } from './layer.js';
import type { CapabilitiesResult, ExportResult, ExportFormat, ParamsOf, PreviewResult } from './operations.js';
import type { RgbColor, TextAlign, TextLayerInfo } from './text.js';
/**
 * The Photoshop abstraction layer (brief §12).
 *
 * Everything above this interface — MCP tools, the orchestrator, the Studio UI —
 * is free of UXP specifics: no `batchPlay`, no ActionDescriptors, no layer IDs
 * that are only meaningful inside Photoshop. There are two implementations:
 *
 *  - `UxpRemoteAdapter` (mcp-server): forwards operations to the plugin over the
 *    WebSocket bridge.
 *  - `MockPhotoshopAdapter` (mcp-server, tests + `MOCK_PHOTOSHOP=true`): an
 *    in-memory document used for development and unit tests.
 *
 * and one contract implementation inside Photoshop itself
 * (`photoshop-plugin/lib/ops/*`), which is the only code allowed to call
 * `batchPlay`.
 *
 * Error convention: methods throw `StudioException`; the MCP tool layer converts
 * that into the `{ success: false, error: {...} }` envelope.
 */
export interface PhotoshopAdapter {
  /** Human-readable description of the backend (used by Studio's status line). */
  readonly target: AdapterTarget;

  isConnected(): boolean;
  getConnection(): AdapterConnection;

  // --- document ------------------------------------------------------------
  /** Metadata + full layer list in one round trip. */
  getDocument(documentId?: string): Promise<DocumentState>;
  /** Metadata only, no layer walk. */
  getDocumentInfo(documentId?: string): Promise<DocumentInfo>;
  /**
   * What this Photoshop build can actually be asked to do.
   *
   * Separate from `getDocumentInfo` on purpose: it describes the *host*, not
   * the artwork, and it must answer with no document open — it is the tool you
   * call to find out whether a document is needed at all.
   */
  getCapabilities(): Promise<CapabilitiesResult>;
  /** A new empty document, which becomes the active one. */
  createDocument(params: ParamsOf<'create_document'>): Promise<DocumentInfo>;
  /** The open documents and which is active. No layer walk. */
  getDocuments(): Promise<DocumentListResult>;
  /** Close a document, optionally saving to its existing path first. */
  closeDocument(params: ParamsOf<'close_document'>): Promise<DocumentRef>;
  duplicateDocument(params: ParamsOf<'duplicate_document'>): Promise<DocumentRef>;
  saveDocument(params: ParamsOf<'save_document'>): Promise<SaveResult>;

  // --- layers --------------------------------------------------------------
  getLayers(params: ParamsOf<'get_layers'>): Promise<LayerInfo[]>;
  getLayer(sel: LayerSelector): Promise<LayerInfo>;
  createLayer(params: ParamsOf<'create_layer'>): Promise<LayerInfo>;
  deleteLayer(sel: LayerSelector): Promise<{ deletedLayerId: number }>;
  renameLayer(sel: LayerSelector, name: string): Promise<LayerInfo>;
  moveLayer(sel: LayerSelector, position: LayerPosition & { dx?: number; dy?: number }): Promise<LayerInfo>;
  setLayerVisibility(sel: LayerSelector, visible: boolean): Promise<LayerInfo>;
  setLayerOpacity(sel: LayerSelector, opacity: number): Promise<LayerInfo>;
  createGroup(params: ParamsOf<'create_group'>): Promise<LayerInfo>;
  moveLayerToGroup(layer: LayerSelector, group: LayerSelector): Promise<LayerInfo>;
  reorderLayer(params: ParamsOf<'reorder_layer'>): Promise<LayerInfo>;

  // --- text ----------------------------------------------------------------
  createTextLayer(params: ParamsOf<'create_text_layer'>): Promise<TextLayerInfo>;
  getTextLayer(sel: LayerSelector): Promise<TextLayerInfo>;
  updateTextLayer(
    sel: LayerSelector,
    patch: { text?: string; font?: string; fontSize?: number; color?: RgbColor; alignment?: TextAlign },
  ): Promise<TextLayerInfo>;
  setTextPosition(sel: LayerSelector, x: number, y: number): Promise<TextLayerInfo>;
  setTextFontSize(sel: LayerSelector, fontSize: number): Promise<TextLayerInfo>;
  setTextColor(sel: LayerSelector, color: RgbColor): Promise<TextLayerInfo>;

  // --- images --------------------------------------------------------------
  placeImage(params: ParamsOf<'place_image'>): Promise<LayerInfo>;
  resizeLayer(params: ParamsOf<'resize_layer'>): Promise<LayerInfo>;

  // --- canvas --------------------------------------------------------------
  resizeCanvas(params: ParamsOf<'resize_canvas'>): Promise<DocumentInfo>;
  cropDocument(params: ParamsOf<'crop_document'>): Promise<DocumentInfo>;

  // --- export --------------------------------------------------------------
  exportDocument(params: ParamsOf<'export_document'>): Promise<ExportResult>;
  exportPng(params: ParamsOf<'export_png'>): Promise<ExportResult>;
  exportJpg(params: ParamsOf<'export_jpg'>): Promise<ExportResult>;
  savePsd(params: ParamsOf<'save_psd'>): Promise<ExportResult>;

  // --- preview -------------------------------------------------------------
  renderPreview(params: ParamsOf<'render_preview'>): Promise<PreviewResult>;
}

export interface AdapterTarget {
  /** `uxp` for the real Photoshop bridge, `mock` for the in-memory adapter. */
  kind: 'uxp' | 'mock';
  label: string;
}

export interface AdapterConnection {
  connected: boolean;
  /** Plugin id, e.g. "com.blkdem.photoshop-ai-studio". */
  pluginId: string | null;
  pluginVersion: string | null;
  /** UXP runtime version reported by the plugin, e.g. "7.2.0". */
  uxpVersion: string | null;
  hostApp: string | null;
  hostVersion: string | null;
  lastError: string | null;
  connectedAt: string | null;
  /** Round-trip latency of the last bridge call, milliseconds. */
  lastLatencyMs: number | null;
}

export const AdapterConnectionSchema = z.object({
  connected: z.boolean(),
  pluginId: z.string().nullable(),
  pluginVersion: z.string().nullable(),
  uxpVersion: z.string().nullable(),
  hostApp: z.string().nullable(),
  hostVersion: z.string().nullable(),
  lastError: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastLatencyMs: z.number().nullable(),
});

export const UNKNOWN_CONNECTION: AdapterConnection = {
  connected: false,
  pluginId: null,
  pluginVersion: null,
  uxpVersion: null,
  hostApp: null,
  hostVersion: null,
  lastError: null,
  connectedAt: null,
  lastLatencyMs: null,
};

export type { ExportFormat };
