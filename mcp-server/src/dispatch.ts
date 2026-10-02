import {
  StudioException,
  normalizeColor,
  type ParamsOf,
  type PhotoshopAdapter,
  type PhotoshopOpName,
  type ResultOf,
  type OPERATIONS,
} from '@photoshop-ai-studio/shared';

/**
 * The op → adapter-method table.
 *
 * A mapped type over `PhotoshopOpName`, so adding an entry to the shared
 * operation registry without adding a handler here is a compile error, and a
 * handler whose parameter types drift from the registry is a compile error too.
 * The result is the complete, checked implementation of the MCP tool surface.
 */
/**
 * Operation names that form the advertised tool surface.
 *
 * Diagnostics are excluded for the same reason they are kept out of
 * `TOOL_META`: they answer a question about one host and are never something a
 * caller should be planning with, so no adapter is obliged to implement them.
 */
export type PublicOpName = {
  [K in PhotoshopOpName]: (typeof OPERATIONS)[K] extends { diagnostic: true } ? never : K;
}[PhotoshopOpName];

export type OpDispatcher = {
  [K in PublicOpName]: (adapter: PhotoshopAdapter, params: ParamsOf<K>) => Promise<ResultOf<K>>;
};

export const DISPATCH: OpDispatcher = {
  // --- document ------------------------------------------------------------
  get_document: (a) => a.getDocument(),
  get_document_info: (a) => a.getDocumentInfo(),
  get_capabilities: (a) => a.getCapabilities(),
  set_selection: (a, p) => a.setSelection(p),
  set_layer_blend_mode: (a, p) => a.setLayerBlendMode(p),
  set_layer_fill_opacity: (a, p) => a.setLayerFillOpacity(p),
  set_layer_locking: (a, p) => a.setLayerLocking(p),
  duplicate_layers: (a, p) => a.duplicateLayers(p),
  apply_image: (a, p) => a.applyImage(p),
  modify_selection: (a, p) => a.modifySelection(p),
  list_fonts: (a, p) => a.listFonts(p),
  set_text_style: (a, p) => a.setTextStyle(p),
  apply_filter: (a, p) => a.applyFilter(p as never),
  flip_layer: (a, p) => a.flipLayer(p as never),
  rotate_layer: (a, p) => a.rotateLayer(p as never),
  rasterize_layer: (a, p) => a.rasterizeLayer(p as never),
  sample_color: (a, p) => a.sampleColor(p as never),
  trim_document: (a, p) => a.trimDocument(p as never),
  flatten_document: (a, p) => a.flattenDocument(p as never),
  merge_visible_layers: (a, p) => a.mergeVisibleLayers(p as never),
  convert_color_mode: (a, p) => a.convertColorMode(p as never),
  create_document: (a, p) => a.createDocument(p),
  get_documents: (a) => a.getDocuments(),
  close_document: (a, p) => a.closeDocument(p),
  duplicate_document: (a, p) => a.duplicateDocument(p),
  save_document: (a, p) => a.saveDocument(p),

  // --- layers --------------------------------------------------------------
  get_layers: (a, p) => a.getLayers(p),
  get_layer: (a, p) => a.getLayer(p),
  create_layer: (a, p) => a.createLayer(p),
  delete_layer: (a, p) => a.deleteLayer(p),
  rename_layer: (a, p) => a.renameLayer(p, p.name),
  move_layer: (a, p) =>
    a.moveLayer(p, { x: p.x, y: p.y, dx: p.dx, dy: p.dy }),
  set_layer_visibility: (a, p) => a.setLayerVisibility(p, p.visible),
  set_layer_opacity: (a, p) => a.setLayerOpacity(p, p.opacity),
  create_group: (a, p) => a.createGroup(p),
  move_layer_to_group: (a, p) => a.moveLayerToGroup(p.layer, p.group),
  reorder_layer: (a, p) => a.reorderLayer(p),

  // --- text ----------------------------------------------------------------
  create_text_layer: (a, p) => a.createTextLayer({ ...p, color: normalizeColor(p.color) }),
  get_text_layer: (a, p) => a.getTextLayer(p),
  update_text_layer: (a, p) =>
    a.updateTextLayer(p, {
      text: p.text,
      font: p.font,
      fontSize: p.fontSize,
      ...(p.color !== undefined ? { color: normalizeColor(p.color) } : {}),
      ...(p.alignment !== undefined ? { alignment: p.alignment } : {}),
    }),
  set_text_position: (a, p) => a.setTextPosition(p, p.x, p.y),
  set_text_font_size: (a, p) => a.setTextFontSize(p, p.fontSize),
  set_text_color: (a, p) => a.setTextColor(p, normalizeColor(p.color)),

  // --- brushes -------------------------------------------------------------
  list_brushes: (a, p) => a.listBrushes(p),
  stroke_path: (a, p) => a.strokePath(p),
  paint_stroke: (a, p) => a.paintStroke(p),

  // --- images --------------------------------------------------------------
  place_image: (a, p) => a.placeImage(p),
  resize_layer: (a, p) => a.resizeLayer(p),

  // --- canvas --------------------------------------------------------------
  resize_canvas: (a, p) => a.resizeCanvas(p),
  crop_document: (a, p) => a.cropDocument(p),

  // --- export --------------------------------------------------------------
  export_document: (a, p) => a.exportDocument(p),
  export_png: (a, p) => a.exportPng(p),
  export_jpg: (a, p) => a.exportJpg(p),
  save_psd: (a, p) => a.savePsd(p),

  // --- preview -------------------------------------------------------------
  render_preview: (a, p) => a.renderPreview(p),
};

/**
 * Looks a handler up, failing loudly when there is none.
 *
 * Diagnostics have no entry on purpose — they need a real Photoshop to answer
 * anything — so reaching one here means it was routed somewhere it cannot run,
 * and saying so beats a `TypeError` from indexing `undefined`.
 */
export function handlerFor(
  op: PhotoshopOpName,
): (adapter: PhotoshopAdapter, params: never) => Promise<unknown> {
  const handler = (DISPATCH as unknown as Record<string, ((adapter: PhotoshopAdapter, params: never) => Promise<unknown>) | undefined>)[op];
  if (!handler) {
    throw new StudioException(
      'UNSUPPORTED_OPERATION',
      `"${op}" is a host diagnostic and can only run against the Photoshop plugin.`,
      { recoverable: false },
    );
  }
  return handler;
}

/**
 * Runs a diagnostic against an adapter that can reach a real host.
 *
 * Refuses loudly otherwise: a mock that answered a probe with invented pixel
 * values would be worse than no answer, because the whole purpose of the probe
 * is finding out what Photoshop actually does.
 */
export async function diagnosticOrRefuse(
  adapter: PhotoshopAdapter,
  op: PhotoshopOpName,
  params: unknown,
): Promise<unknown> {
  if (typeof adapter.diagnostic !== 'function') {
    throw new StudioException(
      'UNSUPPORTED_OPERATION',
      `"${op}" needs a real Photoshop: the ${adapter.target} backend cannot answer a host diagnostic.`,
      { recoverable: false },
    );
  }
  return adapter.diagnostic(op, params);
}

export async function callAdapter<K extends PhotoshopOpName>(
  adapter: PhotoshopAdapter,
  op: K,
  params: ParamsOf<K>,
): Promise<ResultOf<K>> {
  return handlerFor(op)(adapter, params as never) as Promise<ResultOf<K>>;
}
