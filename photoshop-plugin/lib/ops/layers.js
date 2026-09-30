/**
 * Layer operations.
 *
 * Preference order throughout: the UXP DOM first, `batchPlay` only where the DOM
 * genuinely has no equivalent (creating a layer with explicit bounds, resampling
 * with a specific algorithm). Photoshop's DOM is synchronous to read and async to
 * write, which this file relies on rather than fights.
 */
'use strict';

var ps = require('../ps.js');
var constants = ps.constants;
var StudioError = require('../errors.js').StudioError;

/** `get_layers` */
function getLayers(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var includeHidden = ctx.params.includeHidden !== false;
  var layers = ps.flattenLayers(doc.layers);
  return includeHidden ? layers : layers.filter(function (l) {
    return l.visible;
  });
}

/** `get_layer` */
function getLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  return describe(doc, layer);
}

/** `create_layer` — DOM `createLayer`, then geometry via translate + scale. */
function createLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;

  var created = doc.createLayer({ name: params.name });

  return ps.resolveCreatedLayer(doc, created).then(function (layer) {
    ps.assertMutable(layer);

    var width = params.width || doc.width;
    var height = params.height || doc.height;
    var current = ps.boundsOf(layer);
    var targetX = typeof params.x === 'number' ? params.x : Math.round((doc.width - width) / 2);
    var targetY = typeof params.y === 'number' ? params.y : Math.round((doc.height - height) / 2);

    // Every geometry step is awaited in turn: `scaleTo` and `translateBy` both
    // go through `batchPlay`, and describing the layer before they settle
    // reports the position and size the layer had when it was born.
    var geometry = width !== current.width || height !== current.height
      ? scaleTo(layer, current, width, height)
      : Promise.resolve();

    return geometry
      .then(function () {
        return translateBy(layer, targetX - current.x, targetY - current.y);
      })
      .then(function () {
        if (typeof params.opacity === 'number') layer.opacity = params.opacity;
        if (typeof params.visible === 'boolean') layer.visible = params.visible;
        return describe(doc, layer);
      });
  });
}

/** `create_group` — also waits for the group's id before reporting it. */
function createGroup(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var created = doc.createLayerGroup({ name: params.name });

  return ps.resolveCreatedLayer(doc, created).then(function (group) {
    if (params.layer) {
      var member = ps.findLayer(doc, params.layer);
      ps.assertMutable(member);
      member.move(group, placement('placeInside'));
    }
    return describe(doc, group);
  });
}

/** `delete_layer` — destructive, gated upstream by the safety layer. */
function deleteLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);
  var id = layer.id;
  layer.delete();
  return { deletedLayerId: id };
}

/** `rename_layer` */
function renameLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);
  layer.name = ctx.params.name;
  return describe(doc, layer);
}

/**
 * `move_layer`
 *
 * The DOM exposes `translate(dx, dy)` but no absolute positioning, so the delta
 * is computed from the current bounds. `dx`/`dy` are passed straight through.
 */
function moveLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);

  var before = ps.boundsOf(layer);
  var dx = 0;
  var dy = 0;
  if (typeof ctx.params.x === 'number') dx = ctx.params.x - before.x;
  else if (typeof ctx.params.dx === 'number') dx = ctx.params.dx;
  if (typeof ctx.params.y === 'number') dy = ctx.params.y - before.y;
  else if (typeof ctx.params.dy === 'number') dy = ctx.params.dy;

  // Awaited: the transform is a `batchPlay` promise, and reading the layer back
  // before it settles returns the position from *before* the move. The op then
  // reports success with a stale position and no verification can catch it.
  return translateBy(layer, dx, dy).then(function () {
    return describe(doc, layer);
  });
}

/** `set_layer_visibility` */
function setLayerVisibility(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);
  layer.visible = ctx.params.visible === true;
  return describe(doc, layer);
}

/** `set_layer_opacity` */
function setLayerOpacity(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);
  var value = ctx.params.opacity;
  if (typeof value !== 'number' || value < 0 || value > 100) {
    throw StudioError('INVALID_PARAMS', 'Opacity must be between 0 and 100, received ' + value);
  }
  layer.opacity = value;
  return describe(doc, layer);
}

/** `move_layer_to_group` */
function moveLayerToGroup(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params.layer);
  var group = ps.findLayer(doc, ctx.params.group);
  ps.assertIsGroup(group);
  ps.assertMutable(layer);

  var ancestors = ps.ancestorsOf(doc, group.id);
  if (layer.id === group.id || ancestors.indexOf(layer.id) !== -1) {
    throw StudioError('INVALID_PARAMS', 'Cannot move a group into itself or into one of its own children.');
  }
  layer.move(group, placement('placeInside'));
  return describe(doc, layer);
}

/** `reorder_layer` */
function reorderLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params.layer);
  ps.assertMutable(layer);

  var where = ctx.params.placement;
  // `document.layers` is top-first, so the stack's top is index 0.
  var stack = doc.layers || [];
  if (stack.length < 2) return describe(doc, layer);

  if (where === 'placeAtEnd') {
    // `layer.move` rejects an undefined target, so "to the end" is expressed as
    // "before the current top layer".
    var top = stack[0];
    if (top.id !== layer.id) layer.move(top, placement('placeBefore'));
  } else if (where === 'placeAtBeginning') {
    var bottom = stack[stack.length - 1];
    if (bottom.id !== layer.id) layer.move(bottom, placement('placeAfter'));
  } else {
    if (!ctx.params.target) {
      throw StudioError('INVALID_PARAMS', 'reorder_layer with placement "' + where + '" requires a target layer.');
    }
    var target = ps.findLayer(doc, ctx.params.target);
    layer.move(target, placement(where === 'placeBefore' ? 'placeBefore' : 'placeAfter'));
  }
  return describe(doc, layer);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Fresh, normalised record for a layer object we already hold. */
function describe(doc, layer) {
  var parent = ps.parentOf(doc, layer.id);
  return ps.layerInfo(layer, parent ? parent.id : null);
}

/**
 * The `transform` descriptor, addressed by layer id.
 *
 * Two things were wrong here and both failed *quietly*, which is why a run could
 * report `move_layer: succeeded` for a layer that had not moved an pixel:
 *
 *  - `{_ref: 'layer', _enum: 'ordinal', _value: 'targetEnum'}` addresses the
 *    **active** layer, not the one the caller is holding. On this build that
 *    silently moved whatever happened to be selected.
 *  - `layer.translate()` existed and returned without throwing while doing
 *    nothing, so the early `return` claimed success.
 *
 * Addressing the layer by `_id` is unambiguous, and the result is checked by the
 * caller reading the bounds back, so a silent no-op surfaces as a failed
 * verification rather than a green run.
 */
function translateBy(layer, dx, dy) {
  return withActiveLayer(layer, function () {
    return layer.translate(ps.round(dx, 2), ps.round(dy, 2));
  });
}

/**
 * Runs `fn` with `layer` selected.
 *
 * `Layer.translate()` and `Layer.scale()` act on the **active** layer. Given a
 * layer that is not selected they return normally and change nothing — a silent
 * no-op that made `move_layer` report success for layers that had not moved a
 * pixel, and made a whole §29 demo "succeed" with the artwork still where it
 * started.
 *
 * The `transform` descriptor is not an escape hatch: every form of it tried on
 * Photoshop 26.11 / UXP 9.0.2 — `ordinal/targetEnum` and `_id`, with and without
 * `_options`, with and without pixel units — left the layer untouched.
 *
 * The cost is that the selection changes, which the user can see. It is restored
 * only where we can do so without guessing; a plan that moves layers will leave
 * the last one it touched selected.
 */
function withActiveLayer(layer, fn) {
  return Promise.resolve()
    .then(function () {
      var document = layer.parent || (ps.app && ps.app.activeDocument);
      if (document && document.activeLayers) document.activeLayers = [layer];
      return fn();
    })
    .then(function (result) {
      return result;
    })
    .catch(function (err) {
      throw StudioError('STEP_FAILED', 'Could not transform "' + layer.name + '": ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    });
}

/**
 * Scales a layer by a factor.
 *
 * The DOM's `scale` takes percentages, not ratios.
 */
function scaleBy(layer, factorX, factorY) {
  return withActiveLayer(layer, function () {
    return layer.scale(ps.round(factorX * 100, 2), ps.round(factorY * 100, 2));
  });
}

function scaleTo(layer, current, width, height) {
  if (current.width <= 0 || current.height <= 0) return Promise.resolve();
  return scaleBy(layer, width / current.width, height / current.height);
}

/** Resolves an `ElementPlacement` enum name across UXP versions. */
function placement(name) {
  var enumObject = constants.ElementPlacement;
  if (enumObject && typeof enumObject[name.toUpperCase()] !== 'undefined') {
    return enumObject[name.toUpperCase()];
  }
  if (enumObject && typeof enumObject[name] !== 'undefined') return enumObject[name];
  return name;
}

module.exports = {
  get_layers: getLayers,
  get_layer: getLayer,
  create_layer: createLayer,
  delete_layer: deleteLayer,
  rename_layer: renameLayer,
  move_layer: moveLayer,
  set_layer_visibility: setLayerVisibility,
  set_layer_opacity: setLayerOpacity,
  create_group: createGroup,
  move_layer_to_group: moveLayerToGroup,
  reorder_layer: reorderLayer,
  placement: placement,
  translateBy: translateBy,
  scaleBy: scaleBy,
};
