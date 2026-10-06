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
/**
 * Measured on this build and NOT usable, recorded here so the `api`/`usable`
 * split above is not a way of hiding it.
 *
 * `layer.create` was on this list and should never have been. `createLayer` and
 * `createPixelLayer` both return a 0×0 layer, and their `width`, `height` and
 * `fill` options are accepted and ignored — so there is no area to scale into
 * and no pixels to fill. It reported success, named the layer, and passed every
 * declared check, because no check measured area. `layer.scale` is off for the
 * same reason: it is reached through a layer that has none.
 *
 * `create_layer` now refuses instead of returning an empty layer. Bringing pixels
 * in still works, and is what the refusal points at: `place_image` and
 * `apply_image` both genuinely write pixels.
 */
var NOT_USABLE = {
  'layer.create': 'document.createLayer and createPixelLayer both return 0×0; width/height/fill are ignored',
  'layer.scale': 'unreachable: the layer it would scale has no area',
  'layer.fill': 'no working route found; `make content layer` hangs and selection.fill does not exist',
  'shape.create': 'no working route found; `make content layer` with a shape hangs',
  'brush.engine': 'the brush engine itself is unreachable from UXP on this build — see UNSUPPORTED.brush.engine',
};

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
  'layer.delete',
  'layer.rename',
  'layer.visibility',
  'layer.opacity',
  'layer.group',
  'layer.reorder',
  'layer.move',
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
  'selection.refine',
  'layer.lock',
  'text.list_fonts',
  'layer.duplicate',
  'layer.apply_image',
  'brush.rasterize',
  'brush.sample_color',
  'brush.selection_ellipse',
  'brush.selection_rectangle',
  'brush.gradient',
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
  'document.name_new': 'A new document cannot be named on this build: `documents.add` ignores a name and `Document.name` has no setter. `duplicate_document` can, because `duplicate(name)` takes one.',
  'layer.mask': 'Not on the DOM; a mask has to be created with a `make` descriptor.',
  'layer.mask_remove': 'Not on the DOM.',
  'layer.smart_object': 'Not on the DOM; `convertToSmartObject` has to go through batchPlay.',
  'layer.pixels': 'Not on the DOM on this build.',
  'layer.flip': 'Not on the DOM.',
  'adjustment.layer': 'Not on the DOM; an adjustment layer needs a `makeAdjustmentLayer` descriptor.',
  'text.leading': 'Not exposed on the DOM, though `paragraphStyle.leading` may be.',
  'text.underline': 'Constants.Underline has no plain "on" here, only the vertical-text variants.',
  'text.strikethrough': 'characterStyle.strikeThrough takes a Constants.StrikeThrough enum, separate from Underline; the two are not interchangeable.',
  'layer.lock_readback': 'setLocking is accepted, but no flag can be read back: layer.locked stays false whatever is requested, and lockedTransparency / lockedPosition are not on the DOM.',
};

/**
 * Capabilities known *not* to work here, and why.
 *
 * Every one of these was tried against Photoshop 26.11 / UXP 9.0.2 rather than
 * assumed, and each note records the failure that made it clear.
 */
var UNSUPPORTED = {
  'brush.engine': 'Photoshop\'s brush engine cannot be reached on this build, from either door, so `stroke_path` and `paint_stroke` rasterize the path with overlapping discs instead of driving the brush. From UXP, four routes were measured and all four fail: `core.executeScript` / `_executeScript` / `evalScript` / `doScript` are absent from `core`, `action` and `app` per an `Object.getOwnPropertyNames` dump; `core.performMenuCommand` cannot resolve a command symbol because `constants.MenuCommand` exposes no members here, so every spelling returns `timeOut`; the `_obj: \'stroke\'` batchPlay descriptor hangs because a descriptor without `strokeStyle`/`paintStyle` leaves Photoshop waiting on a dialog a modal scope cannot dismiss; and `_obj: \'paint\'` is rejected as "command unavailable". The COM/ExtendScript door is shut too: driven over COM, `typeof app.brushes` and `typeof app.activeBrush` both return "undefined", so no Brush object can be obtained and `PathItem.stroke()` cannot be called at all. An earlier note here claimed that route worked and pointed at `scripts/brush-firework.jsx` as proof; it does not. Run, that script reports `brushUsed=false; bursts=-1` and dies on `app.brushes` — the very property that is missing. It is kept only as a reproduction, not as a working demo.',
  'layer.select_after_create': '`createLayer()` does NOT make the new layer the active one. Anything that fills or paints immediately afterwards goes to the previously active layer, and the new layer comes back 0x0 — which reads as "Photoshop refused to create a layer" when it is really a selection bug on our side. `ps.selectLayer()` exists for this and both `ops/brush.js: createStrokeLayer` and `lib/demo.js: makeRect` now call it. Measured after the symptom, not before: a demo document reported a "Logo layer came back empty" that was this.',
  'layer.create_pixels': 'This host cannot make a pixel layer with area in it. `document.createLayer()` and `createPixelLayer()` both return 0x0 and ignore width, height and fill. The descriptor route was measured too: `{_obj: \'make\', make: {_obj: \'contentLayer\'}}` does not return — it leaves Photoshop waiting, and every later call on that host stops answering, the same failure mode as the `_obj: \'stroke\'` descriptor above. It was tried and reverted rather than shipped. So a gradient or stroke asked onto `newLayer` is refused with UNSUPPORTED_OPERATION instead of being silently empty; paint onto the active layer, and note that the Background layer is locked against transforms, which is why `smoothRadius` cannot blur a fresh canvas.',
  'brush.gradient': 'Photoshop\'s native gradient fill (an adjustment layer) is not reachable from UXP on this build either — no adjustment-layer API exists in this host, so `paint_gradient` resolves the ramp into `bands` flat fills drawn with `selection.selectRectangle` (linear) or `selection.selectEllipse` (radial). The seams are real: raise `bands` to make them finer, or set `smoothRadius` to blur them out. Only the four axis directions are exact, because a band is an axis-aligned rectangle.',
  'brush.list': 'No brush collection is reachable: neither `app.brushes` nor `document.brushes` exists on this build. `list_brushes` reports `available: false` with a reason instead of inventing names. A brush *name* therefore cannot change a stroke — strokes are discs of the diameter in `brushSize`.',
  'brush.tip': 'Stroke width comes from `brushSize` alone. Tip shape, hardness, spacing, flow and jitter are not modelled, so two brushes of the same diameter rasterize identically.',
  'document.crop': 'Every form of the `crop` descriptor is refused; ExtendScript performs the same crop through COM.',
  'layer.transform_descriptor': 'Every form of the `transform` descriptor is a no-op; the DOM methods work instead, on the active layer only.',
  'text.style_descriptor': '`textStyleRange`/`set` aimed at `_ref: \'textLayer\'` opens a modal dialog; `TextItem.characterStyle` works.',
  'color.solid_color': 'There is no factory: `app.solidColor` is absent and `new app.SolidColor(x)` ignores its argument.',
  'document.history_bracket': 'suspendHistory groups only work inside one call. Held open across two requests it reports `opened: false` and rejects, so a multi-step run cannot be grouped into one undo step from the DOM; it needs the steps performed inside a single call.',
  'layer.fill': 'Not achievable on this build. Three routes were tried: `createPixelLayer({fill})` accepts the fill and leaves the layer 0x0; `selection.fill` does not exist; and the `fill` descriptor via batchPlay leaves it 0x0 in both of its spellings. A filled layer is therefore not offered as a tool.',
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
    'selection.select_ellipse': probe(doc, 'selection.selectEllipse'),
    'selection.select_rectangle': probe(doc, 'selection.selectRectangle'),

    // --- brushes, probed rather than assumed ---
    'app.brushes': probe(photoshop.app, 'brushes'),
    'document.brushes': probe(doc, 'brushes'),
    'brush.engine': probe(photoshop.core, 'executeScript'),

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
    'text.strikethrough_enum': probe(constants, 'StrikeThrough'),
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
    'selection.fill': probe(doc.selection, 'fill'),
    'selection.select_all_probe': probe(doc.selection, 'selectAll'),
    'document.create_pixel_layer_fill': probe(doc, 'createPixelLayer'),
    'selection.inverse': probe(doc.selection, 'inverse'),

    // --- locking: the flags are separate from the single `layer.locked` ------
    'layer.locked_transparency': probe(layer, 'lockedTransparency'),
    'layer.locked_position': probe(layer, 'lockedPosition'),
    'layer.locked_all': probe(layer, 'locked'),

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
    'document.pixel_layer': probe(doc, 'createPixelLayer'),
    'layer.duplicate_dom': probe(layer, 'duplicate'),
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
      // Measured on this host and found not to work. Saying "not yet exercised"
      // here would be a guess dressed as a record, and would leave a known-false
      // capability looking merely unproven.
      var measured = NOT_USABLE[id];
      var absent = entry.api ? undefined : NOT_ON_DOM[id];
      if (measured) entry.note = 'Present but does not work on this build: ' + measured;
      else if (absent) entry.note = absent;
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
    samples: sampleShapes(),
  };
}

/**
 * Real shapes, read from the live host.
 *
 * The property names of a `Font` or of a layer's locking flags are not in any
 * document this project can consult, and guessing them produces code that reads
 * `undefined` and reports success. Naming the keys the host actually exposes
 * turns "I think it is `postScriptName`" into a fact that can be checked.
 */
function sampleShapes() {
  var out = {};
  // Each of these is tried in turn: a reference that throws is the expected way to
  // find out, and guessing which one a build exposes is how the wrong one gets
  // baked in.
  function host(name) {
    try {
      if (photoshop[name]) return photoshop[name];
    } catch (err) {
      /* not exposed under this name on this build */
    }
    try {
      return require('uxp')[name];
    } catch (err) {
      return null;
    }
  }

  try {
    var app = host('app');
    var fonts = app && app.fonts;
    if (fonts && fonts.length) {
      out.fonts = {
        count: fonts.length,
        keys: Object.keys(fonts[0]),
        first: {
          name: fonts[0].name,
          family: fonts[0].family,
          style: fonts[0].style,
          postScriptName: fonts[0].postScriptName,
        },
      };
    } else {
      out.fonts = { count: 0 };
    }
  } catch (err) {
    out.fonts = { error: (err && err.message) || String(err) };
  }

  try {
    var app2 = host('app');
    var doc = app2 && app2.activeDocument;
    var layer = doc && doc.layers && doc.layers.length ? doc.layers[0] : null;
    if (layer) {
      out.layer = {
        lockKeys: Object.keys(layer).filter(function (key) { return /lock/i.test(key); }),
        locked: layer.locked,
        lockedTransparency: layer.lockedTransparency,
        lockedPosition: layer.lockedPosition,
      };
    }
  } catch (err) {
    out.layer = { error: (err && err.message) || String(err) };
  }

  try {
    var app3 = host('app');
    var selection = app3 && app3.activeDocument && app3.activeDocument.selection;
    out.selection = {
      keys: selection ? Object.keys(selection) : [],
      methods: selection
        ? Object.keys(selection).filter(function (key) { return typeof selection[key] === 'function'; })
        : [],
    };
  } catch (err) {
    out.selection = { error: (err && err.message) || String(err) };
  }

  return out;
}

module.exports = { get_capabilities: getCapabilities };