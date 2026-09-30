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
  var duplicate = name ? doc.duplicate(name) : doc.duplicate();
  return { id: String(duplicate.id), name: duplicate.name };
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
        relative: { _enum: 'anchorPoint', _value: anchor },
        _options: { dialogOptions: 'dontDisplay' },
      },
    ])
    .then(function () {
      return ps.documentInfo(doc);
    });
}

/**
 * `crop_document` — the rect is absolute document pixels.
 *
 * `crop` keeps the region *outside* the given bounds, so the descriptor asks
 * Photoshop to crop to the complement by listing the four outside edges.
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

  var descriptor = {
    _obj: 'crop',
    _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
    _options: { dialogOptions: 'dontDisplay' },
  };
  if (x > 0) descriptor.left = { _unit: 'pixelsUnit', _value: x };
  if (y > 0) descriptor.top = { _unit: 'pixelsUnit', _value: y };
  if (x + w < doc.width) descriptor.right = { _unit: 'pixelsUnit', _value: doc.width - (x + w) };
  if (y + h < doc.height) descriptor.bottom = { _unit: 'pixelsUnit', _value: doc.height - (y + h) };

  if (!descriptor.left && !descriptor.top && !descriptor.right && !descriptor.bottom) {
    throw StudioError('INVALID_PARAMS', 'The crop rectangle covers the whole canvas; nothing to do.');
  }

  return ps.batchPlay([descriptor]).then(function () {
    return ps.documentInfo(doc);
  });
}

module.exports = {
  get_document: getDocument,
  get_document_info: getDocumentInfo,
  duplicate_document: duplicateDocument,
  resize_canvas: resizeCanvas,
  crop_document: cropDocument,
};
