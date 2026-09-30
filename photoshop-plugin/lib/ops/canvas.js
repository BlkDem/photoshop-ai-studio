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
  __test_anchor: function (anchor) {
    return { horizontal: horizontalFor(anchor), vertical: verticalFor(anchor) };
  },
  get_document: getDocument,
  get_document_info: getDocumentInfo,
  duplicate_document: duplicateDocument,
  resize_canvas: resizeCanvas,
  crop_document: cropDocument,
};
