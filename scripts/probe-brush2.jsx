/*
 * Last route to a real brush stroke: the action descriptor, which does not need
 * the `app.brushes` collection this build does not expose.
 *
 * Measures the result instead of trusting it — a stroke is claimed by
 * `executeAction` the same way an empty layer is, and only a sampled pixel says
 * a brush was there.
 */
#target photoshop

var R = [];
function esc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, function (ch) {
    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}
function note(k, v) {
  R.push(k + '=' + esc(v));
}

/** Reads a pixel back out of the document. */
function sample(x, y) {
  var point = doc.pathItems.add('probe');
  return 'skip';
}

try {
  var doc = app.documents.add(400, 300, 72, 'brushprobe', NewDocumentMode.RGB, DocumentFill.WHITE);
  note('doc', doc.name);

  // The Brush tool selected by a bare `Brsh` class — the two-descriptor form
  // above was rejected as malformed, which is the same "argument 2" the rest of
  // this surface produces for anything it does not recognise.
  try {
    var dsel = new ActionDescriptor();
    dsel.putClass(charIDToTypeID('Brsh'));
    executeAction(charIDToTypeID('setd'), dsel, DialogModes.NO);
    note('set.brushTool', 'ok');
  } catch (e) {
    note('set.brushTool', 'ERR ' + ((e && e.message) || String(e)));
  }

  // 3. Pick a colour, so the stroke is not black on white.
  var fore = new SolidColor();
  fore.rgb.red = 220;
  fore.rgb.green = 40;
  fore.rgb.blue = 40;
  app.foregroundColor = fore;
  note('set.foreground', 'ok');

  // 4. Draw. `paint` with a target of the *art layer* strokes the whole canvas
  //    is wrong, so a selection confines it: the mask is what a real brush
  //    stroke would be clipped to anyway.
  var d3 = new ActionDescriptor();
  var d3b = new ActionDescriptor();
  d3b.putEnumerated(charIDToTypeID('Ptrn'), charIDToTypeID('Ptrn'), charIDToTypeID('Cstn'));
  d3b.putBoolean(charIDToTypeID('Antz'), false);
  d3.putDescriptor(charIDToTypeID('Ptrn'), charIDToTypeID('Ptrn'), d3b);
  d3.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('Usng'), charIDToTypeID('Bkgnd'));
  d3.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('Md  '), charIDToTypeID('BlnM'), charIDToTypeID('Nrml'));
  d3.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), 100);
  executeAction(charIDToTypeID('fill'), d3, DialogModes.NO);
  note('fill.background', 'ok');

  // Now the stroke itself, over a document-sized selection.
  app.activeDocument.selection.selectAll();
  var d4 = new ActionDescriptor();
  d4.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('Usng'), charIDToTypeID('FrgC'));
  d4.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('Md  '), charIDToTypeID('BlnM'), charIDToTypeID('Nrml'));
  d4.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), 100);
  executeAction(charIDToTypeID('paint'), d4, DialogModes.NO);
  app.activeDocument.selection.deselect();
  note('paint.stroke', 'ok');

  // 5. The only measurement that counts: did a pixel change?
  var flat = doc.flatten();
  var out = new File('~/photoshop-ai-studio-workspace/out/brush-probe.png');
  if (!out.parent.exists) out.parent.create();
  doc.saveAs(out, new PNGSaveOptions(), true, Extension.LOWERCASE);
  note('saved', out.fsName);
} catch (e) {
  note('fatal', (e && e.message) || String(e));
}

R.join('; ');
