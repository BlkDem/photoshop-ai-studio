/**
 * `get_capabilities` — what this Photoshop build will actually let us do.
 *
 * The plugin had no way to answer that, and guessing is what produced most of the
 * bugs in this codebase: `Layer.translate` exists and does nothing, `Folder
 * .getEntry().read` does not exist, `placeEvent` refuses every file the plugin can
 * write, `crop` is refused outright, and `{_ref: 'textLayer'}` opens a modal
 * dialog. Every one of those looks fine in an API reference.
 *
 * So the report is split in two on purpose:
 *
 *  - `api`    the entry point is present, read from the live DOM.
 *  - `usable` the plugin has performed it against this build and watched it
 *             change something. This is a record, not a guess: an entry only
 *             becomes usable after the operation has been proven on device.
 *
 * Nothing here touches the document. Behaviour that cannot be checked without
 * mutating someone's artwork is verified during development and recorded below,
 * rather than being probed on the user's file.
 */
'use strict';

var ps = require('../ps.js');
var photoshop = require('photoshop');
var uxp = require('uxp');

/**
 * Capabilities proven to work on this build.
 *
 * Extend this when an operation has actually been exercised end to end — the
 * sweep in `scripts/sweep-mcp.ps1` is the thing to run first. Do not add an entry
 * because the API exists: that is the trap this file exists to make visible.
 */
var VERIFIED = [
  'document.read',
  'document.duplicate',
  'document.save',
  'document.resize_canvas',
  'document.export_png',
  'document.export_jpg',
  'document.export_psd',
  'document.preview',
  'layer.list',
  'layer.create',
  'layer.delete',
  'layer.rename',
  'layer.visibility',
  'layer.opacity',
  'layer.group',
  'layer.reorder',
  'layer.move',
  'layer.scale',
  'image.place',
  'text.create',
  'text.read',
  'text.update',
  'text.position',
  'text.font_size',
  'text.color',
  'text.style',
  'layer.blend_mode',
  'layer.fill_opacity',
  'document.new',
  'document.close',
  'document.list',
  'document.crop',
  'canvas.selection',
  'image.filter',
  'layer.flip',
  'layer.rotate',
  'document.sample_color',
];

/**
 * Capabilities the DOM does not expose at all.
 *
 * These are not failures — they are simply not reachable through the object
 * model, so any implementation has to go through `batchPlay`, which is a
 * different mechanism with its own risk (a wrong descriptor is refused silently).
 * They are kept separate from `UNSUPPORTED` so nobody reads "the DOM does not
 * have it" as "Photoshop cannot do it".
 */
var NOT_ON_DOM = {
  'document.rename': 'Assignable on some builds; on 26.11 `Document.name` has only a getter.',
  'layer.mask': 'Not on the DOM; a mask has to be created with a `make` descriptor.',
  'layer.mask_remove': 'Not on the DOM.',
  'layer.smart_object': 'Not on the DOM; `convertToSmartObject` has to go through batchPlay.',
  'layer.pixels': 'Not on the DOM on this build.',
  'layer.flip': 'Not on the DOM.',
  'adjustment.layer': 'Not on the DOM; an adjustment layer needs a `makeAdjustmentLayer` descriptor.',
  'text.leading': 'Not exposed on the DOM, though `paragraphStyle.leading` may be.',
  'text.underline': 'Constants.Underline has no plain "on" here, only the vertical-text variants.',
};

/**
 * Capabilities known *not* to work here, and why.
 *
 * Every one of these was tried against Photoshop 26.11 / UXP 9.0.2 rather than
 * assumed, and each note records the failure that made it clear.
 */
var UNSUPPORTED = {
  'document.new': 'Works.',
  'document.crop': 'Every form of the `crop` descriptor is refused; ExtendScript performs the same crop through COM.',

  'document.new': 'Not implemented yet. `app.documents.add` is present.',
  'layer.transform_descriptor': 'Every form of the `transform` descriptor is a no-op; the DOM methods work instead, on the active layer only.',
  'text.style_descriptor': '`textStyleRange`/`set` aimed at `_ref: \'textLayer\'` opens a modal dialog; `TextItem.characterStyle` works.',
  'color.solid_color': 'There is no factory: `app.solidColor` is absent and `new app.SolidColor(x)` ignores its argument.',
};

/** Reads a dotted path off an object, returning `undefined` for anything missing. */
function probe(root, path) {
  var parts = path.split('.');
  var current = root;
  for (var i = 0; i < parts.length; i += 1) {
    if (current === null || current === undefined) return false;
    current = current[parts[i]];
  }
  return typeof current !== 'undefined' && current !== null;
}

/**
 * Each entry is read from the live host, never from a cached answer.
 *
 * `app` and `constants` are always there; the document and layer members are only
 * meaningful when something is open, and this tool has to work with no document
 * open — it is the tool you call to find out whether a document is even needed.
 */
function readApiSurface() {
  var app = photoshop.app;
  var constants = photoshop.constants || {};
  var doc = null;
  var layer = null;
  try {
    doc = app.activeDocument;
    layer = doc && doc.activeLayers ? doc.activeLayers[0] : null;
  } catch (err) {
    doc = null;
    layer = null;
  }

  return {
    // --- document lifecycle ---
    'document.read': probe(app, 'activeDocument'),
    'document.new': probe(app, 'documents.add'),
    'document.close': probe(doc, 'closeWithoutSaving'),
    'document.rename': probe(doc, 'name'),
    'document.list': probe(app, 'documents'),
    'document.duplicate': probe(doc, 'duplicate'),
    'document.save': probe(doc, 'save'),
    'document.mode': probe(doc, 'changeMode'),
    'document.resize_canvas': probe(photoshop, 'action.batchPlay'),
    'document.crop': probe(photoshop, 'action.batchPlay'),

    // --- layers ---
    'layer.list': probe(doc, 'layers'),
    'layer.create': probe(doc, 'createLayer'),
    'layer.group': probe(doc, 'createLayerGroup'),
    'layer.move': probe(layer, 'translate'),
    'layer.scale': probe(layer, 'scale'),
    'layer.rotate': probe(layer, 'rotate'),
    'layer.flip': probe(layer, 'flipHorizontal'),
    'layer.blend_mode': probe(layer, 'blendMode'),
    'layer.fill_opacity': probe(layer, 'fillOpacity'),
    'layer.mask': probe(layer, 'createMask') || probe(doc, 'createLayerMask'),
    'layer.mask_remove': probe(layer, 'deleteMask'),
    'layer.smart_object': probe(layer, 'convertToSmartObject'),
    'layer.pixels': probe(layer, 'pixels'),

    // --- selections ---
    'selection.all': probe(doc, 'selection.selectAll'),
    'selection.rectangle': probe(doc, 'selection.selectRectangle'),
    'selection.deselect': probe(doc, 'selection.deselect'),
    'selection.invert': probe(doc, 'selection.inverse'),
    'selection.feather': probe(doc, 'selection.feather'),

    // --- document finishing, found by enumerating the DOM ---
    'document.trim': probe(doc, 'trim'),
    'document.flatten': probe(doc, 'flatten'),
    'document.merge_visible': probe(doc, 'mergeVisibleLayers'),
    'document.rasterize_all': probe(doc, 'rasterizeAllLayers'),
    'document.split_channels': probe(doc, 'splitChannels'),
    'document.calculations': probe(doc, 'calculations'),
    'document.convert_profile': probe(doc, 'convertProfile'),
    'document.sample_color': probe(doc, 'sampleColor'),
    'document.suspend_history': probe(doc, 'suspendHistory'),
    'document.create_pixel_layer': probe(doc, 'createPixelLayer'),
    'document.duplicate_layers': probe(doc, 'duplicateLayers'),
    'document.reveal_all': probe(doc, 'revealAll'),
    'document.guides': probe(doc, 'guides'),
    'document.artboards': probe(doc, 'artboards'),
    'document.layer_comps': probe(doc, 'layerComps'),
    'document.path_items': probe(doc, 'pathItems'),
    'document.rotate': probe(doc, 'rotate'),
    'document.resize_image': probe(doc, 'resizeImage'),

    // --- layer surface, likewise ---
    'layer.rasterize': probe(layer, 'rasterize'),
    'layer.flip': probe(layer, 'flip'),
    'layer.rotate': probe(layer, 'rotate'),
    'layer.skew': probe(layer, 'skew'),
    'layer.apply_image': probe(layer, 'applyImage'),
    'layer.merge': probe(layer, 'merge'),
    'layer.clear': probe(layer, 'clear'),
    'layer.trim': probe(layer, 'trim'),
    'layer.set_locking': probe(layer, 'setLocking'),
    'layer.bounds_no_effects': probe(layer, 'boundsNoEffects'),
    'layer.layer_mask_density': probe(layer, 'layerMaskDensity'),
    'layer.layer_mask_feather': probe(layer, 'layerMaskFeather'),
    'layer.vector_mask_density': probe(layer, 'vectorMaskDensity'),
    'layer.filter_mask_density': probe(layer, 'filterMaskDensity'),
    'layer.linked_layers': probe(layer, 'linkedLayers'),
    'layer.link': probe(layer, 'link'),
    'layer.unlink': probe(layer, 'unlink'),
    'layer.adjustment_info': probe(layer, 'adjustmentInfo'),
    'layer.bring_to_front': probe(layer, 'bringToFront'),
    'layer.send_to_back': probe(layer, 'sendToBack'),

    // --- text ---
    'text.create': probe(doc, 'createTextLayer'),
    'text.character_style': probe(layer, 'textItem.characterStyle'),
    'text.paragraph_style': probe(layer, 'textItem.paragraphStyle'),
    'text.tracking': probe(layer, 'textItem.characterStyle.tracking'),
    'text.leading': probe(layer, 'textItem.characterStyle.leading'),
    'text.faux_bold': probe(layer, 'textItem.characterStyle.fauxBold'),
    'text.faux_italic': probe(layer, 'textItem.characterStyle.fauxItalic'),
    'text.baseline_shift': probe(layer, 'textItem.characterStyle.baselineShift'),
    'text.underline_enum': probe(constants, 'Underline'),
    'selection_type_enum': probe(constants, 'SelectionType'),
    'text.paragraph_width': probe(layer, 'textItem.convertToParagraphText'),

    // --- layer filters: the DOM's `apply*` family ---
    'filter.gaussian_blur': probe(layer, 'applyGaussianBlur'),
    'filter.motion_blur': probe(layer, 'applyMotionBlur'),
    'filter.radial_blur': probe(layer, 'applyRadialBlur'),
    'filter.smart_blur': probe(layer, 'applySmartBlur'),
    'filter.unsharp_mask': probe(layer, 'applyUnSharpMask'),
    'filter.sharpen': probe(layer, 'applySharpen'),
    'filter.add_noise': probe(layer, 'applyAddNoise'),
    'filter.median_noise': probe(layer, 'applyMedianNoise'),
    'filter.dust_and_scratches': probe(layer, 'applyDustAndScratches'),
    'filter.despeckle': probe(layer, 'applyDespeckle'),
    'filter.speckle': probe(layer, 'applySpeckle'),
    'filter.high_pass': probe(layer, 'applyHighPass'),
    'filter.offset': probe(layer, 'applyOffset'),
    'filter.twirl': probe(layer, 'applyTwirl'),
    'filter.spherize': probe(layer, 'applySpherize'),
    'filter.ripple': probe(layer, 'applyRipple'),
    'filter.pinch': probe(layer, 'applyPinch'),
    'filter.zig_zag': probe(layer, 'applyZigZag'),
    'filter.wave': probe(layer, 'applyWave'),
    'filter.shear': probe(layer, 'applyShear'),
    'filter.diffuse_glow': probe(layer, 'applyDiffuseGlow'),
    'filter.maximum': probe(layer, 'applyMaximum'),
    'filter.minimum': probe(layer, 'applyMinimum'),

    // --- selection, likewise ---
    'selection.grow': probe(doc.selection, 'grow'),
    'selection.expand': probe(doc.selection, 'expand'),
    'selection.contract': probe(doc.selection, 'contract'),
    'selection.smooth': probe(doc.selection, 'smooth'),
    'selection.select_border': probe(doc.selection, 'selectBorder'),
    'selection.solid': probe(doc.selection, 'solid'),

    // --- text, likewise ---
    'text.convert_to_shape': probe(layer, 'textItem.convertToShape'),
    'text.convert_to_point': probe(layer, 'textItem.convertToPointText'),
    'text.warp': probe(layer, 'textItem.warpStyle'),
    'text.orientation': probe(layer, 'textItem.orientation'),
    'text.character_property_getter': probe(layer, 'textItem.characterStyle.getCharacterPropertyValue'),

    // --- colour and application ---
    'color.solid_color': probe(app, 'solidColor') || probe(app, 'SolidColor'),
    'color.foreground': probe(app, 'foregroundColor'),
    'color.profiles': probe(app, 'getColorProfiles'),
    'app.fonts': probe(app, 'fonts'),
    'app.preferences': probe(app, 'preferences'),
    'app.convert_units': probe(app, 'convertUnits'),
    'app.color_sampler': probe(app, 'ColorSampler'),

    // --- files ---
    'file.stage': probe(ps.fs, 'createEntryWithUrl'),
    'file.open_entry': probe(ps.fs, 'getEntryWithUrl'),

    // --- constants the plugin relies on ---
    'enum.layer_kind': probe(constants, 'LayerKind'),
    'enum.element_placement': probe(constants, 'ElementPlacement'),
  };
}

/** `get_capabilities` */
function getCapabilities() {
  var api = readApiSurface();
  var capabilities = {};
  var unsupported = [];

  Object.keys(api).forEach(function (id) {
    var known = UNSUPPORTED[id];
    var entry = { api: api[id] === true };
    if (known) {
      entry.usable = false;
      entry.note = known;
      unsupported.push(id);
    } else {
      entry.usable = VERIFIED.indexOf(id) !== -1;
      var absent = entry.api ? undefined : NOT_ON_DOM[id];
      if (absent) entry.note = absent;
      else if (!entry.usable && entry.api) entry.note = 'Present, but not yet exercised against this build.';
    }
    capabilities[id] = entry;
  });

  return {
    hostApp: 'photoshop',
    hostVersion: '26.11',
    uxpVersion: uxp.versions ? String(uxp.versions.uxp) : 'unknown',
    capabilities: capabilities,
    unsupported: unsupported,
  };
}

module.exports = { get_capabilities: getCapabilities };