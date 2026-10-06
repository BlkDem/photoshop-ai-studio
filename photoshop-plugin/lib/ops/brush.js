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
 * The COM/ExtendScript door is shut as well. Driven over COM on this same build,
 * `typeof app.brushes` and `typeof app.activeBrush` both return `undefined`, so
 * there is no Brush object to hand to `PathItem.stroke()` and the call cannot be
 * made. `scripts/brush-firework.jsx` was written on the belief that this route
 * worked; run, it reports `brushUsed=false; bursts=-1` and fails on exactly that
 * property. It is kept only as a reproduction of the failure.
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
 * Soft edges are therefore *geometry*, not a host feature: the paint engine
 * (`@photoshop-ai-studio/paint-engine`) builds a falloff out of concentric discs
 * and paints them largest-first. That is a synthesized tip, and it is labelled as
 * one everywhere it surfaces.
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
 * Delegates to `ps.fillSelection`. The descriptor ladder lives there now because
 * it is the only route this host has for putting colour into pixels, and a
 * second private copy in this module is how `lib/demo.js` ended up using a
 * descriptor documented to hang instead.
 */
function fillSelection(opacity, blendMode) {
  return ps.fillSelection(opacity, blendMode);
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
 *
 * `tip` is a synthesized brush edge — see `stroke-geometry.js: tipRings`. When it
 * is absent or a single step, each stamp is one flat disc filled at the alpha
 * `opacity`, which is exactly what this function always did. When the caller asks
 * for a tip with more steps, each stamp becomes a stack of concentric discs
 * filled largest-first at descending alpha.
 */
function rasterizeAndVerify(doc, selection, stroke, opacity, blendMode, tip, spacing) {
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
   * Fills each disc in turn, ring by ring.
   *
   * Sequential on purpose: `batchPlay` descriptors that overlap would composite
   * against each other inside one action-manager pass, and how stacked fills
   * behave is not stable across builds.
   *
   * A flat stroke keeps the historical single-fill path exactly, including its
   * `strokeAlpha` compensation, because that compensation was measured against
   * Photoshop for an overlap count derived from the stamp total. The multi-ring
   * path uses `ringFillAlpha` instead, which models the ring stack as part of the
   * overlap rather than pretending it is not there.
   */
  function paintStamps(index) {
    if (index >= stroke.stamps.length) return Promise.resolve(0);

    var stamp = stroke.stamps[index];
    var rings = geometry.tipRings(stamp.r, tip);
    var flat = rings.length === 1;

    return paintRing(0).then(function (painted) {
      return paintStamps(index + 1).then(function (rest) {
        return painted + rest;
      });
    });

    function paintRing(ringIndex) {
      if (ringIndex >= rings.length) return Promise.resolve(0);
      var ring = rings[ringIndex];
      var bounds = ellipseBounds({ x: stamp.x, y: stamp.y, r: ring.radius }, doc);
      if (!bounds) return paintRing(ringIndex + 1);

      // `ringFillAlpha` floors its own base alpha, so a dense stroke still deposits
      // ink — see MIN_FILL_ALPHA in stroke-geometry.js.
      var alpha = flat
        ? opacity
        : geometry.ringFillAlpha(opacity / 100, stamp.r, spacing, rings.length, ring.weight) * 100;

      return Promise.resolve(selection.selectEllipse(bounds, selectionType()))
        .then(function () {
          return fillSelection(alpha, blendMode);
        })
        .then(function () {
          return paintRing(ringIndex + 1).then(function (painted) {
            return painted + 1;
          });
        });
    }
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
 * Converts a requested stroke opacity into the per-disc alpha that yields it.
 *
 * The rasterizer sweeps discs `spacing` apart, so a point in the middle of a
 * stroke is covered by `2 * radius / spacing` of them — five, at the 0.4 spacing
 * used here. Compositing that many alphas multiplies out as `1 - (1-a)^N`, so
 * handing each disc the requested alpha made the stroke `1-(1-x)^5` times too
 * dense: measured on Photoshop 26.11, a stroke asked at 25% landed at 76.5%, and
 * a second identical stroke compounded exactly as `1-(1-a)^2` predicts, to
 * within 0.1%. The compositing was sound; only the per-disc value was wrong.
 *
 * The divisor is the overlap the stroke *actually has*, capped by how many discs
 * it actually emitted. A one-disc stroke has no overlap, so it must not be
 * dimmed by a divisor borrowed from a long one — that showed up as a single dot
 * coming out at 15% when 25% was asked for.
 *
 * What the result means: `opacity` is the alpha at the stroke's core, and the
 * ends fall off below it because fewer discs cover them. That is how a brush
 * behaves and it is the reading a caller has, but it is a change of meaning from
 * "per disc", so it is stated rather than assumed.
 */
function strokeAlpha(opacity, radius, stampCount) {
  var requested = Math.min(100, Math.max(0, Number(opacity)));
  if (requested >= 100) return 100;
  if (requested <= 0) return 0;

  var r = Math.max(0.5, radius);
  var spacing = geometry.stampSpacing(r);
  var overlap = Math.min(Math.max(1, stampCount || 1), Math.max(1, (2 * r) / spacing));
  return (1 - Math.pow(1 - requested / 100, 1 / overlap)) * 100;
}

/**
 * Paints one stroke onto an already-resolved document, selection and layer.
 *
 * Shared by `stroke_path`, `paint_stroke` and `paint_strokes`, which differ only
 * in how they receive their geometry and in whether they are handed one stroke or
 * a batch. That they were near-verbatim duplicates before is how `smoothing` came
 * to be honoured in one and dropped in the other.
 *
 * The caller owns the document, the selection and the layer, so a batch can paint
 * many marks without re-resolving any of them — and, because `adapter.js` opens
 * one modal scope per operation, without opening a scope per mark either.
 */
function paintOneStroke(ctx, doc, selection, spec, target, geometryInput) {
  var color = ps.normalizeColor(spec.color || { r: 0, g: 0, b: 0 });
  var opacity = typeof spec.opacity === 'number' ? spec.opacity : 100;
  var brushSize = Math.max(1, spec.brushSize || DEFAULT_BRUSH_SIZE);
  var blendMode = spec.blendMode || 'normal';
  var tip = spec.tip && typeof spec.tip === 'object' ? spec.tip : null;

  var stroke = geometry.buildStroke(geometryInput.segments, geometryInput.points, {
    brushSize: brushSize,
    smoothing: spec.smoothing,
    simulatePressure: spec.simulatePressure === true,
    maxStamps: MAX_STAMPS,
    spacing: spec.spacing,
  });

  if (stroke.stamps.length === 0) {
    return Promise.reject(
      StudioError('INVALID_PARAMS', geometryInput.emptyMessage, {
        recoverable: false,
        details: { brushSize: brushSize, points: geometryInput.pointCount },
      }),
    );
  }

  Logger.info('rasterizing stroke', {
    op: ctx.op,
    stamps: stroke.stamps.length,
    points: stroke.points.length,
    brushSize: brushSize,
    blendMode: blendMode,
    simulatePressure: spec.simulatePressure === true,
    tipSteps: tip ? tip.steps : 1,
    spacing: spec.spacing === undefined ? 'default' : spec.spacing,
  });

  // `opacity` is the opacity of the stroke; the discs that make it up get the alpha
  // that adds up to it. A flat stroke keeps the measured `strokeAlpha`
  // compensation; a tipped stroke recomputes per ring, because the ring stack is
  // part of the overlap and pretending otherwise lands it opaque.
  var flatOpacity = strokeAlpha(opacity, stroke.radius, stroke.stamps.length);

  return ps
    .withForegroundColor(color, function () {
      return rasterizeAndVerify(doc, selection, stroke, flatOpacity, blendMode, tip, spec.spacing);
    })
    .then(function (proof) {
      // Normalised, not `target || docInfo(doc)`: `createStrokeLayer` speaks
      // `{id, name}` while `docInfo` speaks `{layerId, layerName}`, and picking one
      // or the other shape here reported `layerId: undefined` for every stroke onto
      // a new layer — a layer that exists, painted correctly, and was named in the
      // result as nothing.
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
        layerId: info.layerId,
        layerName: info.layerName,
        brushSize: brushSize,
        blendMode: blendMode,
        methodUsed: tip ? 'rasterized-stroke-synthesized-tip' : 'rasterized-stroke',
        stampsPainted: proof.painted,
        samplesChecked: proof.readable,
        samplesChanged: proof.changed,
        verified: proof.readable === 0 ? null : proof.changed > 0,
        truncated: stroke.truncated,
        // The tip is echoed back so a caller can never mistake a synthesized soft
        // edge for a Photoshop brush preset. `tipIsSynthesized` is unconditionally
        // true: there is no other kind of tip this host can do.
        tip: tip ? { core: tip.core, steps: tip.steps, outerAlpha: tip.outerAlpha } : null,
        tipIsSynthesized: tip ? true : null,
      };
    })
    .catch(function (err) {
      if (StudioError.isStudioError(err)) throw err;
      throw StudioError('STEP_FAILED', 'Failed to draw stroke: ' + ((err && err.message) || String(err)), {
        recoverable: true,
        details: { brushSize: brushSize, stamps: stroke.stamps.length },
      });
    });
}

/**
 * Resolves the document and selection, and creates the stroke layer when asked.
 *
 * Split from `paintOneStroke` so `paint_strokes` can pay for it once for the whole
 * batch rather than once per mark.
 *
 * Note the absence of `ps.asModal` here and in `paintOneStroke`: `adapter.js`
 * wraps every mutating operation in a modal scope, and `executeAsModal` has no
 * re-entry guard, so a second scope would nest inside the first.
 */
function resolveStrokeTarget(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var selection = doc.selection;
  if (!selection || typeof selection.selectEllipse !== 'function') {
    throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no selection.selectEllipse.', {
      recoverable: false,
    });
  }
  if (ctx.params.newLayer !== true) {
    return Promise.resolve({ doc: doc, selection: selection, target: null });
  }
  return createStrokeLayer(doc, ctx.params.layerName).then(function (target) {
    if (target && target.error) throw target.error;
    return { doc: doc, selection: selection, target: target };
  });
}

/** Single-stroke shared body. */
function drawStroke(ctx, geometryInput) {
  return resolveStrokeTarget(ctx).then(function (resolved) {
    return paintOneStroke(ctx, resolved.doc, resolved.selection, ctx.params, resolved.target, geometryInput).then(
      function (result) {
        return {
          success: true,
          layerId: result.layerId,
          layerName: result.layerName,
          brushSize: result.brushSize,
          blendMode: result.blendMode,
          methodUsed: result.methodUsed,
          stampsPainted: result.stampsPainted,
          samplesChecked: result.samplesChecked,
          samplesChanged: result.samplesChanged,
          verified: result.verified,
          truncated: result.truncated,
          tip: result.tip,
          tipIsSynthesized: result.tipIsSynthesized,
        };
      },
    );
  });
}

/**
 * `paint_strokes` — a whole layer's worth of marks in one operation.
 *
 * The reason this exists: a stroke is hundreds of fills, and calling `paint_stroke`
 * in a loop makes every one of them a round trip, a result parse and a modal
 * scope. A painting is a thousand marks or more, so the loop version spends all its
 * time in transport. Here the batch is one frame, one modal scope and one layer.
 *
 * Failures are collected by index rather than thrown. A painting forty marks in
 * should not be discarded because mark forty-one had no usable points, and the
 * caller needs to know which one — so `success` is false when any stroke failed and
 * `failures` names them, and the strokes that did paint are still reported.
 */
function paintStrokes(ctx) {
  ctx.op = 'paint_strokes';
  var specs = ctx.params.strokes || [];
  if (specs.length === 0) {
    return Promise.reject(StudioError('INVALID_PARAMS', 'paint_strokes needs at least one stroke.'));
  }

  return resolveStrokeTarget(ctx).then(function (resolved) {
    var doc = resolved.doc;
    var selection = resolved.selection;
    var failures = [];
    var painted = [];
    var index = 0;

    function next() {
      if (index >= specs.length) return Promise.resolve();
      var spec = specs[index];
      var at = index;
      index += 1;
      return paintOneStroke(
        ctx,
        doc,
        selection,
        spec,
        resolved.target,
        {
          points: spec.points || [],
          emptyMessage: 'paint_strokes: stroke ' + at + ' needs at least two points.',
          pointCount: (spec.points || []).length,
        },
      ).then(
        function (result) {
          painted.push(result);
        },
        function (err) {
          var code = err && err.code ? err.code : 'STEP_FAILED';
          failures.push({
            index: at,
            code: code,
            message: (err && err.message) || String(err),
            recoverable: err && typeof err.recoverable === 'boolean' ? err.recoverable : undefined,
          });
          Logger.warn('paint_strokes: stroke ' + at + ' failed', { code: code, message: (err && err.message) || String(err) });
        },
      ).then(next);
    }

    return next().then(function () {
      var stampsPainted = 0;
      var samplesChecked = 0;
      var samplesChanged = 0;
      var truncated = false;
      for (var i = 0; i < painted.length; i++) {
        stampsPainted += painted[i].stampsPainted || 0;
        samplesChecked += painted[i].samplesChecked || 0;
        samplesChanged += painted[i].samplesChanged || 0;
        if (painted[i].truncated) truncated = true;
      }

      return {
        success: failures.length === 0 && painted.length > 0,
        layerId: resolved.target ? resolved.target.id : docInfo(doc).layerId,
        layerName: resolved.target ? resolved.target.name : docInfo(doc).layerName,
        strokesPainted: painted.length,
        stampsPainted: stampsPainted,
        samplesChecked: samplesChecked,
        samplesChanged: samplesChanged,
        verified: samplesChecked === 0 ? null : samplesChanged > 0,
        truncated: truncated,
        failures: failures,
      };
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
  var created;
  try {
    created = doc.createLayer({ name: name });
  } catch (err) {
    Logger.warn('createStrokeLayer: layers.add failed', { message: (err && err.message) || String(err) });
    return Promise.resolve({
      error: StudioError('STEP_FAILED', 'Could not create the layer for this stroke: ' + ((err && err.message) || String(err)), {
        recoverable: true,
        details: { layerName: name },
      }),
    });
  }

  // Two things, in this order, and both matter.
  //
  // 1. **Resolve first.** `createLayer` hands back a handle before the layer is
  //    fully formed — its `id` is not populated yet. Assigning that handle to
  //    `document.activeLayers` is a type error in UXP ("expected Layer"), because
  //    it is not one yet. `ps.resolveCreatedLayer` is what the rest of the plugin
  //    uses for exactly this.
  // 2. **Then select.** Creating a layer does not select it on this build, so a
  //    stroke issued before this lands on the previously active layer and the new
  //    one comes back empty.
  return ps.resolveCreatedLayer(doc, created).then(function (layer) {
    return Promise.resolve(ps.selectLayer(layer)).then(function () {
      return { id: layer.id, name: layer.name };
    });
  });
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
  paint_strokes: paintStrokes,
  // Shared with the gradient rasterizer. A gradient is the same two primitives
  // in a different order — select a shape, fill it — so it uses these rather
  // than keeping its own copies that could drift from the ones under test.
  fillSelection: fillSelection,
  readSamples: readSamples,
  sameColor: sameColor,
  deselect: deselect,
  selectionType: selectionType,
  strokeAlpha: strokeAlpha,
  MAX_STAMPS: MAX_STAMPS,
};