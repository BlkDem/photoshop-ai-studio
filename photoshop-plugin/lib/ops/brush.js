/**
 * Brush operations for UXP 9.0.2 / Photoshop 26.11.
 *
 * ## What this can and cannot do
 *
 * Photoshop's brush engine is unreachable from UXP on this build. Four routes
 * were measured on device, not guessed, and all four are dead ends:
 *
 *   - `core.executeScript` / `_executeScript` / `evalScript` / `doScript` are
 *     absent from `core`, `action` and `app`, confirmed by walking
 *     `Object.getOwnPropertyNames` — `Object.keys` hides them, `getOwnPropertyNames`
 *     does not, and the dump shows no script-execution member at all.
 *   - `core.performMenuCommand` accepts the call but cannot resolve a command
 *     symbol, because `constants.MenuCommand` exposes no members on this build.
 *     Every spelling (`stroke`, `strokePath`, `editStroke`, `strokePathWithBrush`)
 *     comes back `timeOut`.
 *   - `action.batchPlay` with `_obj: 'stroke'` hangs, because a descriptor that
 *     omits `strokeStyle` / `paintStyle` leaves Photoshop waiting on a dialog
 *     that a modal scope cannot dismiss.
 *   - `action.batchPlay` with `_obj: 'paint'` is rejected as "command unavailable".
 *
 * ExtendScript's `PathItem.stroke(brush, color, …)` — which *is* a real brush,
 * real tip, real pressure — only exists in the route above, so from inside the
 * plugin it is out of reach. (It does work from a `.jsx` file driven over COM;
 * `scripts/brush-firework.jsx` is that path, kept as a diagnostic.)
 *
 * So a stroke here is **rasterized, not simulated through the brush engine**:
 * the path is flattened to a polyline, swept with overlapping discs of the
 * requested diameter, and filled through the selection API. The visual result is
 * a round-capped, round-joined, optionally pressure-tapered stroke of the right
 * width in the right colour — which is what a caller asked for — but it has no
 * brush tip texture, no spacing dynamics and no flow simulation. `methodUsed` in
 * the result says so, and the shared tool description says so too, because a
 * description that overclaims is how a caller ends up surprised.
 *
 * ## Why the result is verified rather than trusted
 *
 * A fill can succeed and change nothing: an empty selection, a locked layer, a
 * colour identical to what is already there. So every stroke samples the canvas
 * along its own centreline before and after painting, and reports how many
 * samples moved. A stroke that changed nothing is reported as a failure with
 * `recoverable: false`, because retrying an unchanged canvas will not change it.
 */
'use strict';

var ps = require('../ps.js');
var geometry = require('./stroke-geometry.js');
var StudioError = require('../errors.js').StudioError;
var Logger = require('../logger.js').Logger;

/** Default diameter when the caller does not name one. */
var DEFAULT_BRUSH_SIZE = 5;

/**
 * Ceiling on the number of fills in one stroke.
 *
 * Each stamp is one `selectEllipse` plus one `batchPlay` fill, and `batchPlay`
 * round-trips through Photoshop's action manager, so stamp count is wall-clock
 * time. A 4000px brush over a long path would otherwise need tens of thousands
 * of fills and hold the modal scope for minutes. The cap is reported in the
 * result as `truncated` rather than silently shortening the stroke.
 */
var MAX_STAMPS = 4000;

/**
 * `selection.selectEllipse` needs a selection type, and the enum has held
 * different spellings across builds. Mirrors `canvas.js`, which resolves it the
 * same way for the same reason.
 */
function selectionType() {
  var enumObject = ps.constants && ps.constants.SelectionType;
  if (enumObject) {
    if (typeof enumObject.REPLACE !== 'undefined') return enumObject.REPLACE;
    if (typeof enumObject.replace !== 'undefined') return enumObject.replace;
  }
  return 'set';
}

/**
 * Fills the current selection with the foreground colour.
 *
 * The four descriptor spellings are ordered by how much of the stroke they can
 * honour: the first can carry a blend mode and an opacity, and the later ones
 * are progressively plainer fallbacks for builds that reject the richer form.
 * The `_obj: 'stroke'` descriptor is deliberately absent — it hangs.
 */
function fillSelection(opacity, blendMode) {
  var mode = { _enum: 'blendMode', _value: blendMode || 'normal' };
  var percent = { _unit: 'percent', _value: opacity };

  var attempts = [
    [{
      _obj: 'fill',
      using: { _enum: 'fill', _value: 'foregroundColor' },
      mode: mode,
      opacity: percent,
      _options: { dialogOptions: 'dontDisplay' },
    }],
    [{
      _obj: 'fill',
      _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
      using: { _enum: 'fill', _value: 'foregroundColor' },
      mode: mode,
      opacity: percent,
      _options: { dialogOptions: 'dontDisplay' },
    }],
    [{
      _obj: 'fill',
      _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
      using: { _enum: 'fill', _value: 'foregroundColor' },
      opacity: percent,
      _options: { dialogOptions: 'dontDisplay' },
    }],
    [{
      _obj: 'fill',
      _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
      using: { _enum: 'fill', _value: 'foregroundColor' },
      _options: { dialogOptions: 'dontDisplay' },
    }],
  ];

  function tryNext(index) {
    if (index >= attempts.length) {
      return Promise.reject(
        StudioError('STEP_FAILED', 'Photoshop rejected every fill descriptor this build accepts.', {
          recoverable: true,
          details: { attempts: attempts.length },
        }),
      );
    }
    return ps.batchPlay(attempts[index], { timeoutMs: 5000 }).then(
      function (result) {
        return { succeeded: true, attempt: index + 1, result: result };
      },
      function (err) {
        Logger.info('fill: descriptor ' + (index + 1) + ' rejected', {
          code: (err && err.code) || 'UNKNOWN',
          message: (err && err.message) || String(err),
        });
        return tryNext(index + 1);
      },
    );
  }

  return tryNext(0);
}

function docInfo(doc) {
  var activeLayer = doc.activeLayer;
  return {
    layerId: activeLayer && activeLayer.id,
    layerName: activeLayer && activeLayer.name,
  };
}

function deselect(selection) {
  try {
    return Promise.resolve(selection.deselect()).then(function () {});
  } catch (err) {
    // Leaving a selection behind would silently change the meaning of the next
    // fill, so this is worth a line in the log even though it is not fatal.
    Logger.info('deselect: ignored', { message: (err && err.message) || String(err) });
    return Promise.resolve();
  }
}

/**
 * Clips a stamp to the canvas and converts it to the rectangle bounds
 * `selection.selectEllipse` expects.
 *
 * A path may legitimately run off the edge of the document, and a fill that
 * extends past it is rejected by Photoshop rather than cropped. Clipping here
 * also means a stamp whose centre is outside the canvas but whose edge overlaps
 * it still lands, which is what makes a stroke that leaves the frame behave.
 */
function ellipseBounds(stamp, doc) {
  var left = Math.round(stamp.x - stamp.r);
  var top = Math.round(stamp.y - stamp.r);
  var right = Math.round(stamp.x + stamp.r);
  var bottom = Math.round(stamp.y + stamp.r);

  if (right <= 0 || bottom <= 0 || left >= doc.width || top >= doc.height) return null;

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    right: Math.min(doc.width, right),
    bottom: Math.min(doc.height, bottom),
  };
}

/**
 * Normalizes whatever `sampleColor` returned into `{r, g, b}`, or `null`.
 *
 * `ps.solidColorToRgb` falls back to opaque black for a shape it does not
 * recognise, which is fine for a preview and wrong here: an unreadable sample
 * that came back as black would register as "the canvas changed", and the whole
 * verification would pass for the wrong reason. So an unrecognised shape is
 * reported as unreadable instead.
 */
function sampleToRgb(solid) {
  if (!solid || typeof solid !== 'object') return null;
  if (typeof solid.r === 'number' && typeof solid.g === 'number' && typeof solid.b === 'number') {
    return { r: solid.r, g: solid.g, b: solid.b };
  }
  if (!solid.base && !solid.rgb && !solid.cmyk) return null;
  return ps.solidColorToRgb(solid);
}

/**
 * Reads the canvas colour at a set of points.
 *
 * `sampleColor` takes a *point object* rather than loose coordinates, and
 * `filters.js` already normalises its result through `Promise.resolve` because
 * the return is synchronous on some builds and a promise on others — so this
 * does the same. Reading it as if it were always synchronous means every sample
 * compares as a change, which would make the verification below pass
 * unconditionally and be worse than no check at all.
 *
 * A sample that throws is recorded as `null` rather than aborting the read: a
 * stroke can legitimately run past the canvas, and one unreadable point must not
 * cost us the other two hundred.
 */
function readSamples(doc, points) {
  return Promise.all(
    points.map(function (point) {
      var x = Math.round(point.x);
      var y = Math.round(point.y);
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
      try {
        return Promise.resolve(doc.sampleColor({ x: x, y: y }, 1, 1)).then(function (solid) {
          return sampleToRgb(solid);
        }, function () {
          return null;
        });
      } catch (err) {
        return null;
      }
    }),
  );
}

/** Two colours within `tolerance` on each channel are the same colour. */
function sameColor(a, b, tolerance) {
  if (!a || !b) return false;
  var limit = tolerance === undefined ? 6 : tolerance;
  return (
    Math.abs(a.r - b.r) <= limit &&
    Math.abs(a.g - b.g) <= limit &&
    Math.abs(a.b - b.b) <= limit
  );
}

/**
 * Paints the stroke and proves it landed.
 *
 * The order matters: the "before" read has to happen before the first fill, or
 * there is nothing to compare against and the check becomes decorative.
 */
function rasterizeAndVerify(doc, selection, stroke, opacity, blendMode) {
  var points = stroke.verificationPoints;

  return readSamples(doc, points).then(function (before) {
    return paintStamps(0)
      .then(function (painted) {
        return deselect(selection).then(function () {
          return readSamples(doc, points).then(function (after) {
            var changed = 0;
            var readable = 0;

            for (var i = 0; i < before.length; i += 1) {
              if (before[i] === null || after[i] === null) continue;
              readable += 1;
              if (!sameColor(before[i], after[i])) changed += 1;
            }

            return { painted: painted, samples: points.length, readable: readable, changed: changed };
          });
        });
      })
      // The selection is cleared on the way out whatever happened. Leaving one
      // behind is not a cosmetic problem: `selectEllipse` replaced whatever the
      // user had, and every later tool in the session would then act on a
      // marching-ants rectangle nobody asked for. The original failure is what
      // the caller needs to hear about, so it is rethrown.
      .catch(function (err) {
        return Promise.resolve(deselect(selection)).then(function () {
          throw err;
        }, function () {
          throw err;
        });
      });
  });

  /**
   * Fills each disc in turn.
   *
   * Sequential on purpose: `batchPlay` descriptors that overlap would composite
   * against each other inside one action-manager pass, and how stacked fills
   * behave is not stable across builds.
   */
  function paintStamps(index) {
    if (index >= stroke.stamps.length) return Promise.resolve(0);

    var bounds = ellipseBounds(stroke.stamps[index], doc);
    if (!bounds) return paintStamps(index + 1);

    return Promise.resolve(selection.selectEllipse(bounds, selectionType()))
      .then(function () {
        return fillSelection(opacity, blendMode);
      })
      .then(function () {
        return paintStamps(index + 1).then(function (painted) {
          return painted + 1;
        });
      });
  }
}

/**
 * `list_brushes` — what the host actually has.
 *
 * This used to return a hardcoded list of eight brush names that had nothing to
 * do with the running Photoshop, which is a fabricated value in a tool whose
 * whole purpose is to report the truth. The list is now read from the host, and
 * when no brush collection is reachable the result says `available: false` with
 * the reason, rather than inventing names that may not exist on this machine.
 *
 * `brushName` is advisory on this build for a further reason: the rasterizer
 * paints discs of a given diameter, so a brush's *name* has no effect on the
 * result. Saying so beats echoing a name back as `brushUsed`, which reads to a
 * caller like the named brush was selected.
 */
function listBrushes() {
  var sources = [];

  function record(source, brushes, currentBrush) {
    sources.push({
      source: source,
      count: brushes.length,
      currentBrush: currentBrush || null,
      brushes: brushes,
    });
  }

  function readCollection(collection, source) {
    if (!collection || typeof collection.length !== 'number') return;
    var brushes = [];
    var step = Math.ceil(collection.length / 100);
    for (var i = 0; i < collection.length && i < 100 * step; i += step) {
      var entry = collection[i];
      if (!entry) continue;
      var item = { name: String(entry.name) };
      if (typeof entry.size === 'number') item.size = Math.round(entry.size);
      if (typeof entry.strokeTipStyle !== 'string') item.strokeTipStyle = entry.strokeTipStyle;
      brushes.push(item);
    }
    if (brushes.length > 0) record(source, brushes, null);
  }

  var app = ps.app;
  readCollection(app && app.brushes, 'app.brushes');

  if (sources.length === 0) {
    var doc = null;
    try {
      doc = ps.resolveDocument(undefined);
    } catch (err) {
      /* no open document is not a reason to fail a read-only query */
    }
    readCollection(doc && doc.brushes, 'document.brushes');
  }

  if (sources.length === 0) {
    Logger.info('list_brushes: no brush collection on this host');
    return Promise.resolve({
      available: false,
      brushes: [],
      currentBrush: null,
      source: 'unavailable',
      reason:
        'This Photoshop build exposes no brush collection to UXP, so no brush names can be read. ' +
        'brushSize is still honoured: strokes are rasterized as discs of that diameter.',
    });
  }

  return Promise.resolve({
    available: true,
    brushes: sources[0].brushes,
    currentBrush: sources[0].currentBrush,
    source: sources[0].source,
  });
}

/**
 * Shared body of `stroke_path` and `paint_stroke`.
 *
 * The two operations differ only in how they receive their geometry — a segment
 * list with Bézier control points, or a flat point list — so they share one
 * implementation. That they were near-verbatim duplicates before is how
 * `smoothing` came to be honoured in one and dropped in the other.
 *
 * Note the absence of `ps.asModal` here: `adapter.js` already wraps every
 * mutating operation in a modal scope, and `executeAsModal` has no re-entrancy
 * guard, so a second scope was nesting inside the first.
 */
function drawStroke(ctx, geometryInput) {
  var params = ctx.params;
  var color = ps.normalizeColor(params.color);
  var opacity = typeof params.opacity === 'number' ? params.opacity : 100;
  var brushSize = Math.max(1, params.brushSize || DEFAULT_BRUSH_SIZE);
  var blendMode = params.blendMode || 'normal';

  var stroke = geometry.buildStroke(geometryInput.segments, geometryInput.points, {
    brushSize: brushSize,
    smoothing: params.smoothing,
    simulatePressure: params.simulatePressure === true,
    maxStamps: MAX_STAMPS,
  });

  if (stroke.stamps.length === 0) {
    return Promise.reject(
      StudioError('INVALID_PARAMS', geometryInput.emptyMessage, {
        recoverable: false,
        details: { brushSize: brushSize, points: geometryInput.pointCount },
      }),
    );
  }

  return ps.withForegroundColor(color, function () {
    var doc = ps.resolveDocument(params.documentId);
    var selection = doc.selection;
    if (!selection || typeof selection.selectEllipse !== 'function') {
      return Promise.reject(
        StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no selection.selectEllipse.', {
          recoverable: false,
        }),
      );
    }

    var target = params.newLayer === true ? createStrokeLayer(doc, params.layerName) : null;
    if (target && target.error) return Promise.reject(target.error);

    Logger.info('rasterizing stroke', {
      op: ctx.op,
      stamps: stroke.stamps.length,
      points: stroke.points.length,
      brushSize: brushSize,
      blendMode: blendMode,
      simulatePressure: params.simulatePressure === true,
      newLayer: params.newLayer === true,
    });

    return rasterizeAndVerify(doc, selection, stroke, opacity, blendMode)
      .then(function (proof) {
        var info = target ? { layerId: target.id, layerName: target.name } : docInfo(doc);

        if (proof.readable > 0 && proof.changed === 0) {
          throw StudioError(
            'STEP_FAILED',
            'The stroke was filled but no sampled pixel along the path changed. ' +
              'The path is probably already the colour being painted, or the target layer is hidden.',
            { recoverable: false, details: { samples: proof.samples, painted: proof.painted } },
          );
        }

        return {
          success: true,
          layerId: info.layerId,
          layerName: info.layerName,
          brushSize: brushSize,
          blendMode: blendMode,
          methodUsed: 'rasterized-stroke',
          stampsPainted: proof.painted,
          samplesChecked: proof.readable,
          samplesChanged: proof.changed,
          verified: proof.readable === 0 ? null : proof.changed > 0,
          truncated: stroke.truncated,
        };
      })
      .catch(function (err) {
        if (StudioError.isStudioError(err)) throw err;
        throw StudioError('STEP_FAILED', 'Failed to draw stroke: ' + ((err && err.message) || String(err)), {
          recoverable: true,
          details: { brushSize: brushSize, stamps: stroke.stamps.length },
        });
      });
  });
}

/**
 * Creates the layer a stroke paints onto.
 *
 * The shared tool description promises the stroke lands on a new layer, and the
 * previous implementation painted onto whatever happened to be active. Callers
 * that need a separate layer get one; the default stays "paint where I am",
 * which is what a drawing tool does.
 */
function createStrokeLayer(doc, requestedName) {
  // Must match `DEFAULT_STROKE_LAYER_NAME` in shared/src/photoshop/operations.ts.
  // This file cannot import `shared` — it ships standalone to a UXP host — so the
  // constant is duplicated here and the post-condition check depends on both
  // copies agreeing.
  var name = requestedName || 'Stroke';
  try {
    var layer = doc.createLayer({ name: name });
    return { id: layer.id, name: layer.name };
  } catch (err) {
    Logger.warn('createStrokeLayer: layers.add failed', { message: (err && err.message) || String(err) });
    return {
      error: StudioError('STEP_FAILED', 'Could not create the layer for this stroke: ' + ((err && err.message) || String(err)), {
        recoverable: true,
        details: { layerName: name },
      }),
    };
  }
}

/** `stroke_path` — a path of segments, with Bézier curves honoured. */
function strokePath(ctx) {
  ctx.op = 'stroke_path';
  return drawStroke(ctx, {
    segments: ctx.params.path || [],
    emptyMessage: 'stroke_path was given a path with no usable points.',
    pointCount: (ctx.params.path || []).length,
  });
}

/** `paint_stroke` — a flat point list, freehand-style, optionally smoothed. */
function paintStroke(ctx) {
  ctx.op = 'paint_stroke';
  return drawStroke(ctx, {
    points: ctx.params.points || [],
    emptyMessage: 'paint_stroke needs at least two points.',
    pointCount: (ctx.params.points || []).length,
  });
}

module.exports = {
  list_brushes: listBrushes,
  stroke_path: strokePath,
  paint_stroke: paintStroke,
};