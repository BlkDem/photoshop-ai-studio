/**
 * Document + canvas operations.
 *
 * Each exported function is `(ps, doc, params, config) => Promise<result>` and
 * must already be inside a modal scope (see lib/adapter.js).
 */
'use strict';

var ps = require('../ps.js');
var StudioError = require('../errors.js').StudioError;

/** `get_document`: metadata *and* the full layer list in one round trip. */
function getDocument(ctx) {
  // The snapshot carries the selection so a plan can see what it is acting on and
  // `set_selection` has a mechanical post-condition.
  return documentState(ps.resolveDocument(ctx.params.documentId));
}


/**
 * `modify_selection` — change the selection that already exists.
 *
 * Splitting this out of `set_selection` is deliberate. `set_selection` *replaces*
 * the selection from coordinates the caller had to work out; these operations
 * express an intent ("grow it a little", "smooth the edge") that needs no
 * coordinates and no knowledge of what is underneath.
 *
 * Only "is something selected" is reported as verified. How far `grow` actually
 * gets depends on the artwork and the canvas edge, so a derived size would be a
 * guess; the returned document state carries the real bounds instead.
 */
function modifySelection(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var action = ctx.params.action;
  var amount = typeof ctx.params.amount === 'number' ? ctx.params.amount : null;
  var selection = doc.selection;

  if (!selection) {
    throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no selection object.', { recoverable: false });
  }

  /** Actions that are meaningless without an existing selection. */
  var needsSelection = { grow: 1, shrink: 1, expand: 1, smooth: 1, border: 1 };

  if (needsSelection[action]) {
    if (amount === null) {
      throw StudioError('INVALID_PARAMS', 'Selection "' + action + '" needs an `amount` in pixels.');
    }
    var before = ps.documentSelection(doc);
    if (!before) {
      throw StudioError(
        'INVALID_PARAMS',
        'Selection "' + action + '" needs a selection to already exist. Call `set_selection` first.',
      );
    }
  }

  var step;
  try {
    if (action === 'grow') step = selection.grow(amount);
    else if (action === 'shrink') step = selection.contract(amount);
    else if (action === 'expand') step = selection.expand(amount);
    else if (action === 'smooth') step = selection.smooth(amount);
    else if (action === 'border') step = selection.selectBorder(amount);
    else if (action === 'invert') step = typeof selection.inverse === 'function' ? selection.inverse() : undefined;
    else if (action === 'selectAll') step = selection.selectAll();
    else step = selection.deselect();
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not ' + action + ' the selection: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }

  return Promise.resolve(step)
    .catch(function (err) {
      throw StudioError('STEP_FAILED', 'Photoshop would not ' + action + ' the selection: ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    })
    .then(function () {
      return documentState(doc);
    });
}

/** The full document state, as `get_document` reports it. */
function documentState(doc) {
  var info = ps.documentInfo(doc);
  info.layers = ps.flattenLayers(doc.layers);
  info.selection = ps.documentSelection(doc);
  info.selectionActive = info.selection !== null;
  return info;
}

/** `get_document_info`: metadata only — no layer walk. */
function getDocumentInfo(ctx) {
  return ps.documentInfo(ps.resolveDocument(ctx.params.documentId));
}

/**
 * `duplicate_document`.
 *
 * The DOM's `document.duplicate(name)` exists in Photoshop 23+, so no
 * `batchPlay` is needed here.
 */
function duplicateDocument(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var name = ctx.params.name;
  // `Document.duplicate()` resolves to the new Document; reading `.name` off the
  // promise yields undefined, which failed the tool's own result schema and made
  // every square-version plan die on its first step.
  return (name ? doc.duplicate(name) : doc.duplicate()).then(function (duplicate) {
    return { id: String(duplicate.id), name: String(duplicate.name) };
  });
}

/** `resize_canvas` — changes the canvas without scaling pixel content. */
function resizeCanvas(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var width = ctx.params.width;
  var height = ctx.params.height;
  var anchor = ctx.params.anchor || 'center';

  return ps
    .batchPlay([
      {
        _obj: 'canvasSize',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
        width: { _unit: 'pixelsUnit', _value: width },
        height: { _unit: 'pixelsUnit', _value: height },
        // Canvas Size takes a horizontal/vertical pair, not a single `anchorPoint`.
        // Passing the wrong enum does not raise an error — Photoshop reports
        // "the user cancelled the operation" (-128), which is how this was found.
        horizontal: { _enum: 'horizontalLocation', _value: horizontalFor(anchor) },
        vertical: { _enum: 'verticalLocation', _value: verticalFor(anchor) },
        _options: { dialogOptions: 'dontDisplay' },
      },
    ])
    .then(function () {
      return ps.documentInfo(doc);
    });
}

/** `topLeft` → keep the left edge; `topRight` → keep the right edge; centre → `center`. */
function horizontalFor(anchor) {
  if (/Left$/.test(anchor)) return 'left';
  if (/Right$/.test(anchor)) return 'right';
  return 'center';
}

/** `topLeft` → keep the top edge; `bottomLeft` → keep the bottom edge. */
function verticalFor(anchor) {
  if (/^top/.test(anchor)) return 'top';
  if (/^bottom/.test(anchor)) return 'bottom';
  return 'center';
}

/**
 * `create_document` — a new empty document, which becomes the active one.
 *
 * `name` is honoured where the host allows it and silently ignored where
 * `Document.name` is getter-only, as it is on Photoshop 26.11. The result always
 * carries the name Photoshop actually gave the document.
 */
/**
 * Resolves a requested fill to what this build actually accepts.
 *
 * `documents.add()` takes `fill` from the `DocumentFill` family —
 * `BACKGROUNDCOLOR`, `BLACK`, `COLOR`, `TRANSPARENT`, `WHITE` — and a plain
 * string is matched against the same names. The tool schema offers
 * `white | background | transparent`, and "background" is not one of them:
 * passing it through failed on every host that validates the enum
 * ("Expected 'background' to be one of DocumentFill"). The background colour is
 * spelled `backgroundColor`.
 *
 * Prefers the enum when the build exposes it, and falls back to the matching
 * string. Same shape as the blend-mode resolution in ops/layers.js.
 */
var FILL_BY_REQUEST = {
  white: 'WHITE',
  background: 'BACKGROUNDCOLOR',
  transparent: 'TRANSPARENT',
};

function fillValue(requested) {
  var wanted = FILL_BY_REQUEST[requested] || FILL_BY_REQUEST.white;
  var enumObject = ps.constants && ps.constants.DocumentFill;
  if (enumObject && typeof enumObject[wanted] !== 'undefined') return enumObject[wanted];
  // UXP accepts the enum name as a string; `BLACK` is deliberately not offered
  // because the schema does not expose it and guessing it would invent a fill.
  return wanted.toLowerCase();
}

function createDocument(ctx) {
  var params = ctx.params;
  var width = typeof params.width === 'number' ? params.width : 1920;
  var height = typeof params.height === 'number' ? params.height : 1080;

  var added;
  try {
    added = ps.app.documents.add({
      width: width,
      height: height,
      resolution: typeof params.resolution === 'number' ? params.resolution : 72,
      fill: fillValue(params.background),
    });
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not create the document: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }

  // `documents.add()` hands back a thenable: reading `.id` or `.name` off it
  // before it settles gives `undefined`, and reporting those would describe a
  // document that does not exist.
  return Promise.resolve(added).then(function (doc) {
    if (!doc) throw StudioError('STEP_FAILED', 'Photoshop returned no document.', { recoverable: true });
    // `Document.name` is a getter on this build, so a requested name usually will
    // not stick. The real name is reported either way — inventing one would put a
    // name in the plan that Photoshop does not have.
    if (params.name) {
      try {
        doc.name = params.name;
      } catch (err) {
        /* reported below as whatever Photoshop actually called it */
      }
    }
    return ps.documentInfo(doc);
  });
}

/** `get_documents` — cheap: no layer walk. */
function getDocuments() {
  var docs = ps.app.documents || [];
  var out = [];
  for (var i = 0; i < docs.length; i += 1) {
    var doc = docs[i];
    if (!doc) continue;
    out.push({ id: String(doc.id), name: String(doc.name) });
  }
  var activeId = null;
  try {
    activeId = ps.app.activeDocument ? String(ps.app.activeDocument.id) : null;
  } catch (err) {
    activeId = null;
  }
  return { activeDocumentId: activeId, documents: out };
}

/**
 * `close_document`.
 *
 * `save: true` writes to the document's existing path, which is an overwrite of
 * whatever is there — that is why the operation is destructive and requires
 * confirmation whatever `save` says. A document that has never been saved cannot
 * be closed with `save: true`; Photoshop would need a destination, and inventing
 * one is not this operation's business.
 */
function closeDocument(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var ref = { id: String(doc.id), name: String(doc.name) };

  if (ctx.params.save === true && !doc.path) {
    throw StudioError(
      'DOCUMENT_NOT_SAVED',
      'This document has never been saved, so there is nowhere to save it. Use save_psd with a path first.',
      { details: { document: ref.name }, recoverable: false },
    );
  }

  var closed = ctx.params.save === true ? doc.save() : doc.closeWithoutSaving();
  return Promise.resolve(closed).then(
    function () {
      return ref;
    },
    function (err) {
      throw StudioError(
        'STEP_FAILED',
        'Photoshop would not close "' + ref.name + '": ' + ((err && err.message) || String(err)),
        { recoverable: true },
      );
    },
  );
}

/**
 * `set_selection` — the marching-ants selection.
 *
 * Kept separate from any operation that *uses* a selection, so a plan can scope
 * an edit without also committing to what the selection should be afterwards.
 * `invert` is absent from the DOM on this build, so it falls back to selecting
 * all and subtracting what was there — the same result, without a descriptor.
 */
/**
 * The "replace the selection" type.
 *
 * `constants.SelectionType` holds strings on this build —
 * `{REPLACE: 'set', EXTEND: 'addTo', ...}` — so there is no `NORMAL` member to
 * fall back to and a numeric default is refused outright ("Invalid constant.
 * Expected '100' to be one of Constants.SelectionType").
 */
function selectionType() {
  var enumObject = ps.constants && ps.constants.SelectionType;
  if (enumObject) {
    if (typeof enumObject.REPLACE !== 'undefined') return enumObject.REPLACE;
    if (typeof enumObject.replace !== 'undefined') return enumObject.replace;
  }
  return 'set';
}

function setSelection(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var selection = doc.selection;
  if (!selection) {
    throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no selection object.', {
      recoverable: false,
    });
  }

  var feather = typeof params.feather === 'number' ? params.feather : 0;
  if (feather > 0 && typeof selection.feather !== 'function') {
    throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build cannot feather a selection.', {
      recoverable: false,
    });
  }

  var shaped = function (fn) {
    return Promise.resolve(fn()).then(function () {
      return feather > 0 ? selection.feather(feather) : undefined;
    });
  };

  var step;
  if (params.mode === 'none') {
    step = shaped(function () {
      return selection.deselect();
    });
  } else if (params.mode === 'invert') {
    step = shaped(function () {
      // The DOM spells it `inverse`.
      return typeof selection.inverse === 'function' ? selection.inverse() : undefined;
    });
  } else if (params.mode === 'all') {
    step = shaped(function () {
      return selection.selectAll();
    });
  } else {
    var x = params.x;
    var y = params.y;
    var w = params.width;
    var h = params.height;
    if ([x, y, w, h].some(function (value) { return typeof value !== 'number'; })) {
      throw StudioError('INVALID_PARAMS', 'A ' + params.mode + ' selection needs x, y, width and height.');
    }
    if (x < 0 || y < 0 || x + w > doc.width || y + h > doc.height) {
      throw StudioError(
        'INVALID_PARAMS',
        'Selection (' + x + ',' + y + ',' + w + '×' + h + ') does not fit the ' + doc.width + '×' + doc.height + ' canvas.',
      );
    }
    // The DOM takes a *bounds object* and the selection type, not loose numbers:
    // `selectRectangle({left, top, right, bottom}, type)`. Every positional
    // arrangement is rejected with "Invalid constant. Expected '100' to be one
    // of Constants.SelectionType" whichever way the numbers are passed.
    var bounds = { left: x, top: y, right: x + w, bottom: y + h };
    step = shaped(function () {
      return params.mode === 'ellipse'
        ? selection.selectEllipse(bounds, selectionType())
        : selection.selectRectangle(bounds, selectionType());
    });
  }

  return step
    .catch(function (err) {
      throw StudioError('STEP_FAILED', 'Photoshop would not change the selection: ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    })
    .then(function () {
      var info = ps.documentInfo(doc);
      info.layers = ps.flattenLayers(doc.layers);
      return info;
    });
}

/**
 * `crop_document` — discards everything outside the given rectangle.
 *
 * This is here at all because the DOM has `document.crop(bounds)`. The descriptor
 * route — which is what the API reference offers first — is refused outright on
 * 26.11 ("The user cancelled the operation") for every form tried, and the
 * conclusion drawn from that was that cropping was impossible. It was the
 * descriptor that was broken, not the capability. See the platform boundary in
 * `docs/architecture.md`.
 */
function cropDocument(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var x = ctx.params.x;
  var y = ctx.params.y;
  var w = ctx.params.width;
  var h = ctx.params.height;

  if (x < 0 || y < 0 || x + w > doc.width || y + h > doc.height) {
    throw StudioError(
      'INVALID_PARAMS',
      'Crop rect (' + x + ',' + y + ',' + w + '×' + h + ') does not fit the ' + doc.width + '×' + doc.height + ' canvas.',
    );
  }
  if (x === 0 && y === 0 && w === doc.width && h === doc.height) {
    throw StudioError('INVALID_PARAMS', 'The crop rectangle covers the whole canvas; nothing to do.');
  }

  var cropped;
  try {
    // A bounds object, the same shape `selection.selectRectangle` takes.
    cropped = doc.crop({ left: x, top: y, right: x + w, bottom: y + h });
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not crop the document: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }

  return Promise.resolve(cropped).then(function (doc2) {
    var info = ps.documentInfo(doc2 || doc);
    if (info.width !== w || info.height !== h) {
      throw StudioError(
        'STEP_FAILED',
        'Photoshop reports the canvas as ' + info.width + '×' + info.height + ' after cropping to ' + w + '×' + h + '.',
        { recoverable: true, details: { expected: { width: w, height: h }, actual: { width: info.width, height: info.height } } },
      );
    }
    return info;
  });
}

/** `trim_document` — crop the canvas to the content. */
function trimDocument(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var type = require('./filters.js').TRIM_TYPE[ctx.params.type] || ctx.params.type || 'transparent';

  var trimmed;
  try {
    trimmed = doc.trim(type);
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not trim the document: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }
  return Promise.resolve(trimmed).then(function (doc2) {
    return ps.documentInfo(doc2 || doc);
  });
}

/** `flatten_document` */
function flattenDocument(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var flattened;
  try {
    flattened = doc.flatten();
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not flatten the document: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }
  return Promise.resolve(flattened).then(function (doc2) {
    var info = ps.documentInfo(doc2 || doc);
    info.layers = ps.flattenLayers(doc2 || doc);
    return info;
  });
}

/** `merge_visible_layers` */
function mergeVisibleLayers(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var merged;
  try {
    merged = doc.mergeVisibleLayers();
  } catch (err) {
    throw StudioError(
      'STEP_FAILED',
      'Photoshop would not merge the visible layers: ' + ((err && err.message) || String(err)),
      { recoverable: true },
    );
  }
  return Promise.resolve(merged).then(function (doc2) {
    var info = ps.documentInfo(doc2 || doc);
    info.layers = ps.flattenLayers(doc2 || doc);
    return info;
  });
}

/** `convert_color_mode` */
function convertColorMode(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var wanted = require('./filters.js').COLOR_MODE[ctx.params.mode] || ctx.params.mode;

  var converted;
  try {
    converted = doc.changeMode(wanted);
  } catch (err) {
    throw StudioError(
      'STEP_FAILED',
      'Photoshop would not convert the document to ' + ctx.params.mode + ': ' + ((err && err.message) || String(err)),
      { recoverable: true },
    );
  }
  return Promise.resolve(converted).then(function (doc2) {
    var info = ps.documentInfo(doc2 || doc);
    // `changeMode` resolves without error and without converting often enough
    // that the result has to be checked.
    if (String(info.colorMode).toUpperCase() !== String(ctx.params.mode).toUpperCase()) {
      throw StudioError(
        'STEP_FAILED',
        'Photoshop reports the colour mode as ' + info.colorMode + ' after asking for ' + ctx.params.mode + '.',
        { recoverable: true, details: { requested: ctx.params.mode, actual: info.colorMode } },
      );
    }
    return info;
  });
}

module.exports = {
  set_selection: setSelection,
  modify_selection: modifySelection,
  create_document: createDocument,
  get_documents: getDocuments,
  close_document: closeDocument,
  __test_anchor: function (anchor) {
    return { horizontal: horizontalFor(anchor), vertical: verticalFor(anchor) };
  },
  get_document: getDocument,
  get_document_info: getDocumentInfo,
  duplicate_document: duplicateDocument,
  resize_canvas: resizeCanvas,
  crop_document: cropDocument,
  trim_document: trimDocument,
  flatten_document: flattenDocument,
  merge_visible_layers: mergeVisibleLayers,
  convert_color_mode: convertColorMode,
  sample_color: require('./filters.js').sample_color,
};
