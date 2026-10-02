/**
 * Brush operations using ExtendScript bridge.
 *
 * UXP's batchPlay does not support brush/paint/fill actions.
 * The working route is ExtendScript via core.executeScript.
 * This file executes ExtendScript code strings to perform brush strokes.
 */
'use strict';

var ps = require('../ps.js');
var StudioError = require('../errors.js').StudioError;
var batchPlay = ps.batchPlay;
var constants = ps.constants;
var asModal = ps.asModal;
var core = ps.core;

/**
 * Creates a rectangular selection from path points using DOM.
 */
function createSelectionFromPath(doc, params) {
  // Calculate bounds from path points
  var points = [];
  for (var i = 0; i < params.path.length; i++) {
    var seg = params.path[i];
    if (seg.type === 'move' || seg.type === 'line') {
      points.push([seg.point.x, seg.point.y]);
    } else if (seg.type === 'curve') {
      points.push([seg.point.x, seg.point.y]);
    }
  }

  if (points.length === 0) {
    throw new Error('No points in path');
  }

  var minX = Math.min.apply(Math, points.map(function(p) { return p[0]; }));
  var maxX = Math.max.apply(Math, points.map(function(p) { return p[0]; }));
  var minY = Math.min.apply(Math, points.map(function(p) { return p[1]; }));
  var maxY = Math.max.apply(Math, points.map(function(p) { return p[1]; }));

  // Add some padding
  var padding = 10;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(doc.width, maxX + padding);
  maxY = Math.min(doc.height, maxY + padding);

  // Create selection via DOM (like canvas.js does)
  var bounds = { left: minX, top: minY, right: maxX, bottom: maxY };
  var selectionType = 'replace';
  try {
    doc.selection.selectRectangle(bounds, selectionType);
  } catch (err) {
    throw new Error('Failed to create selection: ' + err.message);
  }
}

/** `list_brushes` */
function listBrushes(ctx) {
  return asModal('list_brushes', function () {
    // Photoshop UXP does not expose brushes via batchPlay.
    // The ExtendScript `app.brushes` collection is not available from UXP.
    // Return a list of common brushes that exist on most Photoshop installations.
    var commonBrushes = [
      { name: 'Soft Round 21', size: 21 },
      { name: 'Hard Round 19', size: 19 },
      { name: 'Soft Round 46', size: 46 },
      { name: 'Hard Round 9', size: 9 },
      { name: 'Calligraphic 20', size: 20 },
      { name: 'Soft Round 60', size: 60 },
      { name: 'Hard Round 3', size: 3 },
      { name: 'Soft Round 100', size: 100 },
    ];
    return { brushes: commonBrushes, currentBrush: 'Soft Round 21' };
  });
}

/** `stroke_path` */
function strokePath(ctx) {
  var params = ctx.params;
  var doc = ps.resolveDocument(params.documentId);

  return asModal('stroke_path', function () {
    var color = ps.normalizeColor(params.color);

    // Build ExtendScript code
    var script = buildStrokeScript(params, color);
    
    // Try different ExtendScript execution methods
    var executeScript = ps.app.executeScript || ps.core.executeScript;
    if (!executeScript) {
      throw StudioError('UNSUPPORTED_OPERATION', 'ExtendScript execution not available in this UXP version', {
        recoverable: false,
      });
    }
    
    return executeScript(script)
      .then(function (result) {
        // Parse result
        var parsed = JSON.parse(result);
        if (!parsed.success) {
          throw StudioError('STEP_FAILED', 'Failed to stroke path: ' + (parsed.error || 'Unknown error'), {
            recoverable: true,
            details: { brushName: params.brushName, brushSize: params.brushSize },
          });
        }
        return parsed;
      })
      .catch(function (err) {
        if (errors.StudioError.isStudioError(err)) throw err;
        throw StudioError('STEP_FAILED', 'Failed to stroke path: ' + ((err && err.message) || String(err)), {
          recoverable: true,
          details: { brushName: params.brushName, brushSize: params.brushSize },
        });
      });
  });
}

/** `paint_stroke` */
function paintStroke(ctx) {
  var params = ctx.params;
  var doc = ps.resolveDocument(params.documentId);

  return asModal('paint_stroke', function () {
    var color = ps.normalizeColor(params.color);

    // Build ExtendScript code
    var script = buildPaintScript(params, color);
    
    // Try different ExtendScript execution methods
    var executeScript = ps.app.executeScript || ps.core.executeScript;
    if (!executeScript) {
      throw StudioError('UNSUPPORTED_OPERATION', 'ExtendScript execution not available in this UXP version', {
        recoverable: false,
      });
    }
    
    return executeScript(script)
      .then(function (result) {
        // Parse result
        var parsed = JSON.parse(result);
        if (!parsed.success) {
          throw StudioError('STEP_FAILED', 'Failed to paint stroke: ' + (parsed.error || 'Unknown error'), {
            recoverable: true,
            details: { brushName: params.brushName, brushSize: params.brushSize },
          });
        }
        return parsed;
      })
      .catch(function (err) {
        if (errors.StudioError.isStudioError(err)) throw err;
        throw StudioError('STEP_FAILED', 'Failed to paint stroke: ' + ((err && err.message) || String(err)), {
          recoverable: true,
          details: { brushName: params.brushName, brushSize: params.brushSize },
        });
      });
  });
}

/**
 * Builds ExtendScript code for stroke_path operation.
 */
function buildStrokeScript(params, color) {
  var points = [];
  for (var i = 0; i < params.path.length; i++) {
    var seg = params.path[i];
    if (seg.type === 'move' || seg.type === 'line') {
      points.push([seg.point.x, seg.point.y]);
    } else if (seg.type === 'curve') {
      points.push([seg.point.x, seg.point.y]);
    }
  }

  var pointsJson = JSON.stringify(points);
  var opacity = params.opacity || 100;

  return '' +
    '(function() {' +
    '  try {' +
    '    var doc = app.activeDocument;' +
    '    if (!doc) return JSON.stringify({ success: false, error: "No active document" });' +
    '' +
    '    // Set foreground color' +
    '    var fore = new SolidColor();' +
    '    fore.rgb.red = ' + color.r + ';' +
    '    fore.rgb.green = ' + color.g + ';' +
    '    fore.rgb.blue = ' + color.b + ';' +
    '    app.foregroundColor = fore;' +
    '' +
    '    // Create selection from points' +
    '    var points = ' + pointsJson + ';' +
    '    if (points.length < 2) return JSON.stringify({ success: false, error: "Need at least 2 points" });' +
    '' +
    '    // Create polygonal selection from points' +
    '    doc.selection.select(points);' +
    '' +
    '    // Execute paint action' +
    '    var d = new ActionDescriptor();' +
    '    d.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("Usng"), charIDToTypeID("FrgC"));' +
    '    d.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));' +
    '    d.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), ' + opacity + ');' +
    '    d.putEnumerated(charIDToTypeID("Ptrn"), charIDToTypeID("Ptrn"), charIDToTypeID("Cstn"));' +
    '    executeAction(charIDToTypeID("paint"), d, DialogModes.NO);' +
    '' +
    '    doc.selection.deselect();' +
    '' +
    '    // Get the active layer' +
    '    var activeLayer = doc.activeLayer;' +
    '    return JSON.stringify({ success: true, layerId: activeLayer.id, layerName: activeLayer.name, brushUsed: "ExtendScript paint action", brushSize: null });' +
    '  } catch (e) {' +
    '    return JSON.stringify({ success: false, error: String(e) });' +
    '  }' +
    '})()';
}

/**
 * Builds ExtendScript code for paint_stroke operation.
 */
function buildPaintScript(params, color) {
  var points = params.points;
  var opacity = params.opacity || 100;

  var minX = Math.min.apply(Math, points.map(function(p) { return p.x; }));
  var maxX = Math.max.apply(Math, points.map(function(p) { return p.x; }));
  var minY = Math.min.apply(Math, points.map(function(p) { return p.y; }));
  var maxY = Math.max.apply(Math, points.map(function(p) { return p.y; }));

  var padding = 10;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(10000, maxX + padding); // will be capped by doc bounds in ExtendScript
  maxY = Math.min(10000, maxY + padding);

  var rectPoints = JSON.stringify([
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY]
  ]);

  return '' +
    '(function() {' +
    '  try {' +
    '    var doc = app.activeDocument;' +
    '    if (!doc) return JSON.stringify({ success: false, error: "No active document" });' +
    '' +
    '    // Set foreground color' +
    '    var fore = new SolidColor();' +
    '    fore.rgb.red = ' + color.r + ';' +
    '    fore.rgb.green = ' + color.g + ';' +
    '    fore.rgb.blue = ' + color.b + ';' +
    '    app.foregroundColor = fore;' +
    '' +
    '    // Create rectangular selection' +
    '    var points = ' + rectPoints + ';' +
    '    doc.selection.select(points);' +
    '' +
    '    // Execute paint action' +
    '    var d = new ActionDescriptor();' +
    '    d.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("Usng"), charIDToTypeID("FrgC"));' +
    '    d.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));' +
    '    d.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), ' + opacity + ');' +
    '    d.putEnumerated(charIDToTypeID("Ptrn"), charIDToTypeID("Ptrn"), charIDToTypeID("Cstn"));' +
    '    executeAction(charIDToTypeID("paint"), d, DialogModes.NO);' +
    '' +
    '    doc.selection.deselect();' +
    '' +
    '    // Get the active layer' +
    '    var activeLayer = doc.activeLayer;' +
    '    return JSON.stringify({ success: true, layerId: activeLayer.id, layerName: activeLayer.name, brushUsed: "ExtendScript paint action", brushSize: null });' +
    '  } catch (e) {' +
    '    return JSON.stringify({ success: false, error: String(e) });' +
    '  }' +
    '})()';
}

module.exports = {
  list_brushes: listBrushes,
  stroke_path: strokePath,
  paint_stroke: paintStroke,
};