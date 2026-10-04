/**
 * Gradient geometry.
 *
 * A gradient is resolved into flat bands before anything is painted: a run of
 * rectangles for a linear ramp, a run of concentric ellipses for a radial one.
 * Each band carries the colour it is to be filled with, so the plugin and the
 * mock can both work from this list and lay down identical pixels.
 *
 * Why bands at all, when a gradient is by definition smooth? Because a band is a
 * selection plus a fill, and those are the only two primitives this host
 * actually performs (see the platform boundary in `docs/architecture.md`). The
 * seams are real, so `bands` trades them against speed, and the caller can blur
 * them afterwards.
 *
 * Pure: no UXP, no Photoshop. The mock mirrors this file, and the cross-check
 * test compares the two, so a disagreement here is a fill that looks different
 * in rehearsal than in the finished document.
 */
'use strict';

var MAX_BANDS = 256;
var BAND_EPSILON = 0.01;

/**
 * Sorts stops by position and clamps them to 0-100.
 *
 * Order is the caller's business, not the ramp's: two stops given back to front
 * describe the same gradient, and rejecting that would be pedantry. A stop past
 * either end is clamped rather than dropped — dropping it would silently change
 * which colour the far end lands on.
 */
function normalizeStops(stops) {
  var list = (stops || []).slice();
  var sorted = list
    .map(function (stop) {
      var position = Number(stop.position);
      if (!isFinite(position)) position = 0;
      return {
        position: Math.min(100, Math.max(0, position)),
        color: {
          r: Math.round(Math.max(0, Math.min(255, Number(stop.color.r) || 0))),
          g: Math.round(Math.max(0, Math.min(255, Number(stop.color.g) || 0))),
          b: Math.round(Math.max(0, Math.min(255, Number(stop.color.b) || 0))),
        },
      };
    })
    .sort(function (a, b) {
      return a.position - b.position;
    });

  // Everything at one position would make the ramp undefined; spread the first
  // two so there is always a direction to interpolate along.
  if (sorted.length >= 2 && sorted[0].position === sorted[1].position) {
    sorted[1] = {
      position: Math.min(100, sorted[0].position + BAND_EPSILON),
      color: sorted[1].color,
    };
  }

  return sorted;
}

/** The colour at `t` (0-1) along the ramp, interpolating between the stops. */
function colorAt(stops, t) {
  var clamped = Math.min(1, Math.max(0, Number(t)));
  if (clamped <= stops[0].position / 100) return stops[0].color;
  var last = stops[stops.length - 1];
  if (clamped >= last.position / 100) return last.color;

  for (var i = 0; i < stops.length - 1; i += 1) {
    var from = stops[i];
    var to = stops[i + 1];
    if (clamped < from.position / 100 || clamped > to.position / 100) continue;
    var span = (to.position - from.position) / 100;
    if (span <= 0) return to.color;
    var local = (clamped - from.position / 100) / span;
    return {
      r: Math.round(from.color.r + (to.color.r - from.color.r) * local),
      g: Math.round(from.color.g + (to.color.g - from.color.g) * local),
      b: Math.round(from.color.b + (to.color.b - from.color.b) * local),
    };
  }
  return last.color;
}

/** Bands are capped, so a caller asking for 5000 gets a coarser ramp and is told. */
function resolveBands(requested) {
  var asked = Math.round(Number(requested));
  if (!isFinite(asked) || asked < 2) asked = 2;
  var truncated = asked > MAX_BANDS;
  return { bands: Math.min(MAX_BANDS, asked), truncated: truncated };
}

/**
 * Axis-aligned unit vectors for the four exact directions.
 *
 * `y` grows downwards in document space, which is why `topToBottom` is (0, 1)
 * and not (0, -1).
 */
var AXES = {
  topToBottom: { x: 0, y: 1 },
  bottomToTop: { x: 0, y: -1 },
  leftToRight: { x: 1, y: 0 },
  rightToLeft: { x: -1, y: 0 },
};

/**
 * Rectangular bands spanning the canvas, one per step along the ramp.
 *
 * Bands are projected rather than sliced: the ramp runs along `axis`, and each
 * band covers the slice `[i/bands, (i+1)/bands]` of it. For the four axis
 * directions a slice is exactly a rectangle, so the bands tile the canvas with
 * no overlap and no gap.
 */
function linearBands(options) {
  var stops = normalizeStops(options.stops);
  var resolved = resolveBands(options.bands);
  var axis = AXES[options.direction] || AXES.topToBottom;
  var reverse = options.reverse === true;
  var width = options.width;
  var height = options.height;

  // The extent of the canvas along the ramp, so bands can be sized in pixels.
  var extent = axis.x !== 0 ? width : height;
  var bands = [];

  for (var i = 0; i < resolved.bands; i += 1) {
    var from = i / resolved.bands;
    var to = (i + 1) / resolved.bands;
    var start = from * extent;
    var end = to * extent;
    // Integer edges keep the bands meeting exactly; a shared fractional edge
    // would leave a one-pixel seam that no fill covers.
    var lo = Math.floor(start);
    var hi = i === resolved.bands - 1 ? extent : Math.floor(end);
    if (hi <= lo) continue;

    // `reverse` mirrors the ramp about its midpoint. Using the band's near edge
    // instead would only shift the ramp, leaving both ends the colour they were
    // already — a flip that does not flip.
    var mid = (from + to) / 2;
    var t = reverse ? 1 - mid : mid;
    bands.push({
      bounds: axis.x !== 0
        ? { left: lo, top: 0, right: hi, bottom: height }
        : { left: 0, top: lo, right: width, bottom: hi },
      color: colorAt(stops, t),
      t: t,
    });
  }

  return { bands: bands, truncated: resolved.truncated };
}

/**
 * Concentric ellipses from the centre outwards.
 *
 * Drawn largest-last so the innermost ellipse is the last thing painted into
 * the middle: painting outward would let each ring overlap the one inside it.
 * `reverse` swaps which end of the ramp sits at the centre.
 */
function radialBands(options) {
  var stops = normalizeStops(options.stops);
  var resolved = resolveBands(options.bands);
  var centerX = options.center && isFinite(options.center.x) ? options.center.x : options.width / 2;
  var centerY = options.center && isFinite(options.center.y) ? options.center.y : options.height / 2;
  var halfDiagonal = Math.sqrt(options.width * options.width + options.height * options.height) / 2;
  var radius = options.radius && options.radius > 0 ? options.radius : halfDiagonal;
  var reverse = options.reverse === true;

  var bands = [];
  for (var i = resolved.bands - 1; i >= 0; i -= 1) {
    var from = i / resolved.bands;
    var to = (i + 1) / resolved.bands;
    var r = radius * to;
    // `reverse` mirrors the ramp about its midpoint. Using the band's near edge
    // instead would only shift the ramp, leaving both ends the colour they were
    // already — a flip that does not flip.
    var mid = (from + to) / 2;
    var t = reverse ? 1 - mid : mid;
    bands.push({
      bounds: {
        left: centerX - r,
        top: centerY - r,
        right: centerX + r,
        bottom: centerY + r,
      },
      color: colorAt(stops, t),
      t: t,
    });
  }

  return { bands: bands, truncated: resolved.truncated };
}

/**
 * Points to sample before and after, spread along the ramp.
 *
 * Taken from the same geometry that produced the bands, so what is verified is
 * what was drawn. Radial fills are sampled on two rays so a ring drawn off
 * centre still shows up as a change.
 */
function verificationPoints(options, limit) {
  var cap = Math.max(2, Math.min(64, limit || 12));
  var points = [];

  if (options.type === 'radial') {
    var centerX = options.center && isFinite(options.center.x) ? options.center.x : options.width / 2;
    var centerY = options.center && isFinite(options.center.y) ? options.center.y : options.height / 2;
    var radius = options.radius && options.radius > 0 ? options.radius : Math.sqrt(options.width * options.width + options.height * options.height) / 2;
    for (var i = 0; i < cap; i += 1) {
      var t = cap === 1 ? 0 : i / (cap - 1);
      points.push({ x: Math.round(centerX + radius * t * 0.8), y: Math.round(centerY) });
      points.push({ x: Math.round(centerX), y: Math.round(centerY + radius * t * 0.8) });
    }
    return points;
  }

  var axis = AXES[options.direction] || AXES.topToBottom;
  var steps = Math.min(cap, 12);
  for (var k = 0; k < steps; k += 1) {
    var f = steps === 1 ? 0.5 : k / (steps - 1);
    if (axis.x !== 0) {
      points.push({ x: Math.round(f * options.width), y: Math.round(options.height / 2) });
    } else {
      points.push({ x: Math.round(options.width / 2), y: Math.round(f * options.height) });
    }
  }
  return points;
}

module.exports = {
  normalizeStops: normalizeStops,
  colorAt: colorAt,
  linearBands: linearBands,
  radialBands: radialBands,
  verificationPoints: verificationPoints,
  MAX_BANDS: MAX_BANDS,
};