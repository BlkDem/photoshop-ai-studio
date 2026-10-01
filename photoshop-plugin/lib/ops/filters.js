/**
 * Filters, layer transforms and colour sampling.
 *
 * All of this is the UXP DOM, not `batchPlay`, and that is the whole point: the
 * `Layer` object exposes about thirty-five `apply*` methods, `document.crop`,
 * `trim`, `flatten`, `mergeVisibleLayers`, `changeMode` and `sampleColor`, and
 * every one of them actually performs its operation on Photoshop 26.11. The
 * descriptor route to the same results does not — see the platform boundary in
 * `docs/architecture.md`.
 *
 * Filters are destructive and there is no undo here: the DOM exposes no history,
 * so a filter applied to the wrong layer cannot be taken back. Every one of these
 * tools is therefore gated on confirmation, and the descriptions say why.
 */
'use strict';

var ps = require('../ps.js');
var StudioError = require('../errors.js').StudioError;

/** Photoshop's own names for the values our vocabulary has to translate. */
var INTERPOLATION = {
  nearestNeighbor: 'nearestNeighbor',
  bilinear: 'bilinear',
  bicubic: 'bicubic',
};

/** Every value the filters take is an enum, and none of them is the lowercased name. */
function filterEnum(enumName, key) {
  return ps.enumValue(enumName, key);
}
var TRIM_TYPE = {
  transparent: 'transparent',
  topLeftColor: 'topLeftColor',
  bottomRightColor: 'bottomRightColor',
};
var COLOR_MODE = { RGB: 'RGB', CMYK: 'CMYK', GRAYSCALE: 'GRAYSCALE', LAB: 'LAB', BITMAP: 'BITMAP' };

/**
 * Calls a layer method that has to be handed the active layer first.
 *
 * Same reason as `translateBy`: the DOM's per-layer operations act on the
 * selected layer, and given an unselected one they return normally having done
 * nothing.
 */
function onLayer(layer, fn) {
  return require('./layers.js').withActiveLayer(layer, fn);
}

function filterError(filter, layer, err) {
  return StudioError(
    'STEP_FAILED',
    'Photoshop would not apply "' + filter + '" to "' + layer.name + '": ' + ((err && err.message) || String(err)),
    { recoverable: true, details: { filter: filter, layer: layer.name } },
  );
}

/**
 * The single dispatch table from our vocabulary to the DOM's `apply*` methods.
 *
 * Written as data rather than a switch so the capability report and this table
 * can be checked against each other: a filter listed in one and not the other is
 * a filter the model is offered but cannot deliver.
 */
var FILTERS = {
  gaussianBlur: function (l, p) { return l.applyGaussianBlur(p.radius); },
  smartBlur: function (l, p) { return l.applySmartBlur(p.radius, p.threshold, filterEnum('Quality', p.quality)); },
  motionBlur: function (l, p) { return l.applyMotionBlur(filterEnum('MotionBlurUnits', 'degrees', p.angle + 'Degrees'), p.distance); },
  radialBlur: function (l, p) { return l.applyRadialBlur(p.amount, filterEnum('RadialBlurType', p.type)); },
  unsharpMask: function (l, p) { return l.applyUnSharpMask(p.amount, p.radius, p.threshold); },
  sharpen: function (l) { return l.applySharpen(); },
  sharpenMore: function (l) { return l.applySharpenMore(); },
  sharpenEdges: function (l) { return l.applySharpenEdges(); },
  addNoise: function (l, p) { return l.applyAddNoise(p.amount, filterEnum('NoiseDistribution', p.distribution), p.monochromatic === true); },
  medianNoise: function (l, p) { return l.applyMedianNoise(p.radius); },
  dustAndScratches: function (l, p) { return l.applyDustAndScratches(p.radius, p.threshold); },
  despeckle: function (l) { return l.applyDespeckle(); },
  speckle: function (l, p) { return l.applySpeckle(p.radius, p.amount); },
  highPass: function (l, p) { return l.applyHighPass(p.radius); },
  offset: function (l, p) { return l.applyOffset(p.horizontal, p.vertical); },
  twirl: function (l, p) { return l.applyTwirl(p.angle); },
  spherize: function (l, p) { return l.applySpherize(p.amount); },
  ripple: function (l, p) { return l.applyRipple(p.amount); },
  pinch: function (l, p) { return l.applyPinch(p.amount); },
  zigZag: function (l, p) { return l.applyZigZag(p.amount, filterEnum('ZigZagType', p.style)); },
  wave: function (l, p) { return l.applyWave(p.amplitude, p.wavelength); },
  shear: function (l, p) { return l.applyShear(p.degrees); },
  diffuseGlow: function (l, p) { return l.applyDiffuseGlow(p.amount, p.threshold); },
  maximum: function (l, p) { return l.applyMaximum(p.radius); },
  minimum: function (l, p) { return l.applyMinimum(p.radius); },
};

/** `apply_filter` */
function applyFilter(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertNotGroup(layer);
  ps.assertMutable(layer);

  var name = ctx.params.filter;
  var apply = FILTERS[name];
  if (!apply) {
    throw StudioError('UNSUPPORTED_OPERATION', 'This build cannot apply "' + name + '".', {
      details: { filter: name, available: Object.keys(FILTERS) },
      recoverable: false,
    });
  }

  var before = ps.boundsOf(layer);
  return onLayer(layer, function () {
    return Promise.resolve()
      .then(function () {
        return apply(layer, ctx.params);
      })
      .then(function () {
        return ps.layerInfo(layer, null);
      })
      .catch(function (err) {
        throw filterError(name, layer, err);
      });
  });
}

/** `flip_layer` */
function flipLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertNotGroup(layer);
  ps.assertMutable(layer);

  // The DOM wants the axis spelled out, not a boolean: "axis must be
  // 'horizontal', 'vertical', 'both'".
  var axis = ctx.params.direction === 'vertical' ? 'vertical' : 'horizontal';
  return onLayer(layer, function () {
    return Promise.resolve(layer.flip(axis)).then(function () {
      return ps.layerInfo(layer, null);
    });
  });
}

/** `rotate_layer` */
function rotateLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertNotGroup(layer);
  ps.assertMutable(layer);

  var angle = typeof ctx.params.angle === 'number' ? ctx.params.angle : 90;
  var interpolation = INTERPOLATION[ctx.params.interpolation] || ctx.params.interpolation || 'bilinear';
  return onLayer(layer, function () {
    // The DOM takes (angle, interpolation); a 90/180/270 turn has no
    // interpolation, which is why those are separate values there and not here.
    var isQuarterTurn = angle % 90 === 0;
    var result = isQuarterTurn
      ? layer.rotate(angle)
      : layer.rotate(angle, interpolation);
    return Promise.resolve(result).then(function () {
      return ps.layerInfo(layer, null);
    });
  });
}

/** `rasterize_layer` */
function rasterizeLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertNotGroup(layer);
  ps.assertMutable(layer);

  return onLayer(layer, function () {
    return Promise.resolve(layer.rasterize(layer)).then(function () {
      return ps.layerInfo(layer, null);
    });
  });
}

/** `sample_color` */
function sampleColor(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var x = ctx.params.x;
  var y = ctx.params.y;
  var radius = typeof ctx.params.radius === 'number' ? ctx.params.radius : 0;

  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) {
    throw StudioError(
      'INVALID_PARAMS',
      'Cannot sample at (' + x + ',' + y + '): the canvas is ' + doc.width + '×' + doc.height + '.',
    );
  }

  // `sampleColor` takes a *point object*, not loose coordinates: called with
  // `(x, y, radius, radius)` it reports "'position.x' is of type undefined".
  var sampled;
  try {
    sampled = doc.sampleColor({ x: x, y: y }, radius, radius);
  } catch (err) {
    throw StudioError('STEP_FAILED', 'Photoshop would not sample at (' + x + ',' + y + '): ' + ((err && err.message) || String(err)), {
      recoverable: true,
    });
  }

  return Promise.resolve(sampled)
    .then(function (solid) {
      if (!solid) {
        throw StudioError('STEP_FAILED', 'Photoshop returned no colour at (' + x + ',' + y + ').', { recoverable: true });
      }
      var rgb = toRgb(solid);
      return {
        color: rgb,
        hex: '#' + [rgb.r, rgb.g, rgb.b].map(function (c) {
          return ('0' + c.toString(16)).slice(-2);
        }).join(''),
      };
    })
    .catch(function (err) {
      if (err && err.name === 'StudioError') throw err;
      throw StudioError('STEP_FAILED', 'Could not read the colour: ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    });
}

/**
 * A `SolidColor` as RGB, whichever mode the document is in.
 *
 * `SolidColor` exposes its descriptor as JSON in `base` and nothing else — reading
 * `.rgb` off it yields undefined, which is the bug that made every text colour
 * report as black.
 */
function toRgb(solid) {
  var clamp = function (v) { return Math.max(0, Math.min(255, Math.round(Number(v) || 0))); };
  var descriptor = null;
  var base = solid && solid.base;
  if (typeof base === 'string') {
    try {
      descriptor = JSON.parse(base).desc;
    } catch (err) {
      descriptor = null;
    }
  } else if (base && typeof base === 'object') {
    descriptor = base.desc;
  }
  if (descriptor && descriptor._obj === 'RGBColor') {
    return { r: clamp(descriptor.red), g: clamp(descriptor.green), b: clamp(descriptor.blue) };
  }
  if (descriptor && descriptor._obj === 'CMYKColor') {
    var c = Number(descriptor.cyan) / 100;
    var m = Number(descriptor.magenta) / 100;
    var y = Number(descriptor.yellow) / 100;
    var k = Number(descriptor.black) / 100;
    return {
      r: clamp(255 * (1 - Math.min(1, c + k))),
      g: clamp(255 * (1 - Math.min(1, m + k))),
      b: clamp(255 * (1 - Math.min(1, y + k))),
    };
  }
  if (descriptor && descriptor._obj === 'GrayColor') {
    var gray = clamp(Number(descriptor.gray) * 255);
    return { r: gray, g: gray, b: gray };
  }
  if (solid && solid.rgb) {
    return { r: clamp(solid.rgb.red), g: clamp(solid.rgb.green), b: clamp(solid.rgb.blue) };
  }
  // Reached whenever Photoshop hands back nothing usable, which in practice means
  // the point had no pixels in it: an empty layer, a transparent region, a document
  // whose layers are all 0x0. "Could not interpret" describes this symptom, not the
  // cause, and cost an hour of looking for a colour-parsing bug that was not there.
  throw StudioError(
    'STEP_FAILED',
    'Photoshop returned no colour at that point. It is likely outside the canvas, or ' +
      'covering a layer that has no pixels in it — an empty or 0\u00d70 layer samples nothing.',
    { recoverable: true },
  );
}

module.exports = {
  apply_filter: applyFilter,
  flip_layer: flipLayer,
  rotate_layer: rotateLayer,
  rasterize_layer: rasterizeLayer,
  sample_color: sampleColor,
  toRgb: toRgb,
  FILTERS: FILTERS,
  TRIM_TYPE: TRIM_TYPE,
  COLOR_MODE: COLOR_MODE,
};