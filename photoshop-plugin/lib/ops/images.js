/**
 * Image + export operations.
 *
 * Two notes on the Photoshop API surface that shaped this file:
 *
 *  - **`document.exportDocument` does not exist in UXP.** It is an ExtendScript
 *    method. The UXP equivalent is `document.saveAs.<format>(entry, options, asCopy)`
 *    — an *object of functions*, not a callable method. This is why exports go
 *    through `saveAs`.
 *  - **`document.exportDocument` does not exist in UXP.** It is an ExtendScript
 *    method. The UXP equivalent is `document.saveAs.<format>(entry, options,
 *    asCopy)` — an *object of functions*, not a callable method. This is why
 *    exports go through `saveAs`, `ps.entryForWriting`, and the plugin's own
 *    staging folder.
 *  - There is no working `placeEvent`: it refuses a file from the plugin
 *    sandbox. `place_image` opens the image as a document and copies its layers
 *    instead — see `placeInto`.
 */
'use strict';

var ps = require('../ps.js');
var StudioError = require('../errors.js').StudioError;
var layers = require('./layers.js');

/** `place_image` */
function placeImage(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;

  return openSource(params, ctx.config).then(function (source) {
    return placeInto(doc, source).then(function (placed) {
      if (params.name) placed.name = params.name;

      var bounds = ps.boundsOf(placed);
      var fitted = params.fit && (params.fit.width || params.fit.height)
        ? fitLayer(placed, doc, params.fit, bounds)
        : Promise.resolve();
      return fitted.then(function () {
        var parent = ps.parentOf(doc, placed.id);
        return ps.layerInfo(placed, parent ? parent.id : null);
      });
    });
  });
}

/**
 * Copies an image's layers into the target document.
 *
 * `placeEvent` is the descriptor to reach for first, and it does not work here:
 * on Photoshop 26.11 / UXP 9.0.2 it answers "The user cancelled the operation"
 * for a file in the plugin sandbox — the only place a plugin may write without
 * a permission grant — for every descriptor variant tried. Opening the image as
 * a scratch document and copying its layers does work.
 *
 * The scratch document is closed on both paths, so a failure never leaves the
 * user with a stray window and a half-finished operation.
 */
function placeInto(doc, source) {
  var scratch;
  var settled = function (fn) {
    return function (value) {
      return ps.closeScratchDocument(scratch).then(function () {
        return fn(value);
      });
    };
  };

  return ps
    .openDocument(source.entry, source.fileName)
    .then(function (opened) {
      scratch = opened;
      var layers = ps.layerObjects(opened);
      if (!layers.length) {
        // `app.open` can resolve before the DOM exposes the layer collection,
        // so this is worth retrying once rather than reporting a phantom
        // "no layers" for an image that plainly has one.
        return new Promise(function (resolve) {
          setTimeout(resolve, 250);
        })
          .then(function () {
            return ps.layerObjects(opened);
          })
          .then(function (retry) {
            if (!retry.length) {
              throw StudioError(
                'STEP_FAILED',
                'The image opened but reported no layers (name=' + opened.name + ', layers=' +
                  ((opened.layers && opened.layers.length) || 0) + ').',
                { recoverable: true },
              );
            }
            return retry;
          });
      }
      // Bottom to top, so the image's topmost layer ends up topmost here too.
      return layers.reduce(function (chain, layer) {
        return chain.then(function () {
          return layer.copy().then(function () {
            return doc.paste();
          });
        });
      }, Promise.resolve())
        .then(function (pasted) {
          // `Document.paste()` resolves to the new layer on some builds and to
          // nothing on others, where the paste simply becomes the active layer.
          if (pasted) return pasted;
          var active = doc.activeLayers;
          return (active && active[0]) || null;
        });
    })
    .then(
      settled(function (pasted) {
        if (!pasted) {
          throw StudioError('STEP_FAILED', 'Photoshop pasted no layer for the image.', { recoverable: true });
        }
        return centreOnCanvas(doc, pasted).then(function () {
          return pasted;
        });
      }),
      settled(function (err) {
        throw err;
      }),
    );
}

/** Pasting lands in the middle of the canvas; the API contract reports a position. */
function centreOnCanvas(doc, layer) {
  if (!layer) return Promise.resolve();
  var bounds = ps.boundsOf(layer);
  return layers.translateBy(
    layer,
    Math.round(doc.width / 2 - (bounds.x + bounds.width / 2)),
    Math.round(doc.height / 2 - (bounds.y + bounds.height / 2)),
  );
}

/**
 * Resolves the image to place.
 *
 * The bytes the server sent over the bridge are the normal path: the plugin's
 * sandbox cannot open a workspace file without a grant the user approves in the
 * panel, and an AI-driven plan should not be able to summon a file picker. A
 * granted workspace is still preferred when one exists, since it skips staging
 * a copy of every image.
 */
function openSource(params, config) {
  if (typeof params.path === 'string' && params.path && ps.currentWorkspaceGrant(config)) {
    return ps.entryForReading(params.path, config).then(function (entry) {
      return { entry: entry, fileName: params.path };
    });
  }
  var named = typeof params.path === 'string' && params.path;
  if (!params.data || !params.data.base64) {
    throw StudioError(
      named ? 'WORKSPACE_NOT_GRANTED' : 'INVALID_PARAMS',
      named
        ? 'This image has to be sent over the bridge because Photoshop has not granted access to the workspace.'
        : 'place_image needs the path of an image in the workspace.',
      { recoverable: true, details: { requested: params.path } },
    );
  }
  return ps
    .materialize({ fileName: params.data.fileName || 'input.png', base64: params.data.base64 })
    .then(function (staged) {
      return { entry: staged.entry, fileName: staged.fileName };
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

  // Awaited in order: reading the bounds before the scale settles reports the
  // old size, which then anchors the translate in the wrong place.
  return layers
    .scaleBy(layer, factorX, factorY)
    .then(function () {
      var after = ps.boundsOf(layer);
      return layers.translateBy(layer, offsetX - after.x, offsetY - after.y);
    })
    .then(function () {
      var parent = ps.parentOf(doc, layer.id);
      return ps.layerInfo(layer, parent ? parent.id : null);
    });
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
    return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (staged) {
      var entry = staged.entry;
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
          return { path: path, format: 'png', overwritten: params.overwrite === true, staged: staged.staged };
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
    return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (staged) {
      var entry = staged.entry;
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
          return { path: path, format: 'jpg', overwritten: params.overwrite === true, staged: staged.staged };
        });
    });
  });
}

/** `save_psd` */
function savePsd(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var path = resolveOutput(params.path, 'document.psd', ctx.config);

  return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (staged) {
    var entry = staged.entry;
    return doc
      .saveAs.psd(entry, { layers: true, embedColorProfile: true }, params.asCopy !== false)
      .then(function () {
        return { path: path, format: 'psd', overwritten: params.overwrite === true, staged: staged.staged };
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
  return ps.entryForWriting(path, params.overwrite, ctx.config).then(function (staged) {
    var entry = staged.entry;
    return doc
      .saveAs.psd(entry, { layers: true }, params.asCopy !== false)
      .then(function () {
        return { path: path, overwritten: params.overwrite === true, staged: staged.staged };
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

  // Staged through the shared helper rather than `getTemporaryFolder()`: that
  // folder's `nativePath` is inside the virtual plugin storage, and
  // `createEntryWithUrl` on it answers "failed to get the parent folder" — a
  // preview is transport payload, so it goes to `plugin-data:/` and straight
  // back over the wire.
  return ps
    .stageEntry('.png', 'plugin-data:/')
    .then(function (staged) {
      return doc.saveAs.png(staged.entry, { compression: 3 }, true).then(function () {
        return staged.entry.read({ format: ps.formats.binary });
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
  return layers.scaleBy(layer, factorX, factorY).then(function () {
    var after = ps.boundsOf(layer);
    var anchor = fit.anchor || 'center';
    return layers.translateBy(
      layer,
      anchorOffset(doc.width, after.width, anchor, 'x') - after.x,
      anchorOffset(doc.height, after.height, anchor, 'y') - after.y,
    );
  });
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
