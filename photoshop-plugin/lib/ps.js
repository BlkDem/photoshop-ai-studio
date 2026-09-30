/**
 * Photoshop access helpers.
 *
 * This is the *only* module in the plugin that touches `require('photoshop')`.
 * Everything else works with normalised values ({id, name, x, y, ...}) or with
 * layer objects passed in, which keeps the operation files readable and makes
 * the UXP-specific surface obvious in one place.
 *
 * Two rules enforced here, because violating either corrupts a document:
 *
 *  1. **Every mutation runs inside `core.executeAsModal`.** Photoshop rejects
 *     concurrent mutations and the MCP server already serialises operations, so
 *     one modal scope per operation is both necessary and sufficient.
 *  2. **Every `batchPlay` result is inspected.** `await batchPlay(...)` resolves
 *     even when Photoshop refused the command; the refusal arrives as a
 *     descriptor whose `_obj` is `"error"`. Checking only the promise would turn
 *     a failed edit into a reported success.
 */
'use strict';

var photoshop = require('photoshop');
var uxp = require('uxp');

var app = photoshop.app;
var action = photoshop.action;
var core = photoshop.core;
var constants = photoshop.constants;

var storage = uxp.storage;
var fs = storage.localFileSystem;
var formats = storage.formats;

var errors = require('./errors.js');
var StudioError = errors.StudioError;
var Logger = require('./logger.js').Logger;

// ---------------------------------------------------------------------------
// modal scope
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside Photoshop's modal scope.
 *
 * `err.number === 9` means another plugin holds the scope; that is transient, so
 * it is reported as recoverable rather than failed.
 */
function asModal(commandName, fn) {
  return core
    .executeAsModal(fn, { commandName: commandName, interactive: false })
    .catch(function (err) {
      if (err && err.number === 9) {
        throw StudioError('MODAL_STATE', 'Photoshop is busy in another modal operation; retry shortly.', {
          recoverable: true,
        });
      }
      throw errors.toWireError ? normalizeUnknown(err, commandName) : err;
    });
}

function normalizeUnknown(err, context) {
  var message = (err && err.message) || String(err);
  return StudioError('STEP_FAILED', context + ': ' + message, { recoverable: false });
}

// ---------------------------------------------------------------------------
// batchPlay
// ---------------------------------------------------------------------------

/**
 * Runs action descriptors and throws when Photoshop reports an error.
 *
 * `_options.suppressProgressBar` is Photoshop 25.0+; older builds ignore unknown
 * options, so it is always safe to pass.
 */
function batchPlay(descriptors, options) {
  var opts = options || {};
  return action
    .batchPlay(descriptors, {
      continueOnError: false,
      immediateRedraw: false,
      _options: { suppressProgressBar: opts.silent !== false },
    })
    .then(function (result) {
      if (!Array.isArray(result)) return result;
      for (var i = 0; i < result.length; i += 1) {
        var item = result[i];
        if (item && item._obj === 'error') {
          throw errors.photoshopFailure(item.result, item.message);
        }
      }
      return result;
    })
    .catch(function (err) {
      if (errors.StudioError.isStudioError(err)) throw err;
      throw StudioError('STEP_FAILED', 'batchPlay failed: ' + ((err && err.message) || String(err)), {
        recoverable: false,
      });
    });
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/** The document an operation applies to. `documentId` is 'active' by default. */
function resolveDocument(documentId) {
  if (!documentId || documentId === 'active') {
    if (!app.activeDocument) {
      throw StudioError('NO_DOCUMENT_OPEN', 'No document is open in Photoshop. Open one and try again.');
    }
    return app.activeDocument;
  }
  var docs = app.documents;
  for (var i = 0; i < docs.length; i += 1) {
    if (String(docs[i].id) === String(documentId)) return docs[i];
  }
  throw StudioError('DOCUMENT_NOT_FOUND', 'No open document with id "' + documentId + '".', {
    details: { documentId: documentId, open: listDocumentIds() },
  });
}

function listDocumentIds() {
  var out = [];
  var docs = app.documents;
  for (var i = 0; i < docs.length; i += 1) out.push(String(docs[i].id));
  return out;
}

function documentInfo(doc) {
  return {
    id: String(doc.id),
    name: doc.name,
    width: doc.width,
    height: doc.height,
    resolution: doc.resolution,
    colorMode: mapColorMode(doc.mode),
    layerCount: countLayers(doc.layers),
    path: safePath(doc),
    saved: doc.saved !== false,
    active: isActive(doc),
    colorProfile: doc.colorProfileName || null,
    bitsPerChannel: doc.bitsPerChannel || 8,
    pixelAspectRatio: doc.pixelAspectRatio || 1,
    zoom: typeof doc.zoom === 'number' ? doc.zoom : undefined,
  };
}

function isActive(doc) {
  try {
    return String(app.activeDocument.id) === String(doc.id);
  } catch (err) {
    return false;
  }
}

function safePath(doc) {
  try {
    if (!doc.path) return null;
    return String(doc.path);
  } catch (err) {
    return null;
  }
}

function mapColorMode(mode) {
  // `doc.mode` is the documented property; `doc.colorMode` never existed in UXP.
  var raw = String(mode || 'RGB').toUpperCase();
  var known = [
    'RGB',
    'CMYK',
    'GRAYSCALE',
    'LAB',
    'BITMAP',
    'DUOTONE',
    'INDEXEDCOLOR',
    'MULTICHANNEL',
  ];
  for (var i = 0; i < known.length; i += 1) {
    if (raw === known[i] || raw.replace(/\s/g, '') === known[i]) return known[i];
  }
  return 'RGB';
}

/** Total layer count including nested group children. */
function countLayers(layers) {
  var total = 0;
  for (var i = 0; i < (layers || []).length; i += 1) {
    total += 1;
    total += countLayers(layers[i].layers);
  }
  return total;
}

// ---------------------------------------------------------------------------
// layers
// ---------------------------------------------------------------------------

/**
 * Flattens the layer tree into `LayerInfo` records.
 *
 * `document.layers` only returns top-level layers; group children come from
 * `layer.layers`, so hierarchy is recovered by walking down and carrying the
 * parent id.
 */
function flattenLayers(layers, parentId, out) {
  var result = out || [];
  for (var i = 0; i < (layers || []).length; i += 1) {
    var layer = layers[i];
    result.push(layerInfo(layer, parentId === undefined ? null : parentId));
    if (layer.layers && layer.layers.length > 0) {
      flattenLayers(layer.layers, layer.id, result);
    }
  }
  return result;
}

/**
 * Normalised layer record.
 *
 * `bounds` is read defensively because the DOM returns either
 * `{left, top, right, bottom}` or `{left, top, width, height}` depending on the
 * Photoshop build; both are handled rather than assumed.
 */
function layerInfo(layer, parentId) {
  var kind = mapLayerKind(layer.kind);
  return {
    id: layer.id,
    name: layer.name,
    type: kind,
    visible: layer.visible !== false,
    opacity: round(layer.opacity, 1),
    x: boundsOf(layer).x,
    y: boundsOf(layer).y,
    width: boundsOf(layer).width,
    height: boundsOf(layer).height,
    parentId: parentId,
    fillOpacity: typeof layer.fillOpacity === 'number' ? round(layer.fillOpacity, 1) : undefined,
    blendMode: layer.blendMode ? String(layer.blendMode) : undefined,
    isBackground: layer.isBackgroundLayer === true,
    isClippingMask: layer.isClippingMask === true,
    isLocked: layer.locked === true,
    children: layer.layers && layer.layers.length ? childIds(layer.layers) : undefined,
    hasText: kind === 'text',
  };
}

function childIds(layers) {
  var ids = [];
  for (var i = 0; i < layers.length; i += 1) ids.push(layers[i].id);
  return ids;
}

function boundsOf(layer) {
  var b = null;
  try {
    b = layer.bounds;
  } catch (err) {
    b = null;
  }
  if (!b) return { x: 0, y: 0, width: 0, height: 0 };

  var hasCorners = typeof b.right === 'number' && typeof b.bottom === 'number';
  var width = hasCorners ? b.right - b.left : typeof b.width === 'number' ? b.width : 0;
  var height = hasCorners ? b.bottom - b.top : typeof b.height === 'number' ? b.height : 0;
  return {
    x: typeof b.left === 'number' ? b.left : 0,
    y: typeof b.top === 'number' ? b.top : 0,
    width: width > 0 ? width : 0,
    height: height > 0 ? height : 0,
  };
}

/**
 * Maps the UXP `LayerKind` enum onto our canonical taxonomy.
 *
 * Adjustment layers are numerous; they collapse to `adjustment` rather than
 * leaking 20 enum values into the AI's vocabulary.
 */
function mapLayerKind(kind) {
  if (typeof kind === 'string') {
    var upper = kind.toUpperCase();
    if (constants.LayerKind && constants.LayerKind[upper] !== undefined) kind = constants.LayerKind[upper];
    else {
      var direct = {
        NORMAL: 'pixel',
        PIXEL: 'pixel',
        TEXT: 'text',
        SMARTOBJECT: 'smartObject',
        GROUP: 'group',
        SHAPE: 'shape',
        SOLIDFILL: 'solidFill',
        GRADIENTFILL: 'gradientFill',
        PATTERNFILL: 'patternFill',
        VIDEO: 'video',
        LAYER3D: 'layer3d',
        '3D': 'layer3d',
      }[upper];
      if (direct) return direct;
    }
  }

  switch (kind) {
    case 1:
      return 'smartObject';
    case 2:
      return 'text';
    case 3:
      return 'solidFill';
    case 4:
      return 'gradientFill';
    case 5:
      return 'patternFill';
    case 6:
      return 'adjustment';
    case 7:
      return 'video';
    case 8:
      return 'layer3d';
    case 9:
      return 'group';
    case 10:
      return 'shape';
    case 11:
      return 'pixel';
    default:
      return 'other';
  }
}

/** Finds a layer anywhere in the document by id (preferred) or by exact name. */
function findLayer(doc, selector) {
  var all = flattenLayers(doc.layers);
  var i;
  if (selector.layerId !== undefined && selector.layerId !== null) {
    for (i = 0; i < all.length; i += 1) {
      if (all[i].id === selector.layerId) return findLayerObject(doc, selector.layerId);
    }
    throw StudioError('LAYER_NOT_FOUND', 'Layer id ' + selector.layerId + ' was not found.', {
      details: { layerId: selector.layerId, available: all.map(nameOf) },
    });
  }
  if (typeof selector.layerName === 'string' && selector.layerName.length > 0) {
    var matches = [];
    for (i = 0; i < all.length; i += 1) {
      if (all[i].name === selector.layerName) matches.push(all[i].id);
    }
    if (matches.length === 1) return findLayerObject(doc, matches[0]);
    if (matches.length === 0) {
      throw StudioError('LAYER_NOT_FOUND', 'Layer "' + selector.layerName + '" was not found.', {
        details: { layerName: selector.layerName, available: all.map(nameOf) },
      });
    }
    throw StudioError(
      'INVALID_PARAMS',
      'Layer name "' + selector.layerName + '" is ambiguous (' + matches.length + ' layers). Use layerId instead.',
      { details: { layerIds: matches } },
    );
  }
  throw StudioError('INVALID_PARAMS', 'Provide exactly one of layerId or layerName.');
}

function nameOf(info) {
  return info.name;
}

function findLayerObject(doc, layerId) {
  var found = null;
  walk(doc.layers, function (layer) {
    if (layer.id === layerId) {
      found = layer;
      return false;
    }
    return true;
  });
  if (!found) {
    throw StudioError('LAYER_NOT_FOUND', 'Layer id ' + layerId + ' was not found.');
  }
  return found;
}

function walk(layers, visitor) {
  for (var i = 0; i < (layers || []).length; i += 1) {
    if (visitor(layers[i]) === false) return false;
    if (layers[i].layers && walk(layers[i].layers, visitor) === false) return false;
  }
  return true;
}

/** Every ancestor id of a layer, closest first. */
function ancestorsOf(doc, layerId) {
  var chain = [];
  var current = findLayerObject(doc, layerId);
  var guard = 0;
  while (current && guard < 64) {
    guard += 1;
    var parent = parentOf(doc, current.id);
    if (!parent) break;
    chain.push(parent.id);
    current = parent;
  }
  return chain;
}

function parentOf(doc, layerId) {
  var found = null;
  walk(doc.layers, function (layer) {
    if (layer.layers) {
      for (var i = 0; i < layer.layers.length; i += 1) {
        if (layer.layers[i].id === layerId) {
          found = layer;
          return false;
        }
      }
    }
    return true;
  });
  return found;
}

function assertMutable(layer) {
  if (layer.locked === true || layer.positionLocked === true || layer.pixelsLocked === true) {
    throw StudioError('LAYER_LOCKED', 'Layer "' + layer.name + '" is locked.', {
      details: { layerId: layer.id },
    });
  }
}

function assertNotGroup(layer, what) {
  if (mapLayerKind(layer.kind) === 'group') {
    throw StudioError('LAYER_IS_GROUP', '"' + layer.name + '" is a group; ' + (what || 'this operation needs a layer'), {
      details: { layerId: layer.id },
    });
  }
}

function assertIsGroup(layer) {
  if (mapLayerKind(layer.kind) !== 'group') {
    throw StudioError('LAYER_IS_GROUP', '"' + layer.name + '" is a ' + mapLayerKind(layer.kind) + ' layer, not a group.', {
      details: { layerId: layer.id },
    });
  }
}

function assertText(layer) {
  if (mapLayerKind(layer.kind) !== 'text') {
    throw StudioError('NOT_A_TEXT_LAYER', '"' + layer.name + '" is a ' + mapLayerKind(layer.kind) + ' layer, not text.', {
      details: { layerId: layer.id, type: mapLayerKind(layer.kind) },
    });
  }
}

// ---------------------------------------------------------------------------
// filesystem
// ---------------------------------------------------------------------------

/**
 * Second, independent workspace check (§27).
 *
 * The MCP server already refuses paths outside its `WORKSPACE_ROOT`; this runs
 * inside Photoshop as well, because this is the code that actually opens files.
 * A path must live under both roots.
 */
function assertInsideWorkspace(absolutePath, config) {
  var root = String(config.workspaceRoot || '').replace(/[\\/]+$/, '');
  if (root === '') return;
  var normalizedPath = String(absolutePath).replace(/\\/g, '/');
  var normalizedRoot = root.replace(/\\/g, '/');
  if (normalizedPath === normalizedRoot) return;
  if (normalizedPath.indexOf(normalizedRoot + '/') === 0) return;
  throw StudioError(
    'PATH_NOT_ALLOWED',
    'Path "' + absolutePath + '" is outside the plugin workspace (' + root + ').',
    { details: { path: absolutePath, workspaceRoot: root } },
  );
}

function toFileUrl(path) {
  var p = String(path).replace(/\\/g, '/');
  if (p.indexOf('file:///') === 0) return p;
  if (p.indexOf('file:/') === 0) return p;
  return 'file:///' + (p.charAt(0) === '/' ? '' : '/') + p;
}

/** Opens an existing entry without showing a picker. */
function entryForReading(path, config) {
  assertInsideWorkspace(path, config);
  return fs.getEntryWithUrl(toFileUrl(path)).then(function (entry) {
    if (!entry) {
      throw StudioError('FILE_NOT_FOUND', 'File not found: ' + path);
    }
    return entry;
  });
}

/**
 * Creates (or opens) an entry for writing without showing a picker.
 *
 * `overwrite: true` reuses an existing entry, which is what makes the
 * confirmation-gated "export again" flow work without a file dialog.
 */
function entryForWriting(path, overwrite, config) {
  assertInsideWorkspace(path, config);
  return fs.createEntryWithUrl(toFileUrl(path), { overwrite: overwrite === true }).then(function (entry) {
    if (!entry) {
      throw StudioError('EXPORT_FAILED', 'Could not create ' + path);
    }
    return entry;
  });
}

/** Base64 for a byte array — UXP has no `Buffer` and no guaranteed `btoa`. */
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  var out = '';
  var i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  var rest = bytes.length - i;
  if (rest === 1) {
    var a = bytes[i] << 16;
    out += B64[(a >> 18) & 63] + B64[(a >> 12) & 63] + '==';
  } else if (rest === 2) {
    var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(b >> 18) & 63] + B64[(b >> 12) & 63] + B64[(b >> 6) & 63] + '=';
  }
  return out;
}

function toByteArray(arrayBuffer) {
  return new Uint8Array(arrayBuffer);
}

function round(value, decimals) {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  var factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

module.exports = {
  app: app,
  action: action,
  core: core,
  constants: constants,
  fs: fs,
  formats: formats,
  uxp: uxp,

  asModal: asModal,
  batchPlay: batchPlay,

  resolveDocument: resolveDocument,
  documentInfo: documentInfo,
  listDocumentIds: listDocumentIds,
  countLayers: countLayers,

  flattenLayers: flattenLayers,
  layerInfo: layerInfo,
  mapLayerKind: mapLayerKind,
  boundsOf: boundsOf,
  findLayer: findLayer,
  findLayerObject: findLayerObject,
  parentOf: parentOf,
  ancestorsOf: ancestorsOf,
  assertMutable: assertMutable,
  assertNotGroup: assertNotGroup,
  assertIsGroup: assertIsGroup,
  assertText: assertText,
  walk: walk,

  entryForReading: entryForReading,
  entryForWriting: entryForWriting,
  assertInsideWorkspace: assertInsideWorkspace,
  toFileUrl: toFileUrl,
  toBase64: toBase64,
  toByteArray: toByteArray,
  round: round,

  Logger: Logger,
  StudioError: StudioError,
};
