/*
 * A brush stroke, with the smallest descriptor that could work.
 *
 * Everything measured on this build so far: UXP has no brush at all,
 * `app.brushes` is undefined under ExtendScript, the `Brsh` tool-selection
 * descriptor is rejected as malformed, and `ActionDescriptor.putDescriptor` is
 * absent. So this asks only for the `paint` action itself and reports whether
 * the saved file's pixels actually changed — `executeAction` claims success for
 * things that do nothing, which is the whole reason this checks.
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

try {
  var doc = app.documents.add(500, 400, 72, 'brush-stroke', NewDocumentMode.RGB, DocumentFill.WHITE);

  var fore = new SolidColor();
  fore.rgb.red = 210;
  fore.rgb.green = 30;
  fore.rgb.blue = 60;
  app.foregroundColor = fore;
  note('foreground', 'ok');

  // A band to paint into. Without a selection `paint` targets the whole canvas,
  // which is not a stroke.
  var sel = [[40, 40], [460, 40], [460, 200], [40, 200]];
  doc.selection.select(sel);
  note('selection', 'ok');

  try {
    var d = new ActionDescriptor();
    d.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('Usng'), charIDToTypeID('FrgC'));
    d.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('Md  '), charIDToTypeID('BlnM'), charIDToTypeID('Nrml'));
    d.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), 100);
    d.putEnumerated(charIDToTypeID('Ptrn'), charIDToTypeID('Ptrn'), charIDToTypeID('Cstn'));
    executeAction(charIDToTypeID('paint'), d, DialogModes.NO);
    note('paint', 'ok');
  } catch (e) {
    note('paint', 'ERR ' + ((e && e.message) || String(e)));
  }
  doc.selection.deselect();

  var out = new File('~/photoshop-ai-studio-workspace/out/brush-stroke.png');
  if (!out.parent.exists) out.parent.create();
  doc.saveAs(out, new PNGSaveOptions(), true, Extension.LOWERCASE);
  note('saved', 'ok');
} catch (e) {
  note('fatal', (e && e.message) || String(e));
}

R.join('; ');
