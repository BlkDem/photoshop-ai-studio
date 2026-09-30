/* eslint-env photoshop */
/**
 * Demo-document builder — a **developer affordance**, not a Photoshop capability.
 *
 * Deliberately not part of the operation registry and therefore not an MCP tool:
 * the brief's §29 scenario starts from a document that is already open, and adding
 * `create_document` to the AI's tool surface purely so the demo can run would be
 * widening the product for testing convenience. This module is reachable only from
 * the plugin panel's "Demo doc" button, and only when `devTools` is enabled in
 * `config.json`.
 *
 * Its purpose is to make the pipeline reproducible on a machine where nobody has
 * hand-built a five-layer PSD yet: without it you can verify that the plugin
 * connects, but not that a real Photoshop edit actually round-trips.
 */
'use strict';

var ps = require('./ps.js');
var Logger = require('./logger.js').Logger;
var errors = require('./errors.js');

var app = require('photoshop').app;

/** The layer structure the brief's demo scenario describes. */
var LAYERS = [
  { name: 'Background', kind: 'background' },
  { name: 'Logo', kind: 'rect', x: 120, y: 80, width: 320, height: 120, color: { r: 62, g: 126, b: 224 } },
  { name: 'Title', kind: 'text', text: 'Spring Sale', x: 120, y: 300, fontSize: 96, color: { r: 20, g: 20, b: 24 } },
  { name: 'Subtitle', kind: 'text', text: 'Up to 50% off everything', x: 120, y: 440, fontSize: 40, color: { r: 60, g: 60, b: 66 } },
  { name: 'CTA', kind: 'text', text: 'Shop now', x: 120, y: 560, fontSize: 28, color: { r: 255, g: 255, b: 255 } },
];

var CANVAS = { width: 1920, height: 1080, resolution: 72 };

/**
 * Creates `banner.psd` with the demo layer stack and makes it active.
 * Runs inside the caller's modal scope, like every other mutation.
 */
function createDemoDocument() {
  return app
    .createDocument({
      width: CANVAS.width,
      height: CANVAS.height,
      resolution: CANVAS.resolution,
      fill: 'white',
      name: 'banner.psd',
    })
    .then(function (doc) {
      return buildLayers(doc).then(function () {
        Logger.info('demo document created', { name: doc.name, layers: doc.layers.length });
        // Announce the change so the Studio refreshes its snapshot even if the
        // user did not type anything yet.
        try {
          require('./bridge.js').notifyStateChanged('demo-document-created', String(doc.id));
        } catch (err) {
          /* the notification is a convenience, never a requirement */
        }
        return { id: String(doc.id), name: doc.name };
      });
    })
    .catch(function (err) {
      var wire = errors.toWireError(
        err && err.name === 'StudioError'
          ? err
          : errors.StudioError('STEP_FAILED', 'Could not create the demo document: ' + ((err && err.message) || String(err))),
      );
      Logger.error('demo document failed: ' + wire.message);
      throw wire;
    });
}

function buildLayers(doc) {
  var index = 0;

  function next() {
    if (index >= LAYERS.length) return Promise.resolve();
    var spec = LAYERS[index++];
    return makeLayer(doc, spec).then(next);
  }

  return next();
}

function makeLayer(doc, spec) {
  if (spec.kind === 'background') {
    // A new document already has a Background layer; just name it.
    return renameBackground(doc, spec.name);
  }
  if (spec.kind === 'text') return makeText(doc, spec);
  return makeRect(doc, spec);
}

function renameBackground(doc, name) {
  try {
    if (doc.backgroundLayer) {
      doc.backgroundLayer.name = name;
      return Promise.resolve();
    }
  } catch (err) {
    /* fall through to creating a normal layer instead */
  }
  var layer = doc.createLayer({ name: name });
  return fitRect(doc, layer, 0, 0, doc.width, doc.height);
}

function makeRect(doc, spec) {
  // A solid-colour fill layer is the most portable way to get a coloured
  // rectangle: no asset file, no selection, no fill dialog.
  return ps
    .batchPlay([
      {
        _obj: 'make',
        _target: [{ _ref: 'contentLayer' }],
        using: {
          _obj: 'solidColorLayer',
          color: { _obj: 'RGBColor', red: spec.color.r, green: spec.color.g, blue: spec.color.b },
        },
        _options: { dialogOptions: 'dontDisplay' },
      },
    ])
    .then(function () {
      var layer = topLayer(doc);
      if (!layer) throw errors.StudioError('STEP_FAILED', 'The fill layer was not created.');
      layer.name = spec.name;
      return fitRect(doc, layer, spec.x, spec.y, spec.width, spec.height);
    });
}

function makeText(doc, spec) {
  var layer = doc.createTextLayer({
    name: spec.name,
    contents: spec.text,
    fontSize: spec.fontSize,
    // `createTextLayer` positions from the bottom-left of the text box.
    position: { x: spec.x, y: spec.y + spec.fontSize },
  });

  // Colour is applied after creation: `createTextLayer`'s `textColor` wants a
  // SolidColor instance, and the descriptor path is the one we trust across builds.
  return Promise.resolve(layer)
    .then(function (created) {
      return applyTextColor(doc, created, spec.color);
    })
    .then(function (created) {
      // Photoshop derives the layer name from the text; restore what we asked for.
      try {
        created.name = spec.name;
      } catch (err) {
        /* cosmetic */
      }
      return created;
    });
}

/**
 * Colours a text layer through the DOM.
 *
 * Was a `textStyleRange` write aimed at the active text layer, which on
 * Photoshop 26.11 raises a modal "Could not complete the request" and blocks the
 * plugin. `TextItem.characterStyle.color` addresses the layer in hand.
 */
function applyTextColor(doc, layer, rgb) {
  try {
    layer.textItem.characterStyle.color = doc.solidColor(rgb);
  } catch (err) {
    // A text layer without the intended colour is still a usable demo layer;
    // failing the whole document over it would be unhelpful.
    Logger.warn('could not set the colour of "' + layer.name + '": ' + ((err && err.message) || String(err)));
  }
  return Promise.resolve(layer);
}


/** Scales a freshly created layer to a rect and moves its top-left there. */
function fitRect(doc, layer, x, y, width, height) {
  var before = ps.boundsOf(layer);
  var layerOps = require('./ops/layers.js');

  if (before.width > 0 && before.height > 0 && (before.width !== width || before.height !== height)) {
    layerOps.scaleBy(layer, width / before.width, height / before.height);
  }
  var after = ps.boundsOf(layer);
  layerOps.translateBy(layer, x - after.x, y - after.y);
  return layer;
}

function topLayer(doc) {
  var layers = doc.layers;
  if (!layers || layers.length === 0) return null;
  return layers[layers.length - 1];
}

module.exports = {
  createDemoDocument: createDemoDocument,
  LAYERS: LAYERS,
  CANVAS: CANVAS,
};
