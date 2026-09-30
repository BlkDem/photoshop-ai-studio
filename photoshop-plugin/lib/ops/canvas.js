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
  var doc = ps.resolveDocument(ctx.params.documentId);
  var info = ps.documentInfo(doc);
  info.layers = ps.flattenLayers(doc.layers);
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
      fill: params.background === 'background' ? 'background' : params.background === 'transparent' ? 'transparent' : 'white',
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
 * `crop_document` — discards everything outside the given rectangle.
 *
 * There is no working implementation of this on Photoshop 26.11 / UXP 9.0.2.
 * Every form of the `crop` descriptor was tried — `ordinal/targetEnum` and
 * `_id`, with and without `_options`, with and without pixel units — and each
 * was refused with a modal program error, or left the bridge waiting until the
 * watchdog fired. ExtendScript performs the same crop happily through COM, so
 * this is a UXP gap rather than a document problem.
 *
 * Saying so is better than letting Photoshop answer "The user cancelled the
 * operation", which sends the planner off to repair a cancellation that nobody
 * performed. `resize_canvas` covers the common intent — changing the canvas
 * while keeping content — and works.
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

  throw StudioError(
    'UNSUPPORTED_OPERATION',
    'This Photoshop build refuses every form of the crop command, so pixels cannot be discarded. ' +
      'Use resize_canvas to change the canvas while keeping content.',
    { recoverable: false, details: { document: doc.name, crop: { x: x, y: y, width: w, height: h } } },
  );
}



module.exports = {
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
};
