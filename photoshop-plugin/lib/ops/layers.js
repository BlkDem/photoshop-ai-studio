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
        // Measured on this build: `doc.createLayer()` and `doc.createPixelLayer()`
        // both hand back a 0×0 layer, and the `width`/`height`/`fill` options are
        // accepted and ignored — so `scaleTo` above returns early and the layer
        // stays empty. It still has a name, still reports kind "pixel", and used
        // to be returned as a success that passed every declared check, because
        // no check measured area. That is precisely the false success this
        // project exists to prevent, so it is reported as the failure it is.
        var settled = ps.boundsOf(layer);
        if (settled.width <= 0 || settled.height <= 0) {
          throw StudioError(
            'UNSUPPORTED_OPERATION',
            'This Photoshop build creates every pixel layer empty (0×0) and ignores width, height and fill, ' +
              'so there is nothing to put pixels into. Use photoshop.place_image to bring artwork in, or ' +
              'photoshop.apply_image to paste generated pixels.',
            { details: { requested: { width: width, height: height }, actual: { width: settled.width, height: settled.height } } },
          );
        }
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

/**
 * Blend-mode names, for builds whose `constants.BlendMode` is missing or partial.
 *
 * Keyed by the *value* the DOM reports, the same way `KIND_BY_VALUE` handles layer
 * kinds, because that string is what `layerInfo` has to echo back.
 */
var BLEND_BY_VALUE = {
  normal: 'normal',
  dissolve: 'dissolve',
  darken: 'darken',
  multiply: 'multiply',
  colorBurn: 'colorBurn',
  linearBurn: 'linearBurn',
  darkerColor: 'darkerColor',
  lighten: 'lighten',
  screen: 'screen',
  colorDodge: 'colorDodge',
  linearDodge: 'linearDodge',
  lighterColor: 'lighterColor',
  overlay: 'overlay',
  softLight: 'softLight',
  hardLight: 'hardLight',
  vividLight: 'vividLight',
  linearLight: 'linearLight',
  pinLight: 'pinLight',
  hardMix: 'hardMix',
  difference: 'difference',
  exclusion: 'exclusion',
  subtract: 'subtract',
  divide: 'divide',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

/** Resolves a requested mode to what this build actually accepts. */
function blendValue(requested) {
  var enumObject = constants.BlendMode;
  if (enumObject && typeof enumObject[requested] !== 'undefined') return enumObject[requested];
  if (enumObject && typeof enumObject[requested.toUpperCase()] !== 'undefined') {
    return enumObject[requested.toUpperCase()];
  }
  return BLEND_BY_VALUE[requested] || requested;
}

function mapBlendMode(mode) {
  if (typeof mode !== 'string' || mode.length === 0) return 'normal';
  return BLEND_BY_VALUE[mode] || mode;
}

/** `set_layer_blend_mode` */
function setLayerBlendMode(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);

  var value = blendValue(ctx.params.mode);
  try {
    layer.blendMode = value;
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not set the blend mode: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }
  // Read back rather than echo: a silently rejected assignment is the failure mode
  // this plugin keeps hitting, and returning what was asked for would hide it.
  if (mapBlendMode(layer.blendMode) !== ctx.params.mode) {
    throw StudioError(
      'STEP_FAILED',
      'Photoshop reports the blend mode of "' + layer.name + '" as "' + layer.blendMode + '" after setting "' + ctx.params.mode + '".',
      { recoverable: true, details: { requested: ctx.params.mode, actual: String(layer.blendMode) } },
    );
  }
  return describe(doc, layer);
}

/** `set_layer_fill_opacity` */
function setLayerFillOpacity(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);

  var value = ctx.params.opacity;
  if (typeof value !== 'number' || value < 0 || value > 100) {
    throw StudioError('INVALID_PARAMS', 'Fill opacity must be between 0 and 100, received ' + value);
  }
  try {
    layer.fillOpacity = value;
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not set fill opacity: ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }
  if (Math.abs(Number(layer.fillOpacity) - value) > 0.6) {
    throw StudioError(
      'STEP_FAILED',
      'Photoshop reports the fill opacity of "' + layer.name + '" as ' + layer.fillOpacity + ' after setting ' + value + '.',
      { recoverable: true, details: { requested: value, actual: Number(layer.fillOpacity) } },
    );
  }
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



/**
 * `duplicate_layers` — copy a layer, named and placed.
 *
 * The DOM's `duplicate` returns the new layer, which is what makes this checkable:
 * a copy that appeared somewhere unexpected, or that Photoshop named differently,
 * is visible in the result rather than inferred from a layer count.
 */
function duplicateLayers(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);

  var where = ctx.params.placement || 'placeAtEnd';
  var copy;

  try {
    copy = layer.duplicate(undefined, placement(where));
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not duplicate "' + layer.name + '": ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }

  return ps
    .resolveCreatedLayer(doc, copy)
    .then(function (created) {
      if (!created) {
        throw StudioError('STEP_FAILED', 'Photoshop reported a duplicate of "' + layer.name + '" but the copy could not be found.');
      }
      if (ctx.params.name && String(created.name) !== String(ctx.params.name)) {
        try {
          created.name = ctx.params.name;
        } catch (err) {
          throw StudioError('STEP_FAILED', 'The copy was made but could not be named "' + ctx.params.name + '": ' + ((err && err.message) || String(err)), {
            recoverable: true,
          });
        }
      }
      return describe(doc, created);
    });
}

/**
 * `apply_image` — composite another open document's pixels onto a layer.
 *
 * Destructive in the way `apply_filter` is not: this *replaces* the layer's pixels
 * rather than filtering them, which is why the registry asks for confirmation.
 *
 * `layer.applyImage(name, options)` takes a document **name**, not a reference, so
 * the source has to be open and the name has to match exactly. Options are passed
 * through only when asked for, since an empty object is not the same as none and
 * this build's defaults are not documented.
 */
function applyImage(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertMutable(layer);

  var sourceName = ctx.params.sourceName;
  if (!ps.findDocumentByName(sourceName)) {
    throw StudioError(
      'INVALID_PARAMS',
      'No open document named "' + sourceName + '". apply_image composites an already-open document; open it in Photoshop first.',
      { details: { open: ps.openDocumentNames() } },
    );
  }

  var options = {};
  if (ctx.params.offset) options.offset = { x: ctx.params.offset.x, y: ctx.params.offset.y };
  if (ctx.params.scale) options.scale = { x: ctx.params.scale.x, y: ctx.params.scale.y };
  if (ctx.params.blendMode) options.blendMode = mapBlendMode(ctx.params.blendMode);
  if (typeof ctx.params.opacity === 'number') options.opacity = ctx.params.opacity;

  try {
    layer.applyImage(sourceName, options);
  } catch (err) {
    throw StudioError(
      'STEP_FAILED',
      'Photoshop would not apply "' + sourceName + '" onto "' + layer.name + '": ' + ((err && err.message) || String(err)),
      { recoverable: true },
    );
  }

  return describe(doc, layer);
}

/**
 * `set_layer_locking` — lock a layer against accidental edits.
 *
 * The DOM takes a flags object rather than a mode, so the mode is translated here.
 * Which flags exist is a host detail: 26.11 accepts all three but only reports
 * `locked` back, which is why the derived expectation only covers `all` and `none`.
 */
function setLayerLocking(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  var lock = ctx.params.lock;
  ps.assertMutable(layer);

  if (!layer || typeof layer.setLocking !== 'function') {
    throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build cannot lock layers.', { recoverable: false });
  }

  // Every call sets every flag, so `none` means "all false" and `all` means
  // "all true" rather than only touching the one asked about: a later `position`
  // lock must not silently release an existing `all` lock.
  var flags = {
    all: lock === 'all',
    position: lock === 'all' || lock === 'position',
    transparency: lock === 'all' || lock === 'transparency',
  };

  try {
    layer.setLocking(flags);
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not change the locking on "' + layer.name + '": ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }

  // `layer.locked` does not follow `setLocking` on this build: Photoshop accepts
  // the flags and keeps reporting `false`. That is a gap in what the host will
  // tell us, not proof the lock failed, so it is reported rather than turned into
  // an error — refusing here would make the tool unusable for a working feature.
  // It is also why this tool has no derived expectation: there is nothing to check
  // the request against.
  var info = describe(doc, layer);
  info.locking = { all: flags.all, position: flags.position, transparency: flags.transparency };
  info.lockReported = layer.locked === true;
  return info;
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
  set_layer_blend_mode: setLayerBlendMode,
  set_layer_fill_opacity: setLayerFillOpacity,
  set_layer_locking: setLayerLocking,
  duplicate_layers: duplicateLayers,
  apply_image: applyImage,
  mapBlendMode: mapBlendMode,
  withActiveLayer: withActiveLayer,
  create_group: createGroup,
  move_layer_to_group: moveLayerToGroup,
  reorder_layer: reorderLayer,
  placement: placement,
  translateBy: translateBy,
  scaleBy: scaleBy,
};
