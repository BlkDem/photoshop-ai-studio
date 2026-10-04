/**
 * `paint_gradient` — a colour ramp, rasterized as flat bands.
 *
 * Photoshop has a native gradient fill and it is not reachable from UXP here:
 * there is no adjustment-layer API in this host, and the descriptor route to
 * one is the same road `executeScript` turned out to be. So the ramp is resolved
 * into bands by `gradient-geometry.js` and each band is selected and filled,
 * which are the two primitives this host demonstrably performs.
 *
 * The consequence is stated rather than hidden: seams exist between bands, so
 * the result carries `bandsPainted`, `truncated` and `smoothed`, and the fill is
 * verified against the canvas exactly as a stroke is. A reported success means
 * pixels moved.
 */
'use strict';

var ps = require('../ps.js');
var Logger = require('../logger.js').Logger;
var brush = require('./brush.js');
var geometry = require('./gradient-geometry.js');

var StudioError = require('../errors.js').StudioError;

/** Mirrors `DEFAULT_STROKE_LAYER_NAME`'s sibling in shared; kept in step by hand. */
var DEFAULT_GRADIENT_LAYER_NAME = 'Gradient';

/** Samples read before and after, spread along the ramp. */
var VERIFICATION_SAMPLES = 12;

/**
 * Clips a band to the canvas and converts it to the bounds object
 * `selectRectangle` / `selectEllipse` both take.
 *
 * A radial fill's outer rings reach past the canvas by construction. Photoshop
 * rejects a fill that extends beyond the document rather than cropping it, so
 * every band is clipped here instead.
 */
function clipBounds(bounds, doc) {
  var left = Math.round(bounds.left);
  var top = Math.round(bounds.top);
  var right = Math.round(bounds.right);
  var bottom = Math.round(bounds.bottom);

  if (right <= 0 || bottom <= 0 || left >= doc.width || top >= doc.height) return null;

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    right: Math.min(doc.width, right),
    bottom: Math.min(doc.height, bottom),
  };
}

/**
 * Creates the layer to paint on, or reports why it cannot.
 *
 * This host's `createLayer` returns a 0×0 layer and ignores width and height
 * (measured on Photoshop 26.11, and the same finding that stopped `create_layer`
 * reporting success for an empty layer). A gradient on a 0×0 layer would fill
 * nothing, so the empty layer is caught here rather than reported as a painted
 * one — the operator gets the truth and a route that works, instead of a
 * gradient that silently went nowhere.
 */
function createGradientLayer(doc, requestedName) {
  var name = requestedName || DEFAULT_GRADIENT_LAYER_NAME;
  var layer;
  try {
    layer = doc.createLayer({ name: name });
  } catch (err) {
    return {
      error: StudioError(
        'STEP_FAILED',
        'Could not create the layer for this gradient: ' + ((err && err.message) || String(err)),
        { recoverable: true, details: { layerName: name } },
      ),
    };
  }

  var bounds = ps.boundsOf(layer);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return {
      error: StudioError(
        'UNSUPPORTED_OPERATION',
        'This Photoshop build creates every pixel layer empty (0×0) and ignores its size, so a gradient cannot be ' +
          'painted onto a new layer — there are no pixels to fill. Paint onto the active layer instead, or bring ' +
          'artwork in with photoshop.place_image first.',
        {
          recoverable: false,
          details: { requested: { layerName: name }, actual: bounds || null },
        },
      ),
    };
  }

  return { id: layer.id, name: layer.name };
}

/**
 * Fills one band.
 *
 * The foreground colour is set per band because each band is a different colour,
 * so this is a `set` plus a `fill` per band. Bands are filled largest-first for
 * a radial ramp and in order for a linear one, which is what keeps the innermost
 * ring and the seams correct.
 */
function fillBand(doc, selection, band, radial, opacity, blendMode) {
  var bounds = clipBounds(band.bounds, doc);
  if (!bounds) return Promise.resolve(false);

  return Promise.resolve(
    radial ? selection.selectEllipse(bounds, brush.selectionType()) : selection.selectRectangle(bounds, brush.selectionType()),
  ).then(function () {
    return brush.fillSelection(opacity, blendMode);
  }).then(function () {
    return true;
  });
}

function fillBands(doc, selection, bands, radial, opacity, blendMode) {
  var index = 0;
  var painted = 0;

  function next() {
    if (index >= bands.length) return Promise.resolve(painted);
    var band = bands[index];
    index += 1;
    return ps
      .withForegroundColor(band.color, function () {
        return fillBand(doc, selection, band, radial, opacity, blendMode);
      })
      .then(function (did) {
        if (did) painted += 1;
        return next();
      });
  }

  return next();
}

/** `apply_filter` on the layer the ramp was just painted, to soften the seams. */
function smoothLayer(doc, layer, radius, onError) {
  if (!(radius > 0)) return Promise.resolve(false);
  var ctx = {
    op: 'apply_filter',
    params: {
      documentId: doc.id,
      layerId: layer.id,
      filter: 'gaussianBlur',
      radius: radius,
    },
  };

  return Promise.resolve()
    .then(function () {
      return require('./layers.js').withActiveLayer(layer, function () {
        // Exported under its operation name, like every other op module here.
        return require('./filters.js').apply_filter(ctx);
      });
    })
    .then(function () {
      return true;
    })
    .catch(function (err) {
      // The ramp is already on the canvas; failing the whole step over the blur
      // would throw away work that landed, so this is reported and stepped over
      // — and the reason travels back in the result, because the usual cause is
      // invisible from the call site: a fresh document's Background layer is
      // locked against transforms.
      var message = (err && err.message) || String(err);
      Logger.warn('gradient: smoothing failed', { message: message });
      if (typeof onError === 'function') onError(message);
      return false;
    });
}

/** `paint_gradient`. */
function paintGradient(ctx) {
  var params = ctx.params;
  var doc = ps.resolveDocument(params.documentId);
  var type = params.type === 'radial' ? 'radial' : 'linear';
  var opacity = typeof params.opacity === 'number' ? params.opacity : 100;
  var blendMode = params.blendMode || 'normal';

  var resolved =
    type === 'radial'
      ? geometry.radialBands({
          stops: params.stops,
          width: doc.width,
          height: doc.height,
          bands: params.bands,
          reverse: params.reverse,
          center: params.center,
          radius: params.radius,
        })
      : geometry.linearBands({
          stops: params.stops,
          width: doc.width,
          height: doc.height,
          bands: params.bands,
          reverse: params.reverse,
          direction: params.direction,
        });

  if (resolved.bands.length === 0) {
    return Promise.reject(
      StudioError('INVALID_PARAMS', 'The gradient resolved to no visible bands on this canvas.', {
        recoverable: false,
        details: { bands: params.bands, width: doc.width, height: doc.height },
      }),
    );
  }

  var selection = doc.selection;
  if (!selection) {
    return Promise.reject(
      StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no document.selection.', {
        recoverable: false,
      }),
    );
  }
  var needed = type === 'radial' ? 'selectEllipse' : 'selectRectangle';
  if (typeof selection[needed] !== 'function') {
    return Promise.reject(
      StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no selection.' + needed + '.', {
        recoverable: false,
      }),
    );
  }

  var target = params.newLayer === true ? createGradientLayer(doc, params.layerName) : null;
  if (target && target.error) return Promise.reject(target.error);

  var smoothingError = null;

  var points = geometry.verificationPoints(
    {
      type: type,
      direction: params.direction,
      width: doc.width,
      height: doc.height,
      center: params.center,
      radius: params.radius,
    },
    VERIFICATION_SAMPLES,
  );

  Logger.info('rasterizing gradient', {
    op: ctx.op,
    type: type,
    bands: resolved.bands.length,
    stops: (params.stops || []).length,
    blendMode: blendMode,
    smoothRadius: params.smoothRadius,
    newLayer: params.newLayer === true,
  });

  return brush
    .readSamples(doc, points)
    .then(function (before) {
      return fillBands(doc, selection, resolved.bands, type === 'radial', opacity, blendMode).then(function (painted) {
        return brush.deselect(selection).then(function () {
          return smoothLayer(doc, doc.activeLayers[0], params.smoothRadius, function (message) {
            smoothingError = message;
          }).then(function (smoothed) {
            return brush.readSamples(doc, points).then(function (after) {
              var changed = 0;
              var readable = 0;
              for (var i = 0; i < before.length; i += 1) {
                if (before[i] === null || after[i] === null) continue;
                readable += 1;
                if (!brush.sameColor(before[i], after[i])) changed += 1;
              }
              return {
                painted: painted,
                samples: points.length,
                readable: readable,
                changed: changed,
                smoothed: smoothed,
              };
            });
          });
        });
      });
    })
    // Clear the selection on the way out whatever happened: it replaced whatever
    // the user had, and every later tool would inherit it.
    .catch(function (err) {
      return Promise.resolve(brush.deselect(selection)).then(function () {
        throw err;
      }, function () {
        throw err;
      });
    })
    .then(function (proof) {
      var info = target ? { layerId: target.id, layerName: target.name } : ps.layerInfo(doc.activeLayers[0]);

      if (proof.readable > 0 && proof.changed === 0) {
        throw StudioError(
          'STEP_FAILED',
          'The gradient was filled but no sampled pixel along the ramp changed. ' +
            'The canvas is probably already the colours being painted, or the target layer is hidden.',
          { recoverable: false, details: { samples: proof.samples, painted: proof.painted } },
        );
      }

      return {
        success: true,
        layerId: info.layerId,
        layerName: info.layerName,
        type: type,
        blendMode: blendMode,
        methodUsed: 'rasterized-gradient',
        bandsPainted: proof.painted,
        truncated: resolved.truncated,
        smoothed: proof.smoothed,
        smoothError: smoothingError === null ? undefined : smoothingError,
        samplesChecked: proof.samples,
        samplesChanged: proof.changed,
        // Null rather than false when the canvas could not be sampled at all:
        // unproven is not the same as proven-and-nothing-changed.
        verified: proof.readable === 0 ? null : true,
      };
    });
}

module.exports = {
  paint_gradient: paintGradient,
  DEFAULT_GRADIENT_LAYER_NAME: DEFAULT_GRADIENT_LAYER_NAME,
};