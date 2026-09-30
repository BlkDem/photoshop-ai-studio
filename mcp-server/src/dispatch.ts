import { normalizeColor, type ParamsOf, type PhotoshopAdapter, type PhotoshopOpName, type ResultOf } from '@photoshop-ai-studio/shared';

/**
 * The op → adapter-method table.
 *
 * A mapped type over `PhotoshopOpName`, so adding an entry to the shared
 * operation registry without adding a handler here is a compile error, and a
 * handler whose parameter types drift from the registry is a compile error too.
 * The result is the complete, checked implementation of the MCP tool surface.
 */
export type OpDispatcher = {
  [K in PhotoshopOpName]: (adapter: PhotoshopAdapter, params: ParamsOf<K>) => Promise<ResultOf<K>>;
};

export const DISPATCH: OpDispatcher = {
  // --- document ------------------------------------------------------------
  get_document: (a) => a.getDocument(),
  get_document_info: (a) => a.getDocumentInfo(),
  get_capabilities: (a) => a.getCapabilities(),
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

export async function callAdapter<K extends PhotoshopOpName>(
  adapter: PhotoshopAdapter,
  op: K,
  params: ParamsOf<K>,
): Promise<ResultOf<K>> {
  return DISPATCH[op](adapter, params) as Promise<ResultOf<K>>;
}
