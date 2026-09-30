/**
 * Image + export operations.
 *
 * Two notes on the Photoshop API surface that shaped this file:
 *
 *  - **`document.exportDocument` does not exist in UXP.** It is an ExtendScript
 *    method. The UXP equivalent is `document.saveAs.<format>(entry, options, asCopy)`
 *    — an *object of functions*, not a callable method. This is why exports go
 *    through `saveAs`.
 *  - `placeEvent` needs a **session token**, not a path, for its `_path`
 *    property: `fs.createSessionToken(entry)`.
 */
'use strict';

var ps = require('../ps.js');
var StudioError = require('../errors.js').StudioError;
var layers = require('./layers.js');

/** `place_image` */
function placeImage(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;

  return ps.entryForReading(params.path, ctx.config).then(function (entry) {
    var token = ps.fs.createSessionToken(entry);

    return ps
      .batchPlay([
        {
          _obj: 'placeEvent',
          _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
          _options: { dialogOptions: 'dontDisplay' },
          freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
          _path: token,
        },
      ])
      .then(function () {
        var placed = topLayer(doc);
        if (!placed) {
          throw StudioError('STEP_FAILED', 'Photoshop placed the image but no new layer appeared.', {
            recoverable: true,
          });
        }
        if (params.name) placed.name = params.name;

        var bounds = ps.boundsOf(placed);
        if (params.fit && (params.fit.width || params.fit.height)) {
          fitLayer(placed, doc, params.fit, bounds);
        }
        var parent = ps.parentOf(doc, placed.id);
        return ps.layerInfo(placed, parent ? parent.id : null);
      });
  });
}

/** `resize_layer` */
function resizeLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);
  var params = ctx.params;
  var before = ps.boundsOf(layer);

  var factorX;
  var factorY;
  if (typeof params.scale === 'number') {
    factorX = params.scale;
    factorY = params.scale;
  } else {
    factorX = typeof params.width === 'number' && before.width > 0 ? params.width / before.width : 1;
    factorY = typeof params.height === 'number' && before.height > 0 ? params.height / before.height : 1;
  }
  if (factorX <= 0 || factorY <= 0 || factorX > 20 || factorY > 20) {
    throw StudioError('INVALID_PARAMS', 'Refusing to scale by ' + factorX + '×' + factorY + '.');
  }

  var anchor = params.anchor || 'center';
  var targetWidth = Math.max(1, Math.round(before.width * factorX));
  var targetHeight = Math.max(1, Math.round(before.height * factorY));
  var offsetX = anchorOffset(doc.width, targetWidth, anchor, 'x');
  var offsetY = anchorOffset(doc.height, targetHeight, anchor, 'y');

  layers.scaleBy(layer, factorX, factorY);
  var after = ps.boundsOf(layer);
  layers.translateBy(layer, offsetX - after.x, offsetY - after.y);

  var parent = ps.parentOf(doc, layer.id);
  return ps.layerInfo(layer, parent ? parent.id : null);
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

/** `export_png` */
function exportPng(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var path = resolveOutput(params.path, 'export.png', ctx.config);

  return withDownscale(doc, params).then(function () {
    return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (entry) {
      return doc
        .saveAs.png(
          entry,
          {
            compression: typeof params.compression === 'number' ? params.compression : 6,
            interlaced: false,
          },
          true,
        )
        .then(function () {
          return { path: path, format: 'png', overwritten: params.overwrite === true };
        });
    });
  });
}

/** `export_jpg` */
function exportJpg(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var path = resolveOutput(params.path, 'export.jpg', ctx.config);

  return withDownscale(doc, params).then(function () {
    return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (entry) {
      return doc
        .saveAs.jpg(
          entry,
          {
            quality: typeof params.quality === 'number' ? params.quality : 9,
            embedColorProfile: true,
            formatOptions: { _enum: 'formatOptions', _value: 'standardBaseline' },
          },
          true,
        )
        .then(function () {
          return { path: path, format: 'jpg', overwritten: params.overwrite === true };
        });
    });
  });
}

/** `save_psd` */
function savePsd(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var path = resolveOutput(params.path, 'document.psd', ctx.config);

  return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (entry) {
    return doc
      .saveAs.psd(entry, { layers: true, embedColorProfile: true }, params.asCopy !== false)
      .then(function () {
        return { path: path, format: 'psd', overwritten: params.overwrite === true };
      });
  });
}

/** `export_document` — dispatches on `format`. */
function exportDocument(ctx) {
  var format = ctx.params.format;
  if (format === 'png') return exportPng(ctx);
  if (format === 'jpg') return exportJpg(ctx);
  return savePsd(ctx);
}

/** `save_document` — saves in place when no path is given. */
function saveDocument(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;

  if (!params.path) {
    if (!doc.path) {
      throw StudioError('DOCUMENT_NOT_SAVED', 'This document has never been saved; give an explicit path.', {
        details: { document: doc.name },
      });
    }
    return Promise.resolve(doc.save()).then(function () {
      return { path: String(doc.path), overwritten: true };
    });
  }

  var path = resolveOutput(params.path, 'document.psd', ctx.config);
  return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (entry) {
    return doc
      .saveAs.psd(entry, { layers: true }, params.asCopy !== false)
      .then(function () {
        return { path: path, overwritten: params.overwrite === true };
      });
  });
}

/**
 * `render_preview` — a downscaled PNG for the Studio's preview pane.
 *
 * Written into the plugin temp folder rather than the workspace: it is a
 * transport payload, not a user artifact, and must never collide with an export.
 */
function renderPreview(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var maxWidth = ctx.params.maxWidth || 480;
  var scale = Math.min(1, maxWidth / Math.max(1, doc.width));
  var width = Math.max(1, Math.round(doc.width * scale));
  var height = Math.max(1, Math.round(doc.height * scale));

  return ps.fs
    .getTemporaryFolder()
    .then(function (folder) {
      var target = folder.nativePath + '/ai-studio-preview-' + Date.now() + '.png';
      var url = ps.toFileUrl(target);
      return ps.fs.createEntryWithUrl(url, { overwrite: true });
    })
    .then(function (entry) {
      return doc.saveAs.png(entry, { compression: 3 }, true).then(function () {
        return entry.read({ format: ps.formats.binary });
      });
    })
    .then(function (buffer) {
      return {
        mimeType: 'image/png',
        base64: ps.toBase64(ps.toByteArray(buffer)),
        width: width,
        height: height,
      };
    })
    .catch(function (err) {
      if (StudioError && err && err.name === 'StudioError') throw err;
      throw StudioError('EXPORT_FAILED', 'Could not render a preview: ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Temporarily scales the document when `maxWidth` asks for a downscale, then
 * restores it. `render_preview` deliberately does *not* go through this: it must
 * never mutate the user's document, not even transiently.
 */
function withDownscale(doc, params) {
  if (!params.maxWidth || params.maxWidth >= doc.width) {
    return Promise.resolve();
  }
  var originalWidth = doc.width;
  var originalHeight = doc.height;
  var targetWidth = Math.max(1, Math.round(params.maxWidth));
  var targetHeight = Math.max(1, Math.round((originalHeight / originalWidth) * targetWidth));

  return ps
    .batchPlay([
      {
        _obj: 'resizeImage',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
        width: { _unit: 'pixelsUnit', _value: targetWidth },
        height: { _unit: 'pixelsUnit', _value: targetHeight },
        _options: { dialogOptions: 'dontDisplay' },
        scaleStyle: { _enum: 'scaleStyle', _value: 'maximum' },
        interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubic' },
      },
    ])
    .then(function () {
      return ps.batchPlay([
        {
          _obj: 'resizeImage',
          _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
          width: { _unit: 'pixelsUnit', _value: originalWidth },
          height: { _unit: 'pixelsUnit', _value: originalHeight },
          _options: { dialogOptions: 'dontDisplay' },
          scaleStyle: { _enum: 'scaleStyle', _value: 'maximum' },
          interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubic' },
        },
      ]);
    });
}

/** Absolute destination inside the configured output directory. */
function resolveOutput(path, defaultName, config) {
  if (path) return path;
  var root = String(config.outputDir || config.workspaceRoot || '').replace(/[\\/]+$/, '');
  return root + '/' + defaultName;
}

function topLayer(doc) {
  var layers_ = doc.layers;
  if (!layers_ || layers_.length === 0) return null;
  return layers_[layers_.length - 1];
}

function fitLayer(layer, doc, fit, before) {
  var factorX = 1;
  var factorY = 1;
  if (fit.width && fit.height) {
    factorX = fit.width / Math.max(1, before.width);
    factorY = fit.height / Math.max(1, before.height);
  } else if (fit.width) {
    factorX = factorY = fit.width / Math.max(1, before.width);
  } else if (fit.height) {
    factorX = factorY = fit.height / Math.max(1, before.height);
  }
  layers.scaleBy(layer, factorX, factorY);
  var after = ps.boundsOf(layer);
  var anchor = fit.anchor || 'center';
  layers.translateBy(
    layer,
    anchorOffset(doc.width, after.width, anchor, 'x') - after.x,
    anchorOffset(doc.height, after.height, anchor, 'y') - after.y,
  );
}

function anchorOffset(canvas, size, anchor, axis) {
  var horizontal = axis === 'x';
  if (horizontal) {
    if (/Left$/.test(anchor)) return 0;
    if (/Right$/.test(anchor)) return canvas - size;
    return Math.round((canvas - size) / 2);
  }
  if (/^top/.test(anchor)) return 0;
  if (/^bottom/.test(anchor)) return canvas - size;
  return Math.round((canvas - size) / 2);
}

module.exports = {
  place_image: placeImage,
  resize_layer: resizeLayer,
  export_document: exportDocument,
  export_png: exportPng,
  export_jpg: exportJpg,
  save_psd: savePsd,
  save_document: saveDocument,
  render_preview: renderPreview,
};
