/**
 * `PhotoshopAdapter` implementation, inside Photoshop.
 *
 * This is the counterpart of `PhotoshopAdapter` in `shared/src/photoshop/adapter.ts`
 * and the only component allowed to call `batchPlay`. It is a plain
 * op-name → function table plus the modal-scope wrapper, so the operation files
 * above never deal with modal bookkeeping or error envelopes.
 *
 * The op names match `shared`'s `PhotoshopOpName` union exactly. The MCP server
 * sends `{ op, params }` and this table resolves it; an unknown op is reported as
 * `UNSUPPORTED_OPERATION` rather than silently ignored.
 */
'use strict';

var ps = require('./ps.js');
var errors = require('./errors.js');
var Logger = require('./logger.js').Logger;

var canvasOps = require('./ops/canvas.js');
var layerOps = require('./ops/layers.js');
var textOps = require('./ops/text.js');
var imageOps = require('./ops/images.js');
var capabilityOps = require('./ops/capabilities.js');

/** op name → (ctx) => Promise<result>. `ctx` is {params, config, documentId}. */
var OPERATIONS = {
  // document
  get_document: canvasOps.get_document,
  get_document_info: canvasOps.get_document_info,
  get_capabilities: capabilityOps.get_capabilities,
  set_selection: canvasOps.set_selection,
  create_document: canvasOps.create_document,
  get_documents: canvasOps.get_documents,
  close_document: canvasOps.close_document,
  duplicate_document: canvasOps.duplicate_document,
  save_document: imageOps.save_document,

  // layers
  get_layers: layerOps.get_layers,
  get_layer: layerOps.get_layer,
  create_layer: layerOps.create_layer,
  delete_layer: layerOps.delete_layer,
  rename_layer: layerOps.rename_layer,
  move_layer: layerOps.move_layer,
  set_layer_visibility: layerOps.set_layer_visibility,
  set_layer_opacity: layerOps.set_layer_opacity,
  set_layer_blend_mode: layerOps.set_layer_blend_mode,
  set_layer_fill_opacity: layerOps.set_layer_fill_opacity,
  create_group: layerOps.create_group,
  move_layer_to_group: layerOps.move_layer_to_group,
  reorder_layer: layerOps.reorder_layer,

  // text
  create_text_layer: textOps.create_text_layer,
  get_text_layer: textOps.get_text_layer,
  update_text_layer: textOps.update_text_layer,
  set_text_position: textOps.set_text_position,
  set_text_style: textOps.set_text_style,
  set_text_font_size: textOps.set_text_font_size,
  set_text_color: textOps.set_text_color,

  // images
  place_image: imageOps.place_image,
  resize_layer: imageOps.resize_layer,

  // canvas
  resize_canvas: canvasOps.resize_canvas,
  crop_document: canvasOps.crop_document,

  // export
  export_document: imageOps.export_document,
  export_png: imageOps.export_png,
  export_jpg: imageOps.export_jpg,
  save_psd: imageOps.save_psd,

  // preview
  render_preview: imageOps.render_preview,
};

/**
 * Read-only operations do not need a modal scope, so they can answer while the
 * user is dragging a slider. Everything else does.
 */
var READ_ONLY = {
  get_document: true,
  get_document_info: true,
  get_layers: true,
  get_layer: true,
  get_text_layer: true,
};

var SUPPORTED = Object.keys(OPERATIONS);

/**
 * Executes one bridge operation and returns the wire envelope.
 *
 * Never throws: the caller (`bridge.js`) sends whatever comes back, and a thrown
 * exception here would surface as a socket-level fault instead of a typed error
 * the AI can reason about.
 */
function execute(op, params, config) {
  var handler = OPERATIONS[op];
  if (!handler) {
    return Promise.resolve(
      errors.fail('UNSUPPORTED_OPERATION', 'This plugin build does not implement "' + op + '".', {
        details: { op: op, supported: SUPPORTED },
      }),
    );
  }

  var context = {
    params: normalizeParams(op, params),
    config: config,
  };

  var work;
  try {
    if (READ_ONLY[op]) {
      work = Promise.resolve(handler(context));
    } else {
      work = ps.asModal(commandNameFor(op), function () {
        return handler(context);
      });
    }
  } catch (err) {
    return Promise.resolve({ success: false, error: errors.toWireError(err) });
  }

  return work.then(
    function (data) {
      return { success: true, data: data };
    },
    function (err) {
      var wire = errors.toWireError(err);
      Logger.warn('operation failed: ' + op + ' → ' + wire.code, { op: op, error: wire });
      return { success: false, error: wire };
    },
  );
}

/**
 * Defaults for parameters the MCP server's zod schema already validated.
 *
 * The plugin re-applies only the ones it relies on, so a caller that skips the
 * MCP server (the Inspector, a future second client) still gets sane behaviour.
 */
function normalizeParams(op, params) {
  var p = params && typeof params === 'object' ? params : {};
  if (p.documentId === undefined) p.documentId = 'active';

  if (op === 'resize_canvas' || op === 'crop_document' || op === 'place_image' || op === 'export_png') {
    if (p.anchor === undefined && op !== 'place_image') p.anchor = 'center';
  }
  if (op === 'resize_layer') {
    if (p.anchor === undefined) p.anchor = 'center';
    if (p.resample === undefined) p.resample = 'bicubic';
  }
  if ((op === 'export_png' || op === 'export_jpg' || op === 'save_psd') && p.overwrite === undefined) {
    p.overwrite = false;
  }
  if (op === 'export_png' && p.compression === undefined) p.compression = 6;
  if (op === 'export_jpg' && p.quality === undefined) p.quality = 9;
  if (op === 'save_psd' && p.asCopy === undefined) p.asCopy = true;
  if (op === 'render_preview' && p.maxWidth === undefined) p.maxWidth = 480;
  if (op === 'get_layers' && p.includeHidden === undefined) p.includeHidden = true;
  return p;
}

/** Photoshop shows this string in the progress bar / history entry. */
function commandNameFor(op) {
  var names = {
    get_document: 'Read document',
    get_document_info: 'Read document info',
    get_capabilities: 'Read capabilities',
    set_selection: 'Set selection',
    create_document: 'Create document',
    get_documents: 'Read documents',
    close_document: 'Close document',
    duplicate_document: 'Duplicate document',
    save_document: 'Save document',
    get_layers: 'Read layers',
    get_layer: 'Read layer',
    create_layer: 'Create layer',
    delete_layer: 'Delete layer',
    rename_layer: 'Rename layer',
    move_layer: 'Move layer',
    set_layer_visibility: 'Set layer visibility',
    set_layer_opacity: 'Set layer opacity',
    set_layer_blend_mode: 'Set blend mode',
    set_layer_fill_opacity: 'Set fill opacity',
    create_group: 'Create group',
    move_layer_to_group: 'Move layer to group',
    reorder_layer: 'Reorder layer',
    create_text_layer: 'Create text layer',
    get_text_layer: 'Read text layer',
    update_text_layer: 'Update text layer',
    set_text_position: 'Set text position',
    set_text_style: 'Set text style',
    set_text_font_size: 'Set font size',
    set_text_color: 'Set text colour',
    place_image: 'Place image',
    resize_layer: 'Resize layer',
    resize_canvas: 'Resize canvas',
    crop_document: 'Crop document',
    export_document: 'Export document',
    export_png: 'Export PNG',
    export_jpg: 'Export JPEG',
    save_psd: 'Save PSD',
    render_preview: 'Render preview',
  };
  return 'AI Studio: ' + (names[op] || op);
}

module.exports = {
  execute: execute,
  OPERATIONS: OPERATIONS,
  SUPPORTED: SUPPORTED,
  READ_ONLY: READ_ONLY,
};
