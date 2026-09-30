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

  var layer = doc.createLayer({ name: params.name });
  ps.assertMutable(layer);

  var width = params.width || doc.width;
  var height = params.height || doc.height;
  var current = ps.boundsOf(layer);
  var targetX = typeof params.x === 'number' ? params.x : Math.round((doc.width - width) / 2);
  var targetY = typeof params.y === 'number' ? params.y : Math.round((doc.height - height) / 2);

  if (width !== current.width || height !== current.height) {
    scaleTo(layer, current, width, height);
  }
  translateBy(layer, targetX - current.x, targetY - current.y);

  if (typeof params.opacity === 'number') layer.opacity = params.opacity;
  if (typeof params.visible === 'boolean') layer.visible = params.visible;

  return describe(doc, layer);
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

  if (dx !== 0 || dy !== 0) translateBy(layer, dx, dy);
  return describe(doc, layer);
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

/** `create_group` — optionally moving an existing layer inside. */
function createGroup(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;

  var group = doc.createLayerGroup({ name: params.name });
  if (params.layer) {
    var member = ps.findLayer(doc, params.layer);
    ps.assertMutable(member);
    member.move(group, placement('placeInside'));
  }
  return describe(doc, group);
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
  if (where === 'placeAtEnd') {
    layer.move(undefined, placement('placeAtEnd'));
  } else if (where === 'placeAtBeginning') {
    layer.move(undefined, placement('placeAtBeginning'));
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
 * `layer.translate` is the documented DOM method, but it is absent on some
 * builds; the `transform` descriptor is the fallback. Both run in the caller's
 * modal scope.
 */
function translateBy(layer, dx, dy) {
  if (typeof layer.translate === 'function') {
    try {
      layer.translate(dx, dy);
      return;
    } catch (err) {
      // Fall through to batchPlay.
    }
  }
  return ps.batchPlay([
    {
      _obj: 'transform',
      _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
      _options: { dialogOptions: 'dontDisplay' },
      freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
      offset: { _obj: 'offset', horizontal: ps.round(dx, 2), vertical: ps.round(dy, 2) },
    },
  ]);
}

/**
 * Scales a layer by a factor using the DOM's `scale`, falling back to `transform`.
 * Percentages are what the DOM expects, not ratios.
 */
function scaleBy(layer, factorX, factorY) {
  var px = ps.round(factorX * 100, 2);
  var py = ps.round(factorY * 100, 2);
  if (typeof layer.scale === 'function') {
    try {
      layer.scale(px, py);
      return;
    } catch (err) {
      // Fall through.
    }
  }
  return ps.batchPlay([
    {
      _obj: 'transform',
      _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
      _options: { dialogOptions: 'dontDisplay' },
      scale: { _obj: 'scale', horizontal: px, vertical: py },
    },
  ]);
}

function scaleTo(layer, current, width, height) {
  if (current.width <= 0 || current.height <= 0) return;
  scaleBy(layer, width / current.width, height / current.height);
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
