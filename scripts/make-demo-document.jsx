/**
 * Test fixture: builds `banner.psd` in a running Photoshop.
 *
 * WHY THIS EXISTS: the brief's §29 demo starts from a document that is already
 * open. On a fresh machine there is no such document, and a fixture is needed
 * before anything can be verified. This script is a *fixture builder*, not
 * product code — every operation under test (rename, move, opacity, canvas,
 * export) and every verification goes through the real MCP pipeline afterwards.
 *
 * It is ExtendScript rather than UXP because it can be driven headlessly through
 * COM (`Photoshop.Application.DoJavaScriptFile`), which the plugin's panel button
 * cannot. A human clicking "Create demo document" in the panel gets the same
 * document from the product's own code path (`photoshop-plugin/lib/demo.js`).
 *
 * Invoked by scripts/with-photoshop.jsx-fixture.sh — not run by hand.
 */
#target photoshop

app.displayDialogs = DialogModes.NO;

// `FOLDER()` does not exist in the ExtendScript global scope, so the destination
// is injected by the caller (scripts/with-photoshop-jsx.sh) as a literal. Using a
// hard-coded path instead would make this fixture unusable anywhere but this
// machine, and silently claim success somewhere it did not run.
if (typeof FIXTURE_OUTPUT === 'undefined') {
  throw new Error('FIXTURE_OUTPUT is not defined; run this via scripts/with-photoshop-jsx.sh');
}

(function buildDemo() {
  var W = 1920;
  var H = 1080;

  // Start clean: close any open document without prompting.
  while (app.documents.length > 0) {
    app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
  }

  var doc = app.documents.add(W, H, 72, 'banner.psd', NewDocumentMode.RGB, DocumentFill.WHITE);

  // The new document already has a Background layer.
  doc.activeLayer.name = 'Background';

  var specs = [
    { name: 'Logo', x: 120, y: 80, w: 320, h: 120, r: 62, g: 126, b: 224 },
    { name: 'Title', x: 120, y: 300, size: 96, text: 'Spring Sale', r: 20, g: 20, b: 24 },
    { name: 'Subtitle', x: 120, y: 440, size: 40, text: 'Up to 50% off everything', r: 60, g: 60, b: 66 },
    { name: 'CTA', x: 120, y: 560, size: 28, text: 'Shop now', r: 255, g: 255, b: 255 }
  ];

  for (var i = 0; i < specs.length; i++) {
    if (specs[i].text !== undefined) {
      addText(doc, specs[i]);
    } else {
      addRect(doc, specs[i]);
    }
  }

  var summary = [];
  for (var j = 0; j < doc.layers.length; j++) {
    summary.push(doc.layers[j].name);
  }

  // Written to disk rather than returned: COM cannot hand a value back cleanly.
  var marker = new File(FIXTURE_OUTPUT);
  marker.encoding = 'UTF-8';
  if (!marker.open('w')) {
    throw new Error('could not open ' + FIXTURE_OUTPUT + ' for writing');
  }
  marker.write(doc.name + '|' + doc.width + 'x' + doc.height + '|' + summary.join(','));
  marker.close();

  // `documents.add` already leaves the new document active; there is no
  // `activate()` on a Document in ExtendScript.
  app.displayDialogs = DialogModes.ALL;
})();

function addRect(doc, spec) {
  var layer = doc.artLayers.add();
  layer.name = spec.name;

  var solid = new SolidColor();
  solid.rgb.red = spec.r;
  solid.rgb.green = spec.g;
  solid.rgb.blue = spec.b;

  doc.activeLayer = layer;
  doc.selection.select([[spec.x, spec.y], [spec.x + spec.w, spec.y], [spec.x + spec.w, spec.y + spec.h], [spec.x, spec.y + spec.h]]);
  doc.selection.fill(solid, ColorBlendMode.NORMAL, 100, false);
  doc.selection.deselect();
}

function addText(doc, spec) {
  var layer = doc.artLayers.add();
  layer.kind = LayerKind.TEXT;
  layer.name = spec.name;
  layer.textItem.contents = spec.text;
  layer.textItem.size = spec.size;
  layer.textItem.color.rgb.red = spec.r;
  layer.textItem.color.rgb.green = spec.g;
  layer.textItem.color.rgb.blue = spec.b;
  // Position is the baseline origin, in points, from the canvas top-left.
  layer.textItem.position = [spec.x, spec.y + spec.size];
}
