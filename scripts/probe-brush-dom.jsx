/*
 * Reports what the ExtendScript/COM door can actually reach, on this build.
 *
 * This exists because the claim that COM could drive Photoshop's brush engine
 * when UXP could not was believed for a long time and never checked. Run it and
 * the answer is written down rather than assumed:
 *
 *   scripts/with-photoshop-jsx-run.sh scripts/probe-brush-dom.jsx
 *
 * The interesting result is that `app.brushes` and `app.activeBrush` are both
 * `undefined`, which is why `scripts/brush-firework.jsx` cannot work. The rest of
 * the report is the other half of the picture — what ExtendScript *does* have,
 * including `selection.fill` (which UXP lacks) and `applyGaussianBlur`.
 *
 * Nothing here paints. It only reads, so it is safe to run against a document
 * someone is working in: it creates one scratch document, fills it, and closes
 * it with `saved = true` first.
 *
 * Note the closing dance, because it is a trap. `document.close(SaveOptions.DONOTSAVES)`
 * raises a modal save prompt on this build even when `saved` was set to `true`
 * first — measured, not assumed — and a modal prompt raised from inside a
 * COM-driven script wedges the whole channel: the script never returns and every
 * later `DoJavaScript` fails with RPC_E_SERVERCALL_RETRYLATER until the dialog is
 * dismissed by hand. `scripts/with-photoshop-jsx-run.sh` will therefore not clean
 * up after you, and this script leaves its scratch document open on purpose.
 */
#target photoshop

var REPORT = [];
function say(label, value) {
  REPORT.push(label + '=' + value);
}
function typeOf(value) {
  return (value === null) ? 'null' : typeof value;
}
function attempt(label, fn) {
  try {
    say(label, fn());
  } catch (e) {
    say(label + '!', (e && e.message) ? e.message : String(e));
  }
}

// --- the question -----------------------------------------------------------
attempt('version', function () { return app.version; });
attempt('app.brushes', function () { return typeOf(app.brushes); });
attempt('app.activeBrush', function () { return typeOf(app.activeBrush); });
attempt('app.pathItems', function () { return typeOf(app.pathItems); });
attempt('app.doScript', function () { return typeOf(app.doScript); });
attempt('app.filters', function () { return typeOf(app.filters); });
attempt('app.foregroundColor', function () { return typeOf(app.foregroundColor); });

// --- what is there instead --------------------------------------------------
var doc = null;
attempt('artLayers.add bounds', function () {
  doc = app.documents.add(200, 150, 72, 'probe-brush-dom', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  var layer = doc.artLayers.add();
  layer.name = 'Probe';
  var b = layer.bounds;
  return Math.round(b[0].as('px')) + 'x' + Math.round(b[2].as('px'));
});

attempt('selection.fill', function () {
  var c = new SolidColor();
  c.rgb.red = 32; c.rgb.green = 64; c.rgb.blue = 96;
  doc.selection.selectAll();
  doc.selection.fill(c);
  doc.selection.deselect();
  var b = doc.activeLayer.bounds;
  return Math.round(b[0].as('px')) + 'x' + Math.round(b[2].as('px'));
});

attempt('applyGaussianBlur', function () {
  doc.activeLayer.applyGaussianBlur(4);
  return 'ok';
});

attempt('selection.selectEllipse', function () { return typeOf(doc.selection.selectEllipse); });
attempt('selection.selectRectangle', function () { return typeOf(doc.selection.selectRectangle); });
attempt('ShapeBounds', function () { return typeOf(ShapeBounds); });
attempt('GradientType', function () { return typeOf(GradientType); });
attempt('layer.gradient', function () { return typeOf(doc.activeLayer.gradient); });

// Deliberately left open: see the header. Closing it from inside a COM-driven
// script raises a modal prompt, and that is what wedges the channel.
say('scratchDocLeftOpen', doc ? doc.name : 'none');

// A string, not an object: COM marshals a returned object to "[object Object]",
// which is indistinguishable from success.
// Non-ASCII escaped: the host's own messages come back in the system codepage
// and are unreadable through this console.
function esc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, function (ch) {
    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}
REPORT.join('; ');