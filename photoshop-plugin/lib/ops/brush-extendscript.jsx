/**
 * ExtendScript bridge for brush operations.
 * This script is executed by UXP plugin via batchPlay to run ExtendScript.
 */
function strokePathWithBrush(params) {
  try {
    var doc = app.activeDocument;
    if (!doc) {
      return { success: false, error: 'No active document' };
    }

    // Set foreground color
    var fore = new SolidColor();
    fore.rgb.red = params.color.r;
    fore.rgb.green = params.color.g;
    fore.rgb.blue = params.color.b;
    app.foregroundColor = fore;

    // Create selection from path points
    var points = [];
    for (var i = 0; i < params.path.length; i++) {
      var seg = params.path[i];
      if (seg.type === 'move' || seg.type === 'line') {
        points.push([seg.point.x, seg.point.y]);
      } else if (seg.type === 'curve') {
        points.push([seg.point.x, seg.point.y]);
      }
    }

    if (points.length < 2) {
      return { success: false, error: 'Need at least 2 points' };
    }

    // Create polygonal selection from points
    doc.selection.select(points);

    // Execute paint action
    var d = new ActionDescriptor();
    d.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('Usng'), charIDToTypeID('FrgC'));
    d.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('Md  '), charIDToTypeID('BlnM'), charIDToTypeID('Nrml'));
    d.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), params.opacity || 100);
    d.putEnumerated(charIDToTypeID('Ptrn'), charIDToTypeID('Ptrn'), charIDToTypeID('Cstn'));
    executeAction(charIDToTypeID('paint'), d, DialogModes.NO);

    doc.selection.deselect();

    // Get the active layer
    var activeLayer = doc.activeLayer;
    return {
      success: true,
      layerId: activeLayer.id,
      layerName: activeLayer.name,
      brushUsed: 'ExtendScript paint action',
      brushSize: params.brushSize || null,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

function paintStrokeWithBrush(params) {
  try {
    var doc = app.activeDocument;
    if (!doc) {
      return { success: false, error: 'No active document' };
    }

    // Set foreground color
    var fore = new SolidColor();
    fore.rgb.red = params.color.r;
    fore.rgb.green = params.color.g;
    fore.rgb.blue = params.color.b;
    app.foregroundColor = fore;

    // Create selection from stroke points
    var points = params.points;
    if (points.length < 2) {
      return { success: false, error: 'Need at least 2 points' };
    }

    // Create rectangular bounds from points
    var minX = Math.min.apply(Math, points.map(function(p) { return p.x; }));
    var maxX = Math.max.apply(Math, points.map(function(p) { return p.x; }));
    var minY = Math.min.apply(Math, points.map(function(p) { return p.y; }));
    var maxY = Math.max.apply(Math, points.map(function(p) { return p.y; }));

    var padding = 10;
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(doc.width, maxX + padding);
    maxY = Math.min(doc.height, maxY + padding);

    // Create rectangular selection
    doc.selection.select([
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY]
    ]);

    // Execute paint action
    var d = new ActionDescriptor();
    d.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('Usng'), charIDToTypeID('FrgC'));
    d.putEnumerated(charIDToTypeID('Md  '), charIDToTypeID('Md  '), charIDToTypeID('BlnM'), charIDToTypeID('Nrml'));
    d.putUnitDouble(charIDToTypeID('Opct'), charIDToTypeID('#Prc'), params.opacity || 100);
    d.putEnumerated(charIDToTypeID('Ptrn'), charIDToTypeID('Ptrn'), charIDToTypeID('Cstn'));
    executeAction(charIDToTypeID('paint'), d, DialogModes.NO);

    doc.selection.deselect();

    var activeLayer = doc.activeLayer;
    return {
      success: true,
      layerId: activeLayer.id,
      layerName: activeLayer.name,
      brushUsed: 'ExtendScript paint action',
      brushSize: params.brushSize || null,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// Entry point - this will be called with JSON params
var input = arguments[0] || '{}';
var params = JSON.parse(input);
var operation = params.operation;

var result;
if (operation === 'stroke_path') {
  result = strokePathWithBrush(params);
} else if (operation === 'paint_stroke') {
  result = paintStrokeWithBrush(params);
} else {
  result = { success: false, error: 'Unknown operation: ' + operation };
}

result;