/*
 * Measures what the ExtendScript surface actually offers, before any of it is
 * relied on. Everything in this project has been a case of the API reference
 * being wrong — `Layer.translate` doing nothing, `Folder.getEntry()` not
 * existing, `selection.fill` missing on 26.11 — so brushes and paths get the
 * same treatment rather than a try/catch that guesses.
 */
#target photoshop

var R = [];
function note(k, v) {
  R.push(k + '=' + esc(v));
}
function esc(s) {
  return String(s).replace(/[^\x20-\x7e]/g, function (ch) {
    return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}

try {
  note('version', app.version);
  // With a document open first: some host collections are only populated once
  // there is something to act on.
  var seed = app.documents.add(100, 100, 72, 'seed', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  note('has.brushes.afterDoc', typeof app.brushes);
  note('brushes.len.afterDoc', app.brushes ? app.brushes.length : 'n/a');
  if (app.brushes) {
    var n = [];
    for (var q = 0; q < Math.min(6, app.brushes.length); q++) n.push(app.brushes[q].name);
    note('sample.afterDoc', n.join('|'));
    var soft2 = [];
    for (var q2 = 0; q2 < app.brushes.length && soft2.length < 10; q2++) {
      var nm2 = String(app.brushes[q2].name || '');
      if (/soft|round/i.test(nm2)) soft2.push(nm2);
    }
    note('soft.afterDoc', soft2.join('|'));
  }
  note('has.brushes', typeof app.brushes);
  note('brushes.length', app.brushes ? app.brushes.length : 'n/a');
  note('brushes.keys', app.brushes ? Object.keys(app.brushes).slice(0, 12).join(',') : 'n/a');
  if (app.brushes && app.brushes.length > 0) {
    var b0 = app.brushes[0];
    note('brush0.name', b0 && b0.name);
    note('brush0.size', b0 && b0.size);
    note('brush0.has.strokeCap', b0 ? typeof b0.strokeTipStyle : 'n/a');
    note('brushes.getByName', typeof app.brushes.getByName);
    // The first few names are what a picker can actually choose from.
    var names = [];
    for (var i = 0; i < Math.min(8, app.brushes.length); i++) names.push(app.brushes[i].name);
    note('sample.names', names.join('|'));
    var soft = [];
    for (var j = 0; j < app.brushes.length && soft.length < 8; j++) {
      var nm = String(app.brushes[j].name || '');
      if (/soft|round/i.test(nm)) soft.push(nm);
    }
    note('soft.names', soft.join('|'));
  }

  var doc = app.documents.add(400, 300, 72, 'probe', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
  note('has.pathItems', typeof doc.pathItems);
  var p = doc.pathItems.add('probe');
  note('pathItem.add', 'ok');
  note('pathItem.has.stroke', typeof p.stroke);
  var s = p.subPaths.add();
  s.move([[10, 10]]);
  s.lineTo([[200, 150]]);
  note('subPath.lineTo', 'ok');
  if (app.brushes && app.brushes.length > 0) {
    var c = new SolidColor();
    c.rgb.red = 255;
    c.rgb.green = 0;
    c.rgb.blue = 0;
    try {
      p.stroke(app.brushes[0], c, true, false);
      note('pathItem.stroke', 'ok');
    } catch (e) {
      note('pathItem.stroke', 'ERR ' + esc((e && e.message) || String(e)));
    }
  }
  doc.close(SaveOptions.DONOTSAVECHANGES);
} catch (e) {
  note('fatal', (e && e.message) || String(e));
}

R.join('\n');
