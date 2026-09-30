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

/** Upper bound for a single `batchPlay`, milliseconds. */
var BATCH_TIMEOUT_MS = 15000;

/**
 * Resolves a freshly created layer to one with a usable `id`.
 *
 * `document.createLayer` / `createLayerGroup` return before the layer's id is
 * populated, so reading `layer.id` immediately yields `undefined` — which then
 * serialises as `id: -1, name: "undefined"`. Poll briefly, then fall back to the
 * top of the stack, which is where Photoshop puts a newly created layer.
 */
function resolveCreatedLayer(doc, created) {
  return new Promise(function (resolve) {
    var attempts = 0;
    function check() {
      attempts += 1;
      if (created && typeof created.id === 'number' && created.name !== undefined) {
        resolve(created);
        return;
      }
      if (attempts >= 5) {
        var layers = doc.layers;
        // `document.layers` is top-first, so a freshly created layer is index 0.
        resolve(layers && layers.length > 0 ? layers[0] : created);
        return;
      }
      setTimeout(check, 10);
    }
    check();
  });
}

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
  var command = action.batchPlay(descriptors, {
    continueOnError: false,
    immediateRedraw: false,
    _options: { suppressProgressBar: opts.silent !== false },
  });

  // Watchdog. A malformed descriptor can leave `batchPlay` pending forever, which
  // would wedge the bridge: the MCP server would time out, but the plugin would
  // still hold the modal scope and every later operation would queue behind it.
  // Failing fast keeps the rest of the pipeline alive and the error explainable.
  var deadline = new Promise(function (_resolve, reject) {
    var timer = setTimeout(function () {
      reject(
        StudioError('TIMEOUT', 'Photoshop did not answer the request within ' + (opts.timeoutMs || BATCH_TIMEOUT_MS) + 'ms', {
          recoverable: true,
        }),
      );
    }, opts.timeoutMs || BATCH_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });

  return Promise.race([command, deadline])
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
  // Every numeric field goes through `num()`: the UXP DOM is loosely typed and
  // returns some of these as strings, which would otherwise fail the MCP server's
  // result-schema validation.
  return {
    id: String(doc.id),
    name: String(doc.name),
    width: num(doc.width, 0),
    height: num(doc.height, 0),
    resolution: num(doc.resolution, 72),
    colorMode: mapColorMode(doc.mode),
    layerCount: countLayers(doc.layers),
    path: safePath(doc),
    saved: doc.saved !== false,
    active: isActive(doc),
    colorProfile: doc.colorProfileName ? String(doc.colorProfileName) : null,
    bitsPerChannel: num(doc.bitsPerChannel, 8),
    pixelAspectRatio: num(doc.pixelAspectRatio, 1),
    zoom: typeof doc.zoom === 'number' ? round(doc.zoom, 2) : undefined,
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
 * Two things the DOM does not hand over and this function therefore provides:
 *
 *  - Hierarchy. `document.layers` returns only top-level layers; group children
 *    come from `layer.layers`, so the parent id is carried down the walk.
 *  - **Order.** `document.layers` is top-first, like the Layers panel. The shared
 *    contract (and the tool description the model reads) says bottom-to-top, so
 *    the top level is reversed here. Getting this wrong does not corrupt an edit,
 *    but it makes every layer list read upside-down to the model.
 */
function flattenLayers(layers, parentId, out) {
  var result = out || [];
  var list = layers || [];
  for (var i = list.length - 1; i >= 0; i -= 1) {
    var layer = list[i];
    if (!layer) continue;
    result.push(layerInfo(layer, parentId === undefined ? null : parentId));
    if (layer.layers && layer.layers.length > 0) {
      flattenLayers(layer.layers, layer.id, result);
    }
  }
  return result;
}

/**
 * The document's **top-level** layers, bottom to top, as live `Layer` objects.
 *
 * `flattenLayers` returns normalised records, which is right for state and
 * diffing and useless for anything that has to act on a layer (`copy`, `move`,
 * `translate`). Top-level only, so pasting a multi-layer source keeps its groups
 * intact instead of collapsing them.
 */
function layerObjects(doc) {
  var list = (doc && doc.layers) || [];
  var out = [];
  for (var i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]) out.push(list[i]);
  }
  return out;
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
    id: num(layer.id, -1),
    name: String(layer.name),
    type: kind,
    visible: layer.visible !== false,
    opacity: round(num(layer.opacity, 100), 1),
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

  // Accept both shapes Photoshop uses, and coerce every edge: a stringy number
  // must be measured, not silently treated as "no bounds".
  var left = num(b.left, 0);
  var top = num(b.top, 0);
  var right = num(b.right, NaN);
  var bottom = num(b.bottom, NaN);
  var width = isFinite(right) ? right - left : num(b.width, 0);
  var height = isFinite(bottom) ? bottom - top : num(b.height, 0);
  return {
    x: left,
    y: top,
    width: width > 0 ? width : 0,
    height: height > 0 ? height : 0,
  };
}

/**
 * Maps the UXP `LayerKind` onto our canonical taxonomy.
 *
 * `constants.LayerKind` is a plain object whose **values are already the kind
 * names**: `{ NORMAL: 'pixel', TEXT: 'text', SMARTOBJECT: 'smartObject', ... }`
 * (verified against Photoshop 26.11 by dumping the enum at connect time). It is
 * *not* an ordinal enum, so a numeric switch silently labels every layer "other" —
 * which then makes every text operation fail with NOT_A_TEXT_LAYER.
 *
 * Resolution order: the value string, then the member name (for builds that
 * report names), then an honest "other".
 */
var KIND_BY_VALUE = {
  pixel: 'pixel',
  group: 'group',
  smartObject: 'smartObject',
  pattern: 'patternFill',
  solidColor: 'solidFill',
  text: 'text',
  threeD: 'layer3d',
  video: 'video',
};

/** Adjustment kinds collapse to one value so the model's vocabulary stays small. */
var ADJUSTMENT_VALUES = {
  blackAndWhite: true,
  brightnessContrast: true,
  channelMixer: true,
  colorBalance: true,
  colorLookup: true,
  curves: true,
  exposure: true,
  gradientMap: true,
  hueSaturation: true,
  inversion: true,
  levels: true,
  photoFilter: true,
  posterize: true,
  selectiveColor: true,
  threshold: true,
  vibrance: true,
};

/** Fallback for hosts that report the enum *member name* instead of its value. */
var KIND_BY_NAME = {
  NORMAL: 'pixel',
  PIXEL: 'pixel',
  SOLIDFILL: 'solidFill',
  GRADIENTFILL: 'gradientFill',
  PATTERNFILL: 'patternFill',
  TEXT: 'text',
  SMART_OBJECT: 'smartObject',
  SMARTOBJECT: 'smartObject',
  GROUP: 'group',
  SHAPE: 'shape',
  VIDEO: 'video',
  LAYER3D: 'layer3d',
  LAYER_3D: 'layer3d',
  '3D': 'layer3d',
};

function normalizeKindToken(token) {
  return String(token).replace(/[-_]/g, '').toLowerCase();
}

function mapLayerKind(kind) {
  if (typeof kind === 'string' && kind.length > 0) {
    if (KIND_BY_VALUE[kind]) return KIND_BY_VALUE[kind];
    if (ADJUSTMENT_VALUES[kind]) return 'adjustment';
    if (KIND_BY_NAME[kind.toUpperCase()]) return KIND_BY_NAME[kind.toUpperCase()];
    return 'other';
  }

  // Numeric: resolve back through the enum object, considering every alias.
  var enumObject = constants.LayerKind;
  if (enumObject) {
    var names = [];
    for (var name in enumObject) {
      if (Object.prototype.hasOwnProperty.call(enumObject, name) && enumObject[name] === kind) {
        names.push(name);
      }
    }
    for (var i = 0; i < names.length; i += 1) {
      var token = normalizeKindToken(names[i]);
      if (KIND_BY_VALUE[token]) return KIND_BY_VALUE[token];
      if (ADJUSTMENT_VALUES[token]) return 'adjustment';
      if (KIND_BY_NAME[names[i].toUpperCase()]) return KIND_BY_NAME[names[i].toUpperCase()];
    }
  }
  return 'other';
}

/**
 * Logs the host's `LayerKind` enum once.
 *
 * Its members are the ground truth for the mapping above; dumping them makes a
 * future mismatch diagnosable from the MCP server's log instead of by guesswork.
 */
function logLayerKindEnum() {
  try {
    var enumObject = constants.LayerKind;
    if (!enumObject) {
      Logger.warn('this Photoshop build exposes no constants.LayerKind; layer kinds will report "other"');
      return;
    }
    // Dump the raw shape first: `constants.LayerKind` is not documented as a
    // plain name->number map, and guessing its structure is what broke the
    // mapping in the first place.
    var raw = {};
    var seen = {};
    var unmapped = [];
    for (var name in enumObject) {
      if (!Object.prototype.hasOwnProperty.call(enumObject, name)) continue;
      var value = enumObject[name];
      raw[name] = typeof value + ':' + String(value);
      var mapped = mapLayerKind(value);
      seen[name] = mapped;
      if (mapped === 'other') unmapped.push(name);
    }
    Logger.debug('LayerKind raw', { ctor: enumObject.constructor && enumObject.constructor.name, own: Object.keys(enumObject).length, values: raw });
    Logger.info('LayerKind enum mapped', seen);
    if (unmapped.length > 0) {
      // Not fatal - "other" is an honest answer - but it means the host has kinds
      // this build does not name, and they should be added to the taxonomy.
      Logger.warn('LayerKind members with no taxonomy entry: ' + unmapped.join(', '));
    }
  } catch (err) {
    Logger.warn('could not read constants.LayerKind: ' + ((err && err.message) || String(err)));
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
 * Resolves a bridge-supplied path against this plugin's workspace root.
 *
 * Paths cross the socket **relative to the workspace**, never absolute. That is
 * not a stylistic choice: the MCP server may run on a different operating system
 * than Photoshop (a WSL host with Photoshop on Windows is the common case), where
 * an absolute path is meaningless to the receiving side — `/mnt/c/Users/...` is
 * not a path Windows can open. Relative paths also make the plugin's own
 * allow-list load-bearing rather than decorative.
 */
function resolveInWorkspace(path, config) {
  var root = String((config && config.workspaceRoot) || '').replace(/[\\/]+$/, '');
  if (root === '') {
    throw StudioError('PATH_NOT_ALLOWED', 'The plugin has no workspaceRoot configured; set it in config.json');
  }
  var candidate = String(path || '');
  // Treat a leading separator as workspace-relative rather than as filesystem-root,
  // so a server that cannot produce relative paths still cannot escape.
  var normalized = candidate.replace(/^[/\\]+/, '');
  var absolute = root + '/' + normalized;
  assertInsideWorkspace(absolute, config);
  return absolute;
}

/**
 * Second, independent workspace check (§27).
 *
 * The MCP server already refuses paths outside its workspace; this runs inside
 * Photoshop as well, because this is the code that actually opens files. A path
 * must live under both roots.
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
  var absolute = resolveInWorkspace(path, config);
  return fs.getEntryWithUrl(toFileUrl(absolute)).then(function (entry) {
    if (!entry) {
      throw StudioError('FILE_NOT_FOUND', 'File not found: ' + absolute);
    }
    return entry;
  }).catch(function (err) {
    if (err && err.name === 'StudioError' && err.code !== 'PATH_NOT_ALLOWED') throw err;
    // "Could not find an entry" for a file that exists is the sandbox refusing,
    // not the file being absent — worth telling apart.
    if (!currentWorkspaceGrant(config)) {
      throw StudioError(
        'WORKSPACE_NOT_GRANTED',
        'Photoshop has not granted this plugin access to "' + absolute + '". Open the AI Studio ' +
          'panel and use "Grant workspace access" once per session.',
        { recoverable: true, details: { path: absolute }, cause: err },
      );
    }
    throw StudioError('FILE_NOT_FOUND', 'File not found: ' + absolute, { details: { path: absolute }, cause: err });
  });
}

/**
 * Creates an empty file in the plugin's own data folder.
 *
 * UXP cannot write to an arbitrary absolute path. `localFileSystem: "request"`
 * only ever grants access to a folder the *user* picked, and there is no way to
 * ask for one without a gesture — so a headless export has nowhere to go.
 * `plugin-data:/` is the one location a plugin may always write.
 *
 * Photoshop therefore writes into its sandbox and reports `nativePath`; the MCP
 * server (which owns the filesystem and runs with real permissions) publishes
 * the file into the workspace. The path is reported as an opaque staging path —
 * it is a transport detail, not an API.
 */
/**
 * URL prefixes a *real*, Photoshop-readable file can be staged under, best first.
 *
 * `plugin-data:/` is the plugin's own data folder. It is the only prefix UXP
 * lets us create an entry in without a permission grant, but Photoshop's own
 * file readers cannot open it: `placeEvent` answered "The user cancelled the
 * operation" for a file sitting there. `plugin-temp:/` is the sandbox's
 * temporary directory, which is backed by a real OS path, so it is tried first.
 *
 * `getTemporaryFolder()` is kept as a fallback:
 * which of them exists has varied between UXP releases, and the failure to
 * place an image is otherwise reported as Photoshop declining the operation for
 * no visible reason.
 */
var STAGING_ROOTS = ['plugin-temp:/', 'plugin-data:/'];

function stagingRoot(root) {
  if (root && root !== 'temp') return Promise.resolve([root]);
  return Promise.resolve(STAGING_ROOTS.slice());
}

function stageEntry(extension, root) {
  var name =
    'ai-studio-' +
    Date.now() +
    '-' +
    Math.floor(Math.random() * 0xffffff).toString(36) +
    (extension || '');
  return stagingRoot(root).then(function (prefixes) {
    var failures = [];
    var attempt = function (index) {
      if (index >= prefixes.length) {
        throw StudioError(
          'STEP_FAILED',
          'UXP refused to create a file in every staging directory it was offered (' +
            (failures.join('; ') || 'none') + ').',
          { recoverable: true },
        );
      }
      var url = prefixes[index] + name;
      return fs
        .createEntryWithUrl(url, { overwrite: true })
        .then(function (created) {
          if (!created) throw new Error('no entry returned');
          // `createEntryWithUrl` hands back a metadata wrapper that Photoshop's
          // saveAs accepts but `fs.createSessionToken` rejects with "Parameter must
          // be a valid entry" — which is why the entry is re-read.
          return fs
            .getEntryWithUrl(url)
            .catch(function () {
              return created;
            })
            .then(function (entry) {
              return { entry: entry, fileName: name, nativePath: entry.nativePath || created.nativePath };
            });
        })
        .catch(function (err) {
          failures.push(prefixes[index] + ': ' + ((err && err.message) || String(err)));
          return attempt(index + 1);
        });
    };
    return attempt(0);
  });
}

function entryForWriting(path, overwrite, config) {
  var absolute = resolveInWorkspace(path, config);
  // Extension only, never a path fragment: `slice(slash)` rather than
  // `slice(slash + 1)` produced "/probe.psd", which made UXP look for a
  // *sub-folder* named after the staged file.
  var fileName = absolute.slice(absolute.lastIndexOf('/') + 1);
  var dot = fileName.lastIndexOf('.');
  var extension = dot > 0 ? fileName.slice(dot) : '';
  // Anything but a plain extension would let a crafted name escape the
  // staging folder, which is the one place no permission check applies.
  if (!/^\.[A-Za-z0-9]{1,8}$/.test(extension)) extension = '';
  // `plugin-data:/` specifically, not the fallbacks: the server copies the file
  // out by its reported `nativePath`, and only this prefix has been verified to
  // resolve to a path that process can actually read.
  return stageEntry(extension, 'plugin-data:/').then(function (staged) {
    return {
      entry: staged.entry,
      staged: { nativePath: staged.nativePath, fileName: staged.fileName },
      requestedPath: absolute,
    };
  });
}

/**
 * Writes image bytes the server sent over the bridge into the plugin sandbox.
 *
 * This is the only way an image reaches Photoshop. `placeEvent` — the obvious
 * tool — refuses a file from the sandbox on Photoshop 26.11 / UXP 9.0.2 ("The
 * user cancelled the operation") for every descriptor variant, while the
 * sandbox is the one place the plugin may write without a permission grant.
 * So the bytes go to `plugin-data:/` and Photoshop is asked to *open* them.
 *
 * @param payload `{ fileName, base64 }`
 */
function materialize(payload) {
  var fileName = String(payload.fileName || 'input.png');
  var extension = '';
  var dot = fileName.lastIndexOf('.');
  if (dot > 0 && /^\.[A-Za-z0-9]{1,8}$/.test(fileName.slice(dot))) extension = fileName.slice(dot);

  return stageEntry(extension, 'plugin-data:/').then(function (staged) {
    return Promise.resolve(staged.entry.write(base64ToBytes(payload.base64 || ''), { format: storage.formats.binary }))
      .then(function () {
        // Re-read so the entry Photoshop opens is a live one bound to the bytes
        // just written; the object `createEntryWithUrl` returned is only metadata.
        return fs
          .getEntryWithUrl('plugin-data:/' + staged.fileName)
          .catch(function () {
            return staged.entry;
          })
          .then(function (entry) {
            return { entry: entry, fileName: staged.fileName, nativePath: entry.nativePath };
          });
      });
  });
}

/**
 * Opens an image entry as a document.
 *
 * The counterpart to `placeEvent`, and the one that works: a sandboxed entry
 * opens as a document, from which layers can be copied.
 */
function openDocument(entry, name) {
  var photoshop = require('photoshop');
  return photoshop.app.open(entry).then(
    function (doc) {
      if (!doc) {
        throw StudioError('STEP_FAILED', 'Photoshop could not open the image ' + (name || '') + '.', {
          recoverable: true,
        });
      }
      return doc;
    },
    function (err) {
      throw StudioError(
        'STEP_FAILED',
        'Photoshop refused to open the image' + (name ? ' "' + name + '"' : '') + ': ' + ((err && err.message) || String(err)),
        { recoverable: true },
      );
    },
  );
}

/** Closes a scratch document without touching the user's disk. */
function closeScratchDocument(doc) {
  if (!doc) return Promise.resolve();
  try {
    return Promise.resolve(doc.closeWithoutSaving()).catch(function () {
      return undefined;
    });
  } catch (err) {
    return Promise.resolve();
  }
}

function base64ToBytes(text) {
  var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
  var out = new Uint8Array(Math.floor((clean.length / 4) * 3));
  var position = 0;
  for (var i = 0; i < clean.length; i += 4) {
    var a = B64.indexOf(clean.charAt(i));
    var b = B64.indexOf(clean.charAt(i + 1));
    var c = clean.charAt(i + 2) === '=' ? 0 : B64.indexOf(clean.charAt(i + 2));
    var d = clean.charAt(i + 3) === '=' ? 0 : B64.indexOf(clean.charAt(i + 3));
    if (position < out.length) out[position++] = (a << 2) | (b >> 4);
    if (position < out.length) out[position++] = ((b << 4) | (c >> 2)) & 0xff;
    if (position < out.length) out[position++] = ((c << 6) | d) & 0xff;
  }
  return out.subarray(0, position);
}

/**
 * The folder the user has granted this plugin access to, if any.
 *
 * UXP cannot read or write a caller-chosen path: `localFileSystem: "request"`
 * grants a folder the *user* picks, once, for the session. Until that happens
 * `getEntryWithUrl('file:///...')` answers "Could not find an entry" for a file
 * that plainly exists on disk, which reads like a bug rather than a permission.
 *
 * @see requestWorkspaceGrant for obtaining it.
 */
var grantedFolder = null;

function normalizeNative(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
}

/**
 * Shows the folder picker and records the grant.
 *
 * Must be called from a user gesture — a panel button — because UXP requires
 * one. The chosen folder must be the configured workspace root: a grant for
 * somewhere else would silently defeat the allow-list both sides agree on.
 */
function requestWorkspaceGrant(config) {
  var root = normalizeNative(config && config.workspaceRoot);
  if (!root) {
    throw StudioError('STEP_FAILED', 'No workspaceRoot is configured in config.json.', { recoverable: false });
  }
  if (grantedFolder && grantedFolder.root === root) {
    return Promise.resolve(grantedFolder.folder);
  }
  return fs.getFolder().then(function (folder) {
    if (!folder) {
      throw StudioError('WORKSPACE_NOT_GRANTED', 'Workspace access was not granted.', { recoverable: true });
    }
    var native = normalizeNative(folder.nativePath);
    if (native.toLowerCase() !== root.toLowerCase()) {
      grantedFolder = null;
      throw StudioError(
        'WORKSPACE_NOT_GRANTED',
        'You granted "' + native + '", but this plugin is configured for "' + root +
          '". Grant the configured workspace folder.',
        { recoverable: true, details: { granted: native, configured: root } },
      );
    }
    grantedFolder = { root: root, folder: folder };
    return folder;
  });
}

/** The granted folder, or `null` when the user has not granted one yet. */
function currentWorkspaceGrant(config) {
  var root = normalizeNative(config && config.workspaceRoot);
  if (grantedFolder && grantedFolder.root.toLowerCase() === root.toLowerCase()) {
    return grantedFolder.folder;
  }
  return null;
}

function forgetWorkspaceGrant() {
  grantedFolder = null;
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

/**
 * Coerces a value read from the Photoshop DOM to a number.
 *
 * The UXP DOM does not type its numeric properties consistently: `bitsPerChannel`
 * comes back as the string "8", and a bounds edge can arrive unit-suffixed on
 * some builds. Passing those straight through fails schema validation in the MCP
 * server — which is correct behaviour on its side, and a plugin bug on this one.
 * Coerce here, once, rather than loosening the shared schema.
 */
function num(value, fallback) {
  var parsed = typeof value === 'number' ? value : parseFloat(value);
  return isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals) {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  var factor = Math.pow(10, decimals || 0);
  return Math.round(value * factor) / factor;
}

module.exports = {
  materialize: materialize,
  openDocument: openDocument,
  closeScratchDocument: closeScratchDocument,
  base64ToBytes: base64ToBytes,
  requestWorkspaceGrant: requestWorkspaceGrant,
  currentWorkspaceGrant: currentWorkspaceGrant,
  forgetWorkspaceGrant: forgetWorkspaceGrant,
  stageEntry: stageEntry,
  entryForWriting: entryForWriting,
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
  layerObjects: layerObjects,
  layerInfo: layerInfo,
  mapLayerKind: mapLayerKind,
  resolveCreatedLayer: resolveCreatedLayer,
  BATCH_TIMEOUT_MS: BATCH_TIMEOUT_MS,
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
  resolveInWorkspace: resolveInWorkspace,
  toFileUrl: toFileUrl,
  toBase64: toBase64,
  toByteArray: toByteArray,
  round: round,
  num: num,
  logLayerKindEnum: logLayerKindEnum,

  Logger: Logger,
  StudioError: StudioError,
};
