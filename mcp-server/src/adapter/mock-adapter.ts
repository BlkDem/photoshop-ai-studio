import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  UNKNOWN_CONNECTION,
  StudioException,
  normalizeColor,
  type AdapterConnection,
  type AdapterTarget,
  type Anchor,
  type CapabilitiesResult,
  type DocumentListResult,
  type DocumentInfo,
  type DocumentRef,
  type DocumentState,
  type ExportResult,
  type FontInfo,
  type LayerInfo,
  type LayerSelector,
  type ParamsOf,
  type PhotoshopAdapter,
  type PreviewResult,
  type SampleColorResult,
  type RgbColor,
  type SaveResult,
  type TextAlign,
  type TextLayerInfo,
  type BrushInfo,
  type ListBrushesResult,
  type BrushStrokeResult,
} from '@photoshop-ai-studio/shared';
import { Workspace } from '../workspace.js';

/** The capability ids the plugin reports; kept here so the two stay comparable. */
const MOCK_CAPABILITIES = [
  'document.read',
  'document.new',
  'document.close',
  'document.duplicate',
  'document.save',
  'document.resize_canvas',
  'document.export_png',
  'layer.create',
  'layer.move',
  'layer.scale',
  'layer.mask',
  'selection.all',
  'adjustment.layer',
  'text.create',
  'text.color',
  'image.place',
] as const;

/**
 * In-memory Photoshop.
 *
 * Not a mockup: it is a genuine implementation of the `PhotoshopAdapter`
 * contract over a plain data structure — the same object model, the same
 * validation, the same typed errors, the same files on disk. That is what makes
 * it useful for two different purposes:
 *
 *   1. `MOCK_PHOTOSHOP=true npm run dev` — run the entire pipeline (chat →
 *      plan → execute → diff → verify) with no Photoshop licence in the loop.
 *   2. unit tests for the orchestrator, verification engine and repair loop.
 *
 * The production path never touches this class (brief §31). It is selected only
 * by configuration.
 */

interface MockText {
  text: string;
  font: string;
  fontSize: number;
  color: RgbColor;
  alignment?: TextAlign;
  pointX: number;
  pointY: number;
}

interface MockDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  resolution: number;
  colorMode: DocumentInfo['colorMode'];
  /** Bottom-to-top stacking order. */
  layers: LayerInfo[];
  texts: Map<number, MockText>;
  path: string | null;
  saved: boolean;
  nextLayerId: number;
}

export interface MockAdapterOptions {
  workspace: Workspace;
  /** Seed the §29 demo document (banner.psd, 1920×1080). Defaults to true. */
  demoDocument?: boolean;
}

export class MockPhotoshopAdapter implements PhotoshopAdapter {
  readonly target: AdapterTarget = { kind: 'mock', label: 'Mock Photoshop (in-memory)' };

  private readonly documents = new Map<string, MockDocument>();
  private activeId: string | null = null;
  private connected = true;
  private lastLatencyMs: number | null = null;

  constructor(private readonly options: MockAdapterOptions) {
    if (options.demoDocument !== false) this.seedDemoDocument();
  }

  // --- test helpers --------------------------------------------------------

  static demoDocumentName = 'banner.psd';

  seedDemoDocument(): void {
    const doc = this.newDocument({ name: 'banner.psd', width: 1920, height: 1080 });
    this.addLayer(doc, { name: 'Background', type: 'pixel', x: 0, y: 0, width: 1920, height: 1080, isBackground: true });
    this.addLayer(doc, { name: 'Logo', type: 'smartObject', x: 120, y: 80, width: 320, height: 120 });
    this.addText(doc, { name: 'Title', text: 'Spring Sale', x: 120, y: 300, fontSize: 96, width: 1200 });
    this.addText(doc, { name: 'Subtitle', text: 'Up to 50% off everything', x: 120, y: 440, fontSize: 40, width: 1200 });
    this.addText(doc, { name: 'CTA', text: 'Shop now', x: 120, y: 560, fontSize: 28, width: 400, color: { r: 255, g: 255, b: 255 } });
    this.activeId = doc.id;
  }

  reset(): void {
    this.documents.clear();
    this.activeId = null;
    this.seedDemoDocument();
  }

  // --- connection ----------------------------------------------------------

  isConnected(): boolean {
    return this.connected;
  }

  setConnected(value: boolean): void {
    this.connected = value;
  }

  getConnection(): AdapterConnection {
    return {
      ...UNKNOWN_CONNECTION,
      connected: this.connected,
      hostApp: 'MockPhotoshop',
      hostVersion: '25.0',
      uxpVersion: 'n/a',
      pluginId: 'mock',
      pluginVersion: '0.1.0',
      connectedAt: new Date(0).toISOString(),
      lastLatencyMs: this.lastLatencyMs,
    };
  }

  // --- document ------------------------------------------------------------

  async getDocument(): Promise<DocumentState> {
    const doc = this.active();
    this.lastLatencyMs = 0;
    return { ...this.toInfo(doc), layers: doc.layers.map((l) => ({ ...l })) };
  }

  /**
   * The mock claims everything works.
   *
   * It is the in-memory adapter used by the offline smoke test, where "does the
   * pipeline work" is the question — not "does Photoshop 26.11 cooperate". The
   * real report comes from the UXP plugin.
   */
  async createDocument(params: ParamsOf<'create_document'>): Promise<DocumentInfo> {
    const info: DocumentInfo = {
      id: randomUUID(),
      name: params.name ?? 'Untitled-1',
      width: params.width,
      height: params.height,
      resolution: params.resolution ?? 72,
      colorMode: params.colorMode ?? 'RGB',
      layerCount: 0,
      path: null,
      saved: false,
      active: true,
      bitsPerChannel: 8,
      pixelAspectRatio: 1,
      zoom: 100,
    };
    const doc = this.newDocument({
      name: info.name,
      width: info.width,
      height: info.height,
      resolution: info.resolution,
      colorMode: info.colorMode,
    });
    if (params.background !== 'transparent') {
      this.addLayer(doc, {
        name: 'Background',
        type: 'pixel',
        x: 0,
        y: 0,
        width: info.width,
        height: info.height,
        isBackground: true,
      });
    }
    this.activeId = doc.id;
    return { ...info, id: doc.id, layerCount: doc.layers.length };
  }

  async getDocuments(): Promise<DocumentListResult> {
    const documents = [...this.documents.entries()].map(([id, doc]) => ({ id, name: doc.name }));
    return { activeDocumentId: this.activeId, documents };
  }

  async closeDocument(params: ParamsOf<'close_document'>): Promise<DocumentRef> {
    const id = params.documentId === 'active' ? (this.activeId ?? '') : params.documentId;
    const doc = this.documents.get(id);
    if (!doc) {
      throw new StudioException('DOCUMENT_NOT_FOUND', `No open document with id "${id}".`);
    }
    this.documents.delete(id);
    if (this.activeId === id) this.activeId = this.documents.keys().next().value ?? null;
    return { id, name: doc.name };
  }

  async setSelection(params: ParamsOf<'set_selection'>): Promise<DocumentState> {
    const doc = this.active();
    let box: Record<string, unknown> | null = null;

    if (params.mode === 'all') {
      box = { x: 0, y: 0, width: doc.width, height: doc.height };
    } else if (params.mode === 'invert') {
      // The mock has no real marching ants; a marker that records the inversion is
      // enough for the smoke test to assert the plan reached the adapter.
      const previous = (doc as unknown as { selection?: Record<string, unknown> | null }).selection ?? null;
      box = previous
        ? { x: 0, y: 0, width: doc.width, height: doc.height, invertedFrom: previous }
        : { x: 0, y: 0, width: doc.width, height: doc.height };
    } else if (params.mode !== 'none') {
      const x = params.x ?? 0;
      const y = params.y ?? 0;
      const width = params.width ?? 0;
      const height = params.height ?? 0;
      if (x < 0 || y < 0 || x + width > doc.width || y + height > doc.height) {
        throw new StudioException(
          'INVALID_PARAMS',
          `Selection (${x},${y},${width}x${height}) does not fit the ${doc.width}x${doc.height} canvas.`,
        );
      }
      box = { x, y, width, height, shape: params.mode };
    }

    (doc as unknown as { selection?: Record<string, unknown> | null }).selection = box
      ? { ...box, feather: params.feather ?? 0 }
      : null;

    this.lastLatencyMs = 0;
    return { ...this.toInfo(doc), layers: doc.layers.map((l) => ({ ...l })) };
  }

  /**
   * The mock's selection is a box, so refinement is arithmetic on that box rather
   * than real marching ants. `shrink` stops at zero rather than going negative, and
   * `invert` swaps the box for the canvas, which is enough for the pipeline to
   * exercise `selectionActive` without pretending to model pixels.
   */
  async modifySelection(params: ParamsOf<'modify_selection'>): Promise<DocumentState> {
    const doc = this.active();
    const store = doc as unknown as { selection?: Record<string, unknown> | null };
    const current = store.selection ?? null;
    const amount = params.amount ?? 0;

    if (params.action === 'deselect') {
      store.selection = null;
    } else if (params.action === 'selectAll') {
      store.selection = { x: 0, y: 0, width: doc.width, height: doc.height, feather: 0 };
    } else if (params.action === 'invert') {
      store.selection = { x: 0, y: 0, width: doc.width, height: doc.height, feather: 0, inverted: true };
    } else {
      if (!current) {
        throw new StudioException(
          'INVALID_PARAMS',
          `Selection "${params.action}" needs a selection to already exist. Call set_selection first.`,
        );
      }
      const x = Number(current.x);
      const y = Number(current.y);
      const width = Number(current.width);
      const height = Number(current.height);
      if (params.action === 'grow' || params.action === 'expand') {
        store.selection = { x: x - amount, y: y - amount, width: width + amount * 2, height: height + amount * 2, feather: 0 };
      } else if (params.action === 'shrink') {
        const inset = Math.min(amount, Math.floor(Math.min(width, height) / 2));
        store.selection = { x: x + inset, y: y + inset, width: width - inset * 2, height: height - inset * 2, feather: 0 };
      } else if (params.action === 'smooth') {
        store.selection = { ...current, feather: 0, smoothed: amount };
      } else {
        store.selection = { ...current, borderWidth: amount };
      }
    }

    this.lastLatencyMs = 0;
    const selection = store.selection ?? null;
    return {
      ...this.toInfo(doc),
      layers: doc.layers.map((l) => ({ ...l })),
      selection,
      selectionActive: selection !== null,
    } as DocumentState;
  }

  async setLayerLocking(params: ParamsOf<'set_layer_locking'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    // Locking a layer is not editing it: the point is to prevent editing.
    if (params.lock === 'all') layer.isLocked = true;
    else if (params.lock === 'none') layer.isLocked = false;
    return { ...layer };
  }

  async duplicateLayers(params: ParamsOf<'duplicate_layers'>): Promise<LayerInfo> {
    const doc = this.active();
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    const copy = this.addLayer(doc, { ...layer, name: params.name ?? `${layer.name} copy` });
    // The mock's stack is a plain array, so placement is a reorder rather than a
    // DOM call. Top of the Photoshop stack is index 0.
    if (params.placement === 'placeAtBeginning') {
      const at = doc.layers.indexOf(copy);
      if (at > -1) {
        doc.layers.splice(at, 1);
        doc.layers.push(copy);
      }
    }
    return { ...copy };
  }

  async applyImage(params: ParamsOf<'apply_image'>): Promise<LayerInfo> {
    const doc = this.active();
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    // The mock has no pixels; it records what was composited so a plan can be
    // asserted on, exactly as `applyFilter` does.
    const target = layer as unknown as Record<string, unknown>;
    target.appliedImage = params.sourceName;
    target.appliedImageOptions = {
      offset: params.offset,
      scale: params.scale,
      blendMode: params.blendMode,
      opacity: params.opacity,
    };
    if (params.blendMode) layer.blendMode = params.blendMode;
    if (params.opacity !== undefined) layer.opacity = params.opacity;
    return { ...layer };
  }

  async listFonts(params: ParamsOf<'list_fonts'>): Promise<{ total: number; truncated: boolean; fonts: FontInfo[] }> {
    // Two faces of one family on purpose: it is the distinction a caller needs and
    // the reason `postScriptName` is the field to pass on.
    const fonts: FontInfo[] = [
      { name: 'Test Sans', family: 'Test Sans', style: 'Regular', postScriptName: 'TestSans-Regular' },
      { name: 'Test Sans Bold', family: 'Test Sans', style: 'Bold', postScriptName: 'TestSans-Bold' },
      { name: 'Other Grotesk', family: 'Other Grotesk', style: 'Regular', postScriptName: 'OtherGrotesk-Regular' },
    ];
    const search = params.search?.toLowerCase();
    const matched = search
      ? fonts.filter((f) => `${f.name} ${f.family} ${f.postScriptName}`.toLowerCase().includes(search))
      : fonts;
    return { total: matched.length, truncated: matched.length > params.limit, fonts: matched.slice(0, params.limit) };
  }

  async setLayerBlendMode(params: ParamsOf<'set_layer_blend_mode'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    layer.blendMode = params.mode;
    return { ...layer };
  }

  async setLayerFillOpacity(params: ParamsOf<'set_layer_fill_opacity'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    if (params.opacity < 0 || params.opacity > 100) {
      throw new StudioException('INVALID_PARAMS', `Fill opacity must be 0..100, received ${params.opacity}`);
    }
    layer.fillOpacity = params.opacity;
    return { ...layer };
  }

  async applyFilter(params: ParamsOf<'apply_filter'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    if (params.filter === 'flip' as never) throw new StudioException('UNSUPPORTED_OPERATION', 'nope');
    // The mock records the request; it does not read pixels.
    (layer as unknown as { appliedFilter?: string }).appliedFilter = params.filter;
    return { ...layer } as LayerInfo;
  }

  async flipLayer(params: ParamsOf<'flip_layer'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    if (params.direction === 'vertical') {
      const { x, width } = layer;
      layer.x = x + width;
    }
    return { ...layer };
  }

  async rotateLayer(params: ParamsOf<'rotate_layer'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    const { width, height } = layer;
    if (Math.abs(params.angle % 180) === 90) {
      layer.x += Math.round((width - height) / 2);
      layer.y += Math.round((height - width) / 2);
      layer.width = height;
      layer.height = width;
    }
    return { ...layer };
  }

  async rasterizeLayer(params: ParamsOf<'rasterize_layer'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    return { ...layer, rasterized: true } as LayerInfo;
  }

  async sampleColor(params: ParamsOf<'sample_color'>): Promise<SampleColorResult> {
    const doc = this.active();
    if (params.x < 0 || params.y < 0 || params.x >= doc.width || params.y >= doc.height) {
      throw new StudioException(
        'INVALID_PARAMS',
        `Cannot sample at (${params.x},${params.y}): the canvas is ${doc.width}x${doc.height}.`,
      );
    }
    // Deterministic stand-in for reading a pixel; the mock has no raster.
    const color = { r: (params.x * 7) % 256, g: (params.y * 5) % 256, b: 128 };
    return { color, hex: `#${[color.r, color.g, color.b].map((c) => c.toString(16).padStart(2, '0')).join('')}` };
  }

  async trimDocument(params: ParamsOf<'trim_document'>): Promise<DocumentInfo> {
    void params;
    const doc = this.active();
    const visible = doc.layers.filter((l) => l.visible);
    if (!visible.length) return this.toInfo(doc);
    const left = Math.min(...visible.map((l) => l.x));
    const top = Math.min(...visible.map((l) => l.y));
    const right = Math.max(...visible.map((l) => l.x + l.width));
    const bottom = Math.max(...visible.map((l) => l.y + l.height));
    for (const layer of visible) {
      layer.x -= left;
      layer.y -= top;
    }
    doc.width = right - left;
    doc.height = bottom - top;
    return this.toInfo(doc);
  }

  async flattenDocument(): Promise<DocumentInfo> {
    const doc = this.active();
    const visible = doc.layers.filter((l) => l.visible);
    const top = visible[visible.length - 1];
    doc.layers = visible.length ? [{ ...(top as LayerInfo), name: 'Background', isBackground: true }] : [];
    return this.toInfo(doc);
  }

  async mergeVisibleLayers(): Promise<DocumentInfo> {
    const doc = this.active();
    const visible = doc.layers.filter((l) => l.visible);
    const hidden = doc.layers.filter((l) => !l.visible);
    const top = visible[visible.length - 1];
    doc.layers = visible.length ? [{ ...(top as LayerInfo) }, ...hidden] : [];
    return this.toInfo(doc);
  }

  async convertColorMode(params: ParamsOf<'convert_color_mode'>): Promise<DocumentInfo> {
    const doc = this.active();
    doc.colorMode = params.mode;
    return this.toInfo(doc);
  }

  async setTextStyle(params: ParamsOf<'set_text_style'>): Promise<TextLayerInfo> {
    const { doc, layer } = this.resolveTextLayer(params);
    const text = doc.texts.get(layer.id);
    if (!text) throw new StudioException('NOT_A_TEXT_LAYER', `"${layer.name}" has no text content`);

    const applied: string[] = [];
    for (const key of ['tracking', 'leading', 'baselineShift', 'horizontalScale', 'verticalScale'] as const) {
      const value = params[key];
      if (typeof value === 'number') {
        (text as unknown as Record<string, unknown>)[key] = value;
        applied.push(key);
      }
    }
    for (const key of ['fauxBold', 'fauxItalic', 'underline', 'strikethrough'] as const) {
      if (typeof params[key] === 'boolean') {
        (text as unknown as Record<string, unknown>)[key] = params[key];
        applied.push(key);
      }
    }
    if (typeof params.paragraphWidth === 'number') {
      layer.width = params.paragraphWidth;
      applied.push('paragraphWidth');
    }
    return { ...this.readText(doc, layer), applied };
  }

  async getCapabilities(): Promise<CapabilitiesResult> {
    const capabilities: Record<string, { api: boolean; usable: boolean }> = {};
    for (const id of MOCK_CAPABILITIES) capabilities[id] = { api: true, usable: true };
    return {
      hostApp: 'photoshop',
      hostVersion: 'mock',
      uxpVersion: 'mock',
      capabilities,
      unsupported: [],
    };
  }

  async getDocumentInfo(): Promise<DocumentInfo> {
    const doc = this.active();
    return this.toInfo(doc);
  }

  async duplicateDocument(params: ParamsOf<'duplicate_document'>): Promise<{ id: string; name: string }> {
    const source = this.active();
    const copy = this.newDocument({
      name: params.name ?? `${stripExtension(source.name)}-copy`,
      width: source.width,
      height: source.height,
      resolution: source.resolution,
      colorMode: source.colorMode,
    });
    // Copy layers and re-attach text records to the *copies*: a duplicate gets
    // fresh layer ids, so the text must move with the layer it belongs to.
    for (const layer of source.layers) {
      const copied = this.addLayer(copy, { ...layer, id: undefined });
      const text = source.texts.get(layer.id);
      if (text && layer.type === 'text') {
        copy.texts.set(copied.id, { ...text });
      }
    }
    this.activeId = copy.id;
    return { id: copy.id, name: copy.name };
  }

  async saveDocument(params: ParamsOf<'save_document'>): Promise<SaveResult> {
    const doc = this.active();
    const target =
      doc.path && params.path === undefined
        ? doc.path
        : this.options.workspace.resolveOutput(params.path, `${stripExtension(doc.name)}.psd`);
    Workspace.assertExtension(target, ['.psd'], 'save_document');
    this.assertWritable(target, params.overwrite);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, this.serializePsd(doc));
    doc.path = target;
    if (!params.asCopy) doc.saved = true;
    return { path: target, bytes: statSync(target).size, overwritten: params.overwrite };
  }

  // --- layers --------------------------------------------------------------

  async getLayers(params: ParamsOf<'get_layers'>): Promise<LayerInfo[]> {
    const doc = this.active();
    return doc.layers
      .filter((l) => params.includeHidden || l.visible)
      .map((l) => ({ ...l }));
  }

  async getLayer(sel: LayerSelector): Promise<LayerInfo> {
    const { doc, layer } = this.resolveLayer(sel);
    void doc;
    return { ...layer };
  }

  async createLayer(params: ParamsOf<'create_layer'>): Promise<LayerInfo> {
    const doc = this.active();
    const width = params.width ?? doc.width;
    const height = params.height ?? doc.height;
    const x = params.x ?? Math.round((doc.width - width) / 2);
    const y = params.y ?? Math.round((doc.height - height) / 2);
    return this.addLayer(doc, {
      name: params.name,
      type: 'pixel',
      x,
      y,
      width,
      height,
      opacity: params.opacity,
      visible: params.visible,
    });
  }

  async deleteLayer(sel: LayerSelector): Promise<{ deletedLayerId: number }> {
    const { doc, layer } = this.resolveLayer(sel);
    this.assertMutable(layer);
    this.removeLayerTree(doc, layer.id);
    return { deletedLayerId: layer.id };
  }

  async renameLayer(sel: LayerSelector, name: string): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(sel);
    this.assertMutable(layer);
    layer.name = name;
    return { ...layer };
  }

  async moveLayer(sel: LayerSelector & { x?: number; y?: number; dx?: number; dy?: number }): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(sel);
    this.assertMutable(layer);
    if (sel.x !== undefined) layer.x = sel.x;
    else if (sel.dx !== undefined) layer.x += sel.dx;
    if (sel.y !== undefined) layer.y = sel.y;
    else if (sel.dy !== undefined) layer.y += sel.dy;
    return { ...layer };
  }

  async setLayerVisibility(sel: LayerSelector, visible: boolean): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(sel);
    this.assertMutable(layer);
    layer.visible = visible;
    return { ...layer };
  }

  async setLayerOpacity(sel: LayerSelector, opacity: number): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(sel);
    this.assertMutable(layer);
    if (opacity < 0 || opacity > 100) {
      throw new StudioException('INVALID_PARAMS', `Opacity must be 0..100, received ${opacity}`);
    }
    layer.opacity = Math.round(opacity * 10) / 10;
    return { ...layer };
  }

  async createGroup(params: ParamsOf<'create_group'>): Promise<LayerInfo> {
    const doc = this.active();
    const group = this.addLayer(doc, { name: params.name, type: 'group', x: 0, y: 0, width: 0, height: 0 });
    if (params.layer) {
      const { layer } = this.resolveLayer(params.layer);
      this.moveIntoGroup(doc, layer, group);
    }
    return { ...group };
  }

  async moveLayerToGroup(layer: LayerSelector, group: LayerSelector): Promise<LayerInfo> {
    const doc = this.active();
    const resolved = this.resolveLayer(layer);
    const target = this.resolveLayer(group).layer;
    if (target.type !== 'group') {
      throw new StudioException('LAYER_IS_GROUP', `"${target.name}" is a ${target.type} layer, not a group`);
    }
    if (this.isDescendantOf(target, resolved.layer)) {
      throw new StudioException('INVALID_PARAMS', 'Cannot move a group into one of its own children');
    }
    this.moveIntoGroup(doc, resolved.layer, target);
    return { ...resolved.layer };
  }

  async reorderLayer(params: ParamsOf<'reorder_layer'>): Promise<LayerInfo> {
    const doc = this.active();
    const { layer } = this.resolveLayer(params.layer);
    this.assertMutable(layer);
    const siblings = doc.layers.filter((l) => l.parentId === layer.parentId);
    const from = siblings.findIndex((l) => l.id === layer.id);
    siblings.splice(from, 1);

    let to: number;
    if (params.placement === 'placeAtBeginning') to = 0;
    else if (params.placement === 'placeAtEnd') to = doc.layers.length;
    else {
      const target = this.resolveLayer(params.target ?? {});
      const targetIndex = doc.layers.findIndex((l) => l.id === target.layer.id);
      if (targetIndex === -1) throw new StudioException('LAYER_NOT_FOUND', 'Target layer not found');
      to = params.placement === 'placeBefore' ? targetIndex : targetIndex + 1;
    }
    doc.layers.splice(to, 0, layer);
    return { ...layer };
  }

  // --- text ----------------------------------------------------------------

  async createTextLayer(params: ParamsOf<'create_text_layer'>): Promise<TextLayerInfo> {
    const doc = this.active();
    const width = params.width ?? estimateTextWidth(params.text, params.fontSize);
    const x = params.x ?? Math.round((doc.width - width) / 2);
    const y = params.y ?? Math.round((doc.height - params.fontSize) / 2);
    const layer = this.addText(doc, {
      name: params.name ?? firstLine(params.text),
      text: params.text,
      x,
      y,
      font: params.font ?? 'MyriadPro-Regular',
      fontSize: params.fontSize,
      color: normalizeColor(params.color),
      ...(params.alignment ? { alignment: params.alignment } : {}),
      ...(params.width !== undefined ? { width: params.width } : {}),
    });
    return this.readText(doc, layer);
  }

  async getTextLayer(sel: LayerSelector): Promise<TextLayerInfo> {
    const { doc, layer } = this.resolveTextLayer(sel);
    return this.readText(doc, layer);
  }

  async updateTextLayer(
    sel: LayerSelector,
    patch: { text?: string; font?: string; fontSize?: number; color?: RgbColor; alignment?: TextAlign },
  ): Promise<TextLayerInfo> {
    const { doc, layer } = this.resolveTextLayer(sel);
    const text = doc.texts.get(layer.id);
    if (!text) throw new StudioException('NOT_A_TEXT_LAYER', `"${layer.name}" has no text content`);
    if (patch.text !== undefined) {
      text.text = patch.text;
      layer.name = firstLine(patch.text);
      const width = estimateTextWidth(patch.text, text.fontSize);
      layer.width = width;
      if (layer.height === 0) layer.height = Math.round(text.fontSize * 1.4);
    }
    if (patch.font !== undefined) text.font = patch.font;
    if (patch.fontSize !== undefined) {
      text.fontSize = patch.fontSize;
      layer.height = Math.round(patch.fontSize * 1.4);
      layer.width = estimateTextWidth(text.text, patch.fontSize);
    }
    if (patch.color !== undefined) text.color = patch.color;
    if (patch.alignment !== undefined) text.alignment = patch.alignment;
    doc.saved = false;
    return this.readText(doc, layer);
  }

  async setTextPosition(sel: LayerSelector, x: number, y: number): Promise<TextLayerInfo> {
    const { doc, layer } = this.resolveTextLayer(sel);
    this.assertMutable(layer);
    const text = doc.texts.get(layer.id);
    if (text) {
      text.pointX = x;
      text.pointY = y;
    }
    layer.x = x;
    layer.y = y;
    return this.readText(doc, layer);
  }

  async setTextFontSize(sel: LayerSelector, fontSize: number): Promise<TextLayerInfo> {
    return this.updateTextLayer(sel, { fontSize });
  }

  async setTextColor(sel: LayerSelector, color: RgbColor): Promise<TextLayerInfo> {
    return this.updateTextLayer(sel, { color });
  }

  // --- brushes ---------------------------------------------------------------

  async listBrushes(): Promise<ListBrushesResult> {
    const brushes: BrushInfo[] = [
      { name: 'Soft Round 21', size: 21 },
      { name: 'Hard Round 19', size: 19 },
      { name: 'Soft Round 46', size: 46 },
      { name: 'Hard Round 9', size: 9 },
      { name: 'Calligraphic 20', size: 20 },
    ];
    return { brushes, currentBrush: 'Soft Round 21' };
  }

  async strokePath(params: ParamsOf<'stroke_path'>): Promise<BrushStrokeResult> {
    const doc = this.active();
    // Create a layer for the stroke
    const layer = this.addLayer(doc, {
      name: 'Brush Stroke',
      type: 'pixel',
      x: 0,
      y: 0,
      width: doc.width,
      height: doc.height,
      opacity: params.opacity,
      visible: true,
    });
    return {
      success: true,
      layerId: layer.id,
      layerName: layer.name,
      brushUsed: params.brushName || 'Soft Round 21',
      brushSize: params.brushSize,
    };
  }

  async paintStroke(params: ParamsOf<'paint_stroke'>): Promise<BrushStrokeResult> {
    const doc = this.active();
    // Create a layer for the stroke
    const layer = this.addLayer(doc, {
      name: 'Paint Stroke',
      type: 'pixel',
      x: 0,
      y: 0,
      width: doc.width,
      height: doc.height,
      opacity: params.opacity,
      visible: true,
    });
    return {
      success: true,
      layerId: layer.id,
      layerName: layer.name,
      brushUsed: params.brushName || 'Soft Round 21',
      brushSize: params.brushSize,
    };
  }

  // --- images --------------------------------------------------------------

  async placeImage(params: ParamsOf<'place_image'>): Promise<LayerInfo> {
    const doc = this.active();
    // `resolveInput`, not `resolvePath` with a default dir: a planner writes
    // `assets/logo.png` (workspace-relative) and joining that onto the assets
    // directory again would look for `assets/assets/logo.png`. The UXP adapter
    // resolves the same way, and the mock must not diverge from it.
    const path = this.options.workspace.resolveInput(params.path, 'input.png', 'assets');
    Workspace.assertExtension(path, ['.png', '.jpg', '.jpeg', '.webp', '.psd', '.tif', '.tiff', '.gif'], 'place_image');
    if (!existsSync(path)) {
      throw new StudioException('FILE_NOT_FOUND', `Image not found inside the workspace: ${path}`);
    }
    const { width, height } = readPngSize(path) ?? { width: 400, height: 400 };
    let targetWidth = width;
    let targetHeight = height;
    if (params.fit) {
      if (params.fit.width && params.fit.height) {
        targetWidth = params.fit.width;
        targetHeight = params.fit.height;
      } else if (params.fit.width) {
        targetWidth = params.fit.width;
        targetHeight = Math.round((height / width) * targetWidth);
      } else if (params.fit.height) {
        targetHeight = params.fit.height;
        targetWidth = Math.round((width / height) * targetHeight);
      }
    }
    const x = params.fit?.anchor ? anchorOffset(doc.width, targetWidth, params.fit.anchor, 'x') : Math.round((doc.width - targetWidth) / 2);
    const y = params.fit?.anchor ? anchorOffset(doc.height, targetHeight, params.fit.anchor, 'y') : Math.round((doc.height - targetHeight) / 2);
    return this.addLayer(doc, { name: params.name ?? basename(path), type: 'smartObject', x, y, width: targetWidth, height: targetHeight });
  }

  async resizeLayer(params: ParamsOf<'resize_layer'>): Promise<LayerInfo> {
    const { layer } = this.resolveLayer(params);
    this.assertMutable(layer);
    const scale = params.scale ?? (params.width !== undefined ? params.width / Math.max(1, layer.width) : params.height !== undefined ? params.height / Math.max(1, layer.height) : 1);
    const width = Math.max(1, Math.round(layer.width * scale));
    const height = Math.max(1, Math.round(layer.height * scale));
    const dx = Math.round((layer.width - width) / 2);
    const dy = Math.round((layer.height - height) / 2);
    const anchorOffsetX = params.anchor.endsWith('Left') ? 0 : params.anchor.startsWith('right') || params.anchor.endsWith('Right') ? layer.width - width : dx;
    const anchorOffsetY = params.anchor.startsWith('top') ? 0 : params.anchor.startsWith('bottom') ? layer.height - height : dy;
    layer.x += anchorOffsetX;
    layer.y += anchorOffsetY;
    layer.width = width;
    layer.height = height;
    const doc = this.active();
    doc.saved = false;
    return { ...layer };
  }

  // --- canvas --------------------------------------------------------------

  async resizeCanvas(params: ParamsOf<'resize_canvas'>): Promise<DocumentInfo> {
    const doc = this.active();
    doc.width = params.width;
    doc.height = params.height;
    doc.saved = false;
    return this.toInfo(doc);
  }

  async cropDocument(params: ParamsOf<'crop_document'>): Promise<DocumentInfo> {
    const doc = this.active();
    if (params.x + params.width > doc.width || params.y + params.height > doc.height) {
      throw new StudioException(
        'INVALID_PARAMS',
        `Crop rect (${params.x},${params.y},${params.width}×${params.height}) exceeds the ${doc.width}×${doc.height} canvas`,
      );
    }
    doc.width = params.width;
    doc.height = params.height;
    for (const layer of doc.layers) {
      layer.x -= params.x;
      layer.y -= params.y;
    }
    doc.saved = false;
    return this.toInfo(doc);
  }

  // --- export --------------------------------------------------------------

  async exportDocument(params: ParamsOf<'export_document'>): Promise<ExportResult> {
    const doc = this.active();
    const ext = params.format === 'jpg' ? '.jpg' : params.format === 'psd' ? '.psd' : '.png';
    const path = this.options.workspace.resolveOutput(params.path, `${stripExtension(doc.name)}${ext}`);
    switch (params.format) {
      case 'png':
        return this.exportPng({ ...params, path, compression: params.compression ?? 6 });
      case 'jpg':
        return this.exportJpg({ ...params, path, quality: params.quality ?? 9 });
      case 'psd':
        return this.savePsd({ ...params, path, asCopy: true });
    }
  }

  async exportPng(params: ParamsOf<'export_png'>): Promise<ExportResult> {
    const doc = this.active();
    const path = this.options.workspace.resolveOutput(params.path, `${stripExtension(doc.name)}.png`);
    Workspace.assertExtension(path, ['.png'], 'export_png');
    this.assertWritable(path, params.overwrite);
    const scale = params.maxWidth && params.maxWidth < doc.width ? params.maxWidth / doc.width : 1;
    const width = Math.max(1, Math.round(doc.width * scale));
    const height = Math.max(1, Math.round(doc.height * scale));
    mkdirSync(dirname(path), { recursive: true });
    const png = createSolidPng(width, height, { r: 32, g: 34, b: 40 }, doc.layers.filter((l) => l.visible).map((l) => ({ ...l, scale })));
    writeFileSync(path, png);
    return { path, format: 'png', bytes: png.byteLength, overwritten: params.overwrite };
  }

  async exportJpg(params: ParamsOf<'export_jpg'>): Promise<ExportResult> {
    const doc = this.active();
    const path = this.options.workspace.resolveOutput(params.path, `${stripExtension(doc.name)}.jpg`);
    Workspace.assertExtension(path, ['.jpg', '.jpeg'], 'export_jpg');
    this.assertWritable(path, params.overwrite);
    mkdirSync(dirname(path), { recursive: true });
    // The mock has no JPEG encoder. It writes a real file with a real size so
    // downstream existence/size checks behave, and says so in the header.
    const stub = Buffer.from(
      `Photoshop AI Studio mock JPEG placeholder\ndocument=${doc.name}\nquality=${params.quality ?? 9}\n`,
      'utf8',
    );
    writeFileSync(path, stub);
    return { path, format: 'jpg', bytes: stub.byteLength, overwritten: params.overwrite };
  }

  async savePsd(params: ParamsOf<'save_psd'>): Promise<ExportResult> {
    const doc = this.active();
    const path = this.options.workspace.resolveOutput(params.path, `${stripExtension(doc.name)}.psd`);
    Workspace.assertExtension(path, ['.psd'], 'save_psd');
    this.assertWritable(path, params.overwrite);
    mkdirSync(dirname(path), { recursive: true });
    const buffer = this.serializePsd(doc);
    writeFileSync(path, buffer);
    if (!params.asCopy) {
      doc.path = path;
      doc.saved = true;
    }
    return { path, format: 'psd', bytes: buffer.byteLength, overwritten: params.overwrite };
  }

  // --- preview -------------------------------------------------------------

  async renderPreview(params: ParamsOf<'render_preview'>): Promise<PreviewResult> {
    const doc = this.active();
    const scale = Math.min(1, params.maxWidth / Math.max(1, doc.width));
    const width = Math.max(1, Math.round(doc.width * scale));
    const height = Math.max(1, Math.round(doc.height * scale));
    const png = createSolidPng(width, height, { r: 32, g: 34, b: 40 }, doc.layers.filter((l) => l.visible).map((l) => ({ ...l, scale })));
    return { mimeType: 'image/png', base64: png.toString('base64'), width, height };
  }

  // --- internals -----------------------------------------------------------

  private newDocument(init: Partial<MockDocument> & { name: string; width: number; height: number }): MockDocument {
    const doc: MockDocument = {
      id: randomUUID(),
      name: init.name,
      width: init.width,
      height: init.height,
      resolution: init.resolution ?? 72,
      colorMode: init.colorMode ?? 'RGB',
      layers: [],
      texts: new Map(),
      path: init.path ?? null,
      saved: false,
      nextLayerId: 1,
    };
    this.documents.set(doc.id, doc);
    return doc;
  }

  private addLayer(
    doc: MockDocument,
    spec: Partial<LayerInfo> & { name: string; type: LayerInfo['type']; x: number; y: number; width: number; height: number },
  ): LayerInfo {
    const layer: LayerInfo = {
      id: spec.id ?? doc.nextLayerId++,
      name: spec.name,
      type: spec.type,
      visible: spec.visible ?? true,
      opacity: spec.opacity ?? 100,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      parentId: spec.parentId ?? null,
      ...(spec.fillOpacity !== undefined ? { fillOpacity: spec.fillOpacity } : {}),
      blendMode: spec.blendMode ?? 'normal',
      ...(spec.isBackground !== undefined ? { isBackground: spec.isBackground } : {}),
      ...(spec.isClippingMask !== undefined ? { isClippingMask: spec.isClippingMask } : {}),
      ...(spec.isLocked !== undefined ? { isLocked: spec.isLocked } : {}),
      ...(spec.type === 'text' ? { hasText: true } : {}),
    };
    if (layer.id >= doc.nextLayerId) doc.nextLayerId = layer.id + 1;
    doc.layers.push(layer);
    doc.saved = false;
    return layer;
  }

  private addText(
    doc: MockDocument,
    spec: { name: string; text: string; x: number; y: number; font?: string; fontSize: number; color?: RgbColor; alignment?: TextAlign; width?: number },
  ): LayerInfo {
    const fontSize = spec.fontSize;
    const width = spec.width ?? estimateTextWidth(spec.text, fontSize);
    const layer = this.addLayer(doc, {
      name: spec.name,
      type: 'text',
      x: spec.x,
      y: spec.y,
      width,
      height: Math.round(fontSize * 1.4),
    });
    doc.texts.set(layer.id, {
      text: spec.text,
      font: spec.font ?? 'MyriadPro-Regular',
      fontSize,
      color: spec.color ?? { r: 17, g: 17, b: 17 },
      ...(spec.alignment ? { alignment: spec.alignment } : {}),
      pointX: spec.x,
      pointY: spec.y,
    });
    return layer;
  }

  private active(): MockDocument {
    if (!this.connected) {
      throw new StudioException('NOT_CONNECTED', 'Mock adapter is marked as disconnected');
    }
    const doc = this.activeId ? this.documents.get(this.activeId) : undefined;
    if (!doc) throw new StudioException('NO_DOCUMENT_OPEN', 'No document is open in Photoshop');
    return doc;
  }

  private toInfo(doc: MockDocument): DocumentInfo {
    return {
      id: doc.id,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
      colorMode: doc.colorMode,
      layerCount: doc.layers.length,
      path: doc.path,
      saved: doc.saved,
      active: this.activeId === doc.id,
      colorProfile: 'sRGB IEC61966-2.1',
      bitsPerChannel: 8,
      pixelAspectRatio: 1,
      zoom: 1,
    };
  }

  private resolveLayer(sel: LayerSelector): { doc: MockDocument; layer: LayerInfo } {
    const doc = this.active();
    if (sel.layerId !== undefined) {
      const layer = doc.layers.find((l) => l.id === sel.layerId);
      if (!layer) throw new StudioException('LAYER_NOT_FOUND', `Layer id ${sel.layerId} was not found`, { details: { layerId: sel.layerId } });
      return { doc, layer };
    }
    if (sel.layerName !== undefined) {
      const matches = doc.layers.filter((l) => l.name === sel.layerName);
      if (matches.length === 0) {
        throw new StudioException('LAYER_NOT_FOUND', `Layer "${sel.layerName}" was not found`, {
          details: { layerName: sel.layerName, available: doc.layers.map((l) => l.name) },
        });
      }
      if (matches.length > 1) {
        throw new StudioException('INVALID_PARAMS', `Layer name "${sel.layerName}" is ambiguous (${matches.length} matches); use layerId`, {
          details: { layerName: sel.layerName, layerIds: matches.map((l) => l.id) },
        });
      }
      return { doc, layer: matches[0]! };
    }
    throw new StudioException('INVALID_PARAMS', 'Provide exactly one of layerId or layerName');
  }

  private resolveTextLayer(sel: LayerSelector): { doc: MockDocument; layer: LayerInfo } {
    const { doc, layer } = this.resolveLayer(sel);
    if (layer.type !== 'text') {
      throw new StudioException('NOT_A_TEXT_LAYER', `Layer "${layer.name}" is a ${layer.type} layer, not text`, {
        details: { layerId: layer.id, type: layer.type },
      });
    }
    return { doc, layer };
  }

  private assertMutable(layer: LayerInfo): void {
    if (layer.isLocked) {
      throw new StudioException('LAYER_LOCKED', `Layer "${layer.name}" is locked`, { details: { layerId: layer.id } });
    }
  }

  private removeLayerTree(doc: MockDocument, rootId: number): void {
    const ids = new Set<number>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const layer of doc.layers) {
        if (layer.parentId !== null && ids.has(layer.parentId) && !ids.has(layer.id)) {
          ids.add(layer.id);
          grew = true;
        }
      }
    }
    doc.layers = doc.layers.filter((l) => !ids.has(l.id));
    for (const id of ids) doc.texts.delete(id);
    doc.saved = false;
  }

  private moveIntoGroup(doc: MockDocument, layer: LayerInfo, group: LayerInfo): void {
    layer.parentId = group.id;
    const index = doc.layers.findIndex((l) => l.id === layer.id);
    const [moved] = doc.layers.splice(index, 1);
    if (moved) {
      const lastChild = lastIndexOfChild(doc, group.id);
      doc.layers.splice(lastChild + 1, 0, moved);
    }
    doc.saved = false;
  }

  private isDescendantOf(candidate: LayerInfo, ancestor: LayerInfo): boolean {
    let current: LayerInfo | undefined = candidate;
    while (current?.parentId !== null && current?.parentId !== undefined) {
      if (current.parentId === ancestor.id) return true;
      current = doc_unsafe(this.documents, current.parentId);
    }
    return false;
  }

  private assertWritable(path: string, overwrite: boolean): void {
    if (!this.options.workspace.contains(path)) {
      throw new StudioException('PATH_NOT_ALLOWED', `"${path}" is outside the workspace`);
    }
    if (existsSync(path) && !overwrite) {
      throw new StudioException('FILE_EXISTS', `"${path}" already exists. Set overwrite=true to replace it.`, {
        details: { path },
      });
    }
  }

  private readText(doc: MockDocument, layer: LayerInfo): TextLayerInfo {
    const text = doc.texts.get(layer.id);
    if (!text) throw new StudioException('NOT_A_TEXT_LAYER', `"${layer.name}" has no text content`);
    return {
      layerId: layer.id,
      name: layer.name,
      text: text.text,
      font: text.font,
      fontSize: text.fontSize,
      color: text.color,
      ...(text.alignment ? { alignment: text.alignment } : {}),
      ...(text.pointX !== 0 || layer.type === 'text' ? { x: text.pointX, y: text.pointY } : {}),
      width: layer.width,
      height: layer.height,
    };
  }

  /** A minimal, honest PSD stand-in: JSON describing the document, not a real PSD. */
  private serializePsd(doc: MockDocument): Buffer {
    return Buffer.from(
      JSON.stringify(
        {
          mock: true,
          note: 'Produced by MockPhotoshopAdapter — not a real PSD binary.',
          document: this.toInfo(doc),
          layers: doc.layers,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}

function doc_unsafe(documents: Map<string, MockDocument>, id: number): LayerInfo | undefined {
  for (const doc of documents.values()) {
    const found = doc.layers.find((l) => l.id === id);
    if (found) return found;
  }
  return undefined;
}

function lastIndexOfChild(doc: MockDocument, parentId: number): number {
  let last = -1;
  for (let i = 0; i < doc.layers.length; i += 1) {
    if (doc.layers[i]?.parentId === parentId) last = i;
  }
  return last;
}

function anchorOffset(canvas: number, size: number, anchor: Anchor, axis: 'x' | 'y'): number {
  const horizontal = axis === 'x';
  const endsRight = anchor.endsWith('Right');
  const endsLeft = anchor.endsWith('Left');
  if (horizontal) {
    if (endsLeft) return 0;
    if (endsRight) return canvas - size;
    return Math.round((canvas - size) / 2);
  }
  if (anchor.startsWith('top')) return 0;
  if (anchor.startsWith('bottom')) return canvas - size;
  return Math.round((canvas - size) / 2);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** Crude but deterministic text metrics: ~0.5em average advance, 1.4em line height. */
function estimateTextWidth(text: string, fontSize: number): number {
  return Math.max(1, Math.round(text.length * fontSize * 0.5));
}

function readPngSize(path: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(path);
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ---------------------------------------------------------------------------
// tiny PNG encoder — enough to make previews and PNG exports real files
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Solid background with faint horizontal bands where visible layers sit. */
function createSolidPng(
  width: number,
  height: number,
  background: RgbColor,
  layers: ReadonlyArray<LayerInfo & { scale: number }>,
): Buffer {
  const bands = layers
    .filter((l) => l.width > 0 && l.height > 0)
    .map((l) => ({
      y0: Math.max(0, Math.min(height - 1, Math.round(l.y * l.scale))),
      y1: Math.max(0, Math.min(height, Math.round((l.y + l.height) * l.scale))),
      x0: Math.max(0, Math.min(width - 1, Math.round(l.x * l.scale))),
      x1: Math.max(0, Math.min(width, Math.round((l.x + l.width) * l.scale))),
      shade: 40 + ((l.id * 37) % 150),
      alpha: Math.round((l.opacity / 100) * 0.55 * 255),
    }));

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      let r = background.r;
      let g = background.g;
      let b = background.b;
      for (const band of bands) {
        if (y >= band.y0 && y < band.y1 && x >= band.x0 && x < band.x1) {
          const a = band.alpha / 255;
          r = Math.round(r * (1 - a) + band.shade * a);
          g = Math.round(g * (1 - a) + band.shade * a);
          b = Math.round(b * (1 - a) + (band.shade + 20) * a);
        }
      }
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
