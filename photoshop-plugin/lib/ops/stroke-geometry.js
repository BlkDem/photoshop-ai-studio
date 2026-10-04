/**
 * Pure geometry for turning a path into brush stamps.
 *
 * This module touches nothing from `require('photoshop')`. It has no side
 * effects and no host calls, which is what makes the drawing path testable:
 * every decision that decides *where ink lands* lives here, and the tests in
 * `photoshop-plugin/test/stroke-geometry.test.ts` exercise all of it without a
 * Photoshop licence.
 *
 * ## Why discs instead of rectangles
 *
 * A brush stroke is a swept disc: round at the ends, round at the corners, and
 * variable in width when pressure is simulated. The previous implementation
 * filled one axis-aligned rectangle per path segment, which produced square
 * ends and a notch at every corner where two rectangles met at an angle.
 * Overlapping discs reproduce a swept round brush exactly, and a disc is the
 * one shape the UXP selection API can express directly (`selection.selectEllipse`).
 *
 * ## Why the disc spacing is a function of the radius
 *
 * Discs of radius `r` placed `d` apart leave no gap only while `d < 2r`. Stepping
 * at a fixed pixel count instead means a 3px brush gets a dotted line and a
 * 300px brush gets a couple of hundred needless fills. `stampSpacing` therefore
 * scales with the radius, which is also what keeps the number of fills — and so
 * the wall-clock cost of a stroke — proportional to the stroke's length rather
 * than exploding with brush size.
 */
'use strict';

/** A stamp is one disc to fill: centre, radius, and the pressure that produced it. */
function makeStamp(x, y, radius, pressure) {
  return { x: x, y: y, r: Math.max(0.5, radius), p: Math.max(0, Math.min(1, pressure)) };
}

function distance(a, b) {
  var dx = b.x - a.x;
  var dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Samples one cubic Bézier segment.
 *
 * The adapter's `curve` segment carries `cp1`, `cp2` and an end `point`; the
 * previous implementation kept only `point`, so every curve the model asked for
 * was drawn as the straight chord between its endpoints. The number of samples
 * follows the control polygon's length, so a long curve gets a smooth line and
 * a nearly-straight one costs a single segment.
 */
function flattenCubic(from, cp1, cp2, to, out) {
  var controlLength =
    distance(from, cp1) + distance(cp1, cp2) + distance(cp2, to);
  var steps = Math.max(2, Math.min(64, Math.ceil(controlLength / 3)));

  for (var i = 1; i <= steps; i += 1) {
    var t = i / steps;
    var mt = 1 - t;
    var a = mt * mt * mt;
    var b = 3 * mt * mt * t;
    var c = 3 * mt * t * t;
    var d = t * t * t;
    out.push({
      x: a * from.x + b * cp1.x + c * cp2.x + d * to.x,
      y: a * from.y + b * cp1.y + c * cp2.y + d * to.y,
    });
  }
}

/**
 * Turns `stroke_path` segments into a dense polyline of `{x, y}` points.
 *
 * A `move` starts a new subpath: the pen left the paper, so the gap before it
 * must not be inked. A `line` continues, and a `curve` continues through its
 * control points. Subpaths are returned as one flat list plus the indices where
 * each begins, which is what lets the stamper skip the gaps.
 */
function flattenSegments(segments) {
  var points = [];
  var starts = [];
  var cursor = null;

  for (var i = 0; i < segments.length; i += 1) {
    var seg = segments[i];
    if (!seg) continue;

    if (seg.type === 'move') {
      if (!seg.point) continue;
      starts.push(points.length);
      points.push({ x: seg.point.x, y: seg.point.y });
      cursor = seg.point;
    } else if (seg.type === 'line') {
      if (!seg.point) continue;
      if (!cursor) {
        // A path that opens with a `line` has no starting point yet; the
        // segment's own endpoint is the only position we know.
        starts.push(points.length);
        cursor = seg.point;
      }
      points.push({ x: seg.point.x, y: seg.point.y });
      cursor = seg.point;
    } else if (seg.type === 'curve') {
      if (!seg.point) continue;
      if (!cursor) {
        starts.push(points.length);
        points.push({ x: seg.point.x, y: seg.point.y });
        cursor = seg.point;
        continue;
      }
      if (seg.cp1 && seg.cp2) {
        flattenCubic(cursor, seg.cp1, seg.cp2, seg.point, points);
      } else {
        points.push({ x: seg.point.x, y: seg.point.y });
      }
      cursor = seg.point;
    }
  }

  return { points: points, starts: starts };
}

/**
 * Maps the public `smoothing` knob (0-100) onto a pass count.
 *
 * The knob is a 0-100 dial, but every pass of `smoothPoints` roughly doubles
 * the point count. Handing the raw value in as a pass count turns a perfectly
 * ordinary `smoothing: 40` into 2^40 points, and the stroke never returns — the
 * operator sees a hung Photoshop rather than a smooth line. A quadratic
 * B-spline is visually converged after a handful of passes, so the dial is
 * mapped onto that range and nothing above it can explode.
 */
function smoothingIterations(smoothing) {
  var value = Number(smoothing);
  if (!isFinite(value) || value <= 0) return 0;
  // Any positive value earns at least one pass: a caller who asks for a little
  // smoothing and gets a perfectly jaggy line has been ignored, which is the
  // one outcome worse than too much of it.
  return Math.min(4, Math.max(1, Math.round(value / 25)));
}

/**
 * Chaikin corner-cutting, run `iterations` times.
 *
 * This is what `paint_stroke`'s `smoothing` knob drives: it is the same
 * iterative scheme a drawing tablet's smoothing does, and it converges on a
 * quadratic B-spline. Each pass replaces every interior point with two points
 * at the quarter positions of its neighbours. Subpath boundaries are preserved
 * so smoothing never bridges a `move`.
 *
 * `iterations` is a pass count, not the user-facing dial: callers go through
 * `smoothingIterations` first.
 */
function smoothPoints(points, starts, iterations) {
  if (iterations <= 0 || points.length < 3) return { points: points, starts: starts };

  var current = points;
  var boundaries = starts.length > 0 ? starts.slice() : [0];

  for (var pass = 0; pass < iterations; pass += 1) {
    var next = [];
    var nextBoundaries = [];

    for (var s = 0; s < boundaries.length; s += 1) {
      var from = boundaries[s];
      var to = s + 1 < boundaries.length ? boundaries[s + 1] : current.length;
      var run = current.slice(from, to);
      if (run.length === 0) continue;

      nextBoundaries.push(next.length);

      // Fewer than three points means no corner to cut, so the subpath is kept
      // verbatim. Dropping it instead would delete a perfectly good straight
      // segment, and a `move`/`line` pair is exactly that.
      if (run.length < 3) {
        for (var k = 0; k < run.length; k += 1) next.push(run[k]);
        continue;
      }

      next.push(run[0]);
      for (var i = 0; i < run.length - 1; i += 1) {
        var a = run[i];
        var b = run[i + 1];
        next.push({
          x: a.x * 0.75 + b.x * 0.25,
          y: a.y * 0.75 + b.y * 0.25,
        });
        next.push({
          x: a.x * 0.25 + b.x * 0.75,
          y: a.y * 0.25 + b.y * 0.75,
        });
      }
      next.push(run[run.length - 1]);
    }

    current = next;
    boundaries = nextBoundaries;
  }

  return { points: current, starts: boundaries };
}

/**
 * Removes points that sit closer together than `tolerance`.
 *
 * Bézier flattening oversamples; the mock's `points` array can arrive with the
 * same coordinate hundreds of times when a plan replays a mouse drag. Dropping
 * them keeps the stamp count proportional to real distance travelled.
 */
function dropDuplicatePoints(points, starts, tolerance) {
  if (points.length === 0) return { points: points, starts: starts };
  var minGap = Math.max(0, tolerance);
  var kept = [points[0]];
  var keptStarts = [0];

  for (var i = 1; i < points.length; i += 1) {
    var isSubpathStart = starts.indexOf(i) !== -1;
    if (isSubpathStart || distance(kept[kept.length - 1], points[i]) >= minGap) {
      if (isSubpathStart) keptStarts.push(kept.length);
      kept.push(points[i]);
    }
  }

  return { points: kept, starts: keptStarts };
}

/**
 * The pressure profile along a stroke, 0 at both ends and 1 in the middle.
 *
 * `simulatePressure` means "the pen touched down and lifted off", so the width
 * has to ease in and out rather than starting at full size like a rectangle
 * stamp. `sin(πt)` gives the smoothest ramp, which is why it is used instead of
 * a piecewise ramp: a linear ramp leaves a visible kink where it meets the flat
 * middle.
 */
function pressureAt(t) {
  return Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
}

/** How far apart to place discs of the given radius so none of them separate. */
function stampSpacing(radius) {
  return Math.max(0.35, Math.min(radius, radius * 0.4));
}

/**
 * Walks each subpath and emits overlapping discs along it.
 *
 * `onStamp` is called once per disc with its centre, radius and pressure, in
 * path order, so the caller decides what to do with the ink. Returning `false`
 * from the callback aborts the walk — which is how the caller caps the work on a
 * path that would otherwise need tens of thousands of fills.
 *
 * The subpath's own length is what drives the pressure ramp, not the whole
 * stroke, so a stroke of two separate marks tapers each of them.
 */
function eachStamp(points, starts, options, onStamp) {
  var radius = Math.max(0.5, options.radius || 1);
  var simulatePressure = options.simulatePressure === true;
  var maxStamps = options.maxStamps || 4000;
  var emitted = 0;
  var aborted = false;

  function stop() {
    aborted = true;
  }

  for (var s = 0; s < starts.length && !aborted; s += 1) {
    var from = starts[s];
    var to = s + 1 < starts.length ? starts[s + 1] : points.length;
    var run = points.slice(from, to);
    if (run.length === 0) continue;

    var length = 0;
    for (var k = 1; k < run.length; k += 1) length += distance(run[k - 1], run[k]);

    // A single-point subpath is a dot, not a stroke: a real brush leaves a
    // round mark when you click without dragging.
    if (run.length === 1 || length < 0.5) {
      var dotRadius = radius * (simulatePressure ? 0.15 : 1);
      if (emitted < maxStamps) {
        onStamp(makeStamp(run[0].x, run[0].y, dotRadius, 1), 0);
        emitted += 1;
      } else {
        stop();
      }
      continue;
    }

    // `walked` is the distance from the subpath's first point to the point the
    // walk is currently at, and never resets: it is what the pressure ramp is
    // read against.
    var walked = 0;

    for (var i = 1; i < run.length && !aborted; i += 1) {
      var a = run[i - 1];
      var b = run[i];
      var segLength = distance(a, b);
      if (segLength < 1e-6) continue;

      var segmentStart = walked;

      while (true) {
        // Pressure is sampled *before* stepping, so the narrowest disc on the
        // stroke — the one at a tapered end — is also the one that sets the
        // spacing. Sampling after the step would let the spacing stay wide while
        // the disc shrank, which is exactly how a tapered end ends up dotted.
        var pressure = simulatePressure ? pressureAt((segmentStart + 0) / length) : 1;
        if (pressure < 0.02) pressure = 0.02;
        var step = stampSpacing(radius * pressure);

        var remaining = segLength - (walked - segmentStart);
        if (remaining <= 1e-9) break;

        var advance = Math.min(step, remaining);
        walked += advance;

        var along = (walked - segmentStart) / segLength;
        var stampPressure = simulatePressure ? pressureAt(walked / length) : 1;

        if (emitted >= maxStamps) {
          aborted = true;
          break;
        }
        onStamp(
          makeStamp(
            a.x + (b.x - a.x) * along,
            a.y + (b.y - a.y) * along,
            radius * stampPressure,
            stampPressure
          ),
          emitted
        );
        emitted += 1;
      }
    }
  }

  return { emitted: emitted, truncated: aborted };
}

/**
 * Splits a polyline into the sample points used to verify that ink landed.
 *
 * Verification cannot afford to sample every pixel of a 300px brush, so it walks
 * the centreline at a bounded stride and reads the colour there. Points closer
 * together than `stride` are skipped so the samples spread along the stroke
 * rather than bunching at its start.
 */
function verificationPoints(points, starts, stride) {
  var gap = Math.max(1, stride || 1);
  var out = [];

  for (var s = 0; s < starts.length; s += 1) {
    var from = starts[s];
    var to = s + 1 < starts.length ? starts[s + 1] : points.length;
    var run = points.slice(from, to);
    if (run.length === 0) continue;

    out.push(run[0]);
    var accumulated = 0;
    for (var i = 1; i < run.length; i += 1) {
      accumulated += distance(run[i - 1], run[i]);
      if (accumulated >= gap) {
        out.push(run[i]);
        accumulated = 0;
      }
    }
    var last = run[run.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
  }

  return out;
}

/**
 * The full path-to-stamps pipeline, in the order the operations depend on it.
 *
 * flatten → smooth → dedupe → stamps, with the verification polyline derived
 * from the same geometry that produced the stamps, so what gets verified is
 * exactly what was drawn.
 */
function buildStroke(segments, points, options) {
  var settings = options || {};
  var radius = Math.max(0.5, (settings.brushSize || 5) / 2);

  var flat = points
    ? { points: points.slice(), starts: [0] }
    : flattenSegments(segments || []);

  var smoothed = smoothPoints(flat.points, flat.starts, smoothingIterations(settings.smoothing));
  var cleaned = dropDuplicatePoints(smoothed.points, smoothed.starts, 0.01);

  var stamps = [];
  var walk = eachStamp(
    cleaned.points,
    cleaned.starts,
    {
      radius: radius,
      simulatePressure: settings.simulatePressure === true,
      maxStamps: settings.maxStamps || 4000,
    },
    function (stamp) {
      stamps.push(stamp);
    }
  );

  return {
    points: cleaned.points,
    starts: cleaned.starts,
    stamps: stamps,
    truncated: walk.truncated,
    radius: radius,
    verificationPoints: verificationPoints(cleaned.points, cleaned.starts, Math.max(1, radius / 2)),
  };
}

module.exports = {
  flattenSegments: flattenSegments,
  smoothingIterations: smoothingIterations,
  smoothPoints: smoothPoints,
  dropDuplicatePoints: dropDuplicatePoints,
  eachStamp: eachStamp,
  verificationPoints: verificationPoints,
  buildStroke: buildStroke,
  pressureAt: pressureAt,
  stampSpacing: stampSpacing,
  distance: distance,
};