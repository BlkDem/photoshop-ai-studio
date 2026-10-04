/*
 * Paints a firework with real brushes, through ExtendScript.
 *
 * The UXP surface the plugin drives has no brush, and this build's DOM layer
 * factories return 0×0 layers, so there is nowhere there to put a stroke.
 * ExtendScript reaches the same Photoshop through a different door and still has
 * `app.brushes`.
 *
 * The brush work is `PathItem.stroke(brush, color)` — Photoshop's own brush
 * engine painting along a path, with a real tip, not a shape being filled. Each
 * burst is a core of short bright strokes plus a halo of long soft ones, which
 * is what makes it read as an explosion rather than a starburst.
 *
 * If the brush engine refuses on this build, `brushUsed` comes back false and the
 * script says so rather than quietly drawing something else.
 */
#target photoshop

var REPORT = { brushUsed: false, strokes: 0, path: '', bursts: 0, error: '' };

try {
  var W = 1400;
  var H = 900;
  var BURSTS = [
    { x: 340, y: 250, core: 34, halo: 165, spokes: 26, size: 22, tip: 62, colours: [[255, 240, 150], [255, 178, 64], [255, 96, 78]] },
    { x: 905, y: 175, core: 26, halo: 130, spokes: 20, size: 15, tip: 44, colours: [[190, 232, 255], [104, 164, 255], [240, 156, 255]] },
    { x: 640, y: 470, core: 40, halo: 190, spokes: 30, size: 28, tip: 78, colours: [[220, 255, 178], [116, 222, 128], [255, 218, 108]] },
    { x: 1130, y: 415, core: 22, halo: 100, spokes: 17, size: 13, tip: 36, colours: [[255, 200, 236], [255, 126, 192]] },
  ];

  // A soft round tip is what makes a stroke read as light rather than ink. The
  // name differs between builds, so the brush list is searched rather than
  // guessed at, and what was chosen is reported.
  function pickBrush() {
    var wanted = ['Soft Round 46', 'Soft Round 30', 'Soft Round 21', 'Soft Round', 'Round 21', 'Soft Round 60'];
    for (var i = 0; i < wanted.length; i++) {
      try {
        var b = app.brushes.getByName(wanted[i]);
        if (b) return b;
      } catch (e) {
        /* not on this build */
      }
    }
    return app.brushes.length > 0 ? app.brushes[0] : null;
  }

  REPORT.bursts = -1;
  var brush = pickBrush();
  REPORT.bursts = -2;
  if (!brush) throw new Error('this build exposes no brushes at all');
  REPORT.bursts = -3;

  REPORT.bursts = -4;
  var doc = app.documents.add(W, H, 72, 'brush-firework', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  REPORT.bursts = -5;

  // Night sky. A solid fill, deliberately not a brush: covering 1400×900 with a
  // brush tip would take thousands of passes, and the exercise is the strokes.
  var sky = doc.artLayers.add();
  sky.name = 'Sky';
  var night = new SolidColor();
  night.rgb.red = 8;
  night.rgb.green = 13;
  night.rgb.blue = 32;
  doc.selection.selectAll();
  doc.selection.fill(night);
  doc.selection.deselect();

  REPORT.bursts = -6;
  REPORT.bursts = -7;

  function stroke(x0, y0, x1, y1, colour, width, opacity) {
    var p = doc.pathItems.add();
    var s = p.subPaths.add();
    s.closed = false;
    s.move([[x0, y0]]);
    var mid = [(x0 + x1) / 2, (y0 + y1) / 2];
    s.curve([[mid[0], mid[1]], [x1, y1]]);
    var c = new SolidColor();
    c.rgb.red = colour[0];
    c.rgb.green = colour[1];
    c.rgb.blue = colour[2];

    var tip = brush;
    if (width && width !== tip.size) {
      try {
        tip = app.brushes.getByName(brush.name);
        tip.size = width;
      } catch (e) {
        tip = brush;
      }
    }
    try {
      p.stroke(tip, c, true, false);
      p.remove();
      if (opacity !== undefined) REPORT.strokes++;
      return true;
    } catch (e) {
      p.remove();
      return false;
    }
  }

  var painted = 0;
  for (var f = 0; f < BURSTS.length; f++) {
    var b = BURSTS[f];
    var spoke = 0;
    for (var i = 0; i < b.spokes; i++) {
      var a = (i / b.spokes) * Math.PI * 2 + f * 0.37;
      // The burst is uneven: some spokes reach further, which is what stops it
      // looking like a compass rose.
      var reach = b.halo * (0.62 + 0.38 * Math.abs(Math.sin(i * 2.11 + f * 1.3)));
      var jitter = 0.72 + 0.28 * Math.abs(Math.cos(i * 1.7 + f));
      var tx = b.x + Math.cos(a) * reach * jitter;
      var ty = b.y + Math.sin(a) * reach * jitter;
      var colour = b.colours[i % b.colours.length];

      // Halo: long, thin, faint.
      if (stroke(b.x, b.y, tx, ty, colour, b.size, 40)) painted++;
      // Core: short, thick, bright — the hot centre.
      if (i % 2 === 0) {
        var inner = b.x + Math.cos(a) * b.core * 1.6;
        var innerY = b.y + Math.sin(a) * b.core * 1.6;
        if (stroke(b.x, b.y, inner, innerY, [255, 252, 232], b.tip * 0.45, 100)) painted++;
      }
      spoke++;
    }
    REPORT.bursts++;
  }

  REPORT.brushUsed = painted > 0;
  REPORT.strokes = painted;
  REPORT.path = 'brush:' + brush.name + '@' + Math.round(brush.size) + 'px';

  // Everything is in one mask; merge it down and flatten.
  try {
    set.remove();
  } catch (e) {
    /* container was already consumed */
  }
  doc.mergeVisibleLayers(ClippingMode.DISCARD);
  doc.flatten();

  var out = new File('~/photoshop-ai-studio-workspace/out/brush-firework.png');
  var folder = out.parent;
  if (!folder.exists) folder.create();
  var opts = new PNGSaveOptions();
  opts.compression = 6;
  doc.saveAs(out, opts, true, Extension.LOWERCASE);
} catch (e) {
  REPORT.error = (e && e.message) || String(e);
}

// A string, not an object: COM marshals a returned object to "[object Object]",
// which is indistinguishable from success.
// Non-ASCII escaped: the host's own messages come back in the system codepage
// and are unreadable through this console.
function esc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, function (ch) { return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4); });
}
'brushUsed=' + REPORT.brushUsed + '; strokes=' + REPORT.strokes + '; bursts=' + REPORT.bursts +
  '; brush=' + REPORT.path + '; error=' + esc(REPORT.error || 'none');
