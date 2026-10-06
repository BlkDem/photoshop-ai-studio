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

/**
 * A coloured rectangle, built the only way this host can put colour into pixels.
 *
 * ## Why not the solid-fill descriptor
 *
 * This used to ask `batchPlay` for a `make` / `solidColorLayer` content layer,
 * on the assumption it was "the most portable way to get a coloured rectangle".
 * It is not available here: `capabilities.js` records that route as measured to
 * **not return** — it leaves Photoshop waiting on a dialog a modal scope cannot
 * dismiss, and every later call on that host stops answering. The tool that
 * needed a solid fill was removed rather than shipped (ADR-013); this affordance
 * was missed in that removal and kept calling the dead route.
 *
 * So the rectangle is made the way `ops/brush.js` makes every stroke: create a
 * layer, select the rectangle, fill the selection. Both halves of that are on the
 * capability report's VERIFIED list.
 */
function makeRect(doc, spec) {
  var created;
  try {
    created = doc.createLayer({ name: spec.name });
  } catch (err) {
    throw errors.StudioError('STEP_FAILED', 'Could not create the "' + spec.name + '" layer: ' + ((err && err.message) || String(err)));
  }

  // Resolve before selecting: `createLayer` returns a handle whose `id` is not
  // populated yet, and handing that to `document.activeLayers` is a type error
  // in UXP rather than a silent no-op.
  return ps.resolveCreatedLayer(doc, created).then(function (layer) {
    return fillRect(doc, layer, spec);
  });
}

function fillRect(doc, layer, spec) {
  return ps
    .withForegroundColor(spec.color, function () {
      // Select the layer before filling. `createLayer` does not select what it
      // creates on this build, so without this the rectangle is painted onto
      // whatever was active — the Background — and the new layer comes back 0x0.
      // That is exactly the "Logo layer came back empty" symptom, and it looks
      // like Photoshop refusing to create a layer when it is really a selection
      // bug on our side.
      return Promise.resolve(ps.selectLayer(layer))
        .then(function () {
          return Promise.resolve(
            doc.selection.selectRectangle(
              { left: spec.x, top: spec.y, right: spec.x + spec.width, bottom: spec.y + spec.height },
              selectionType(),
            ),
          );
        })
        .then(function () {
          return ps.fillSelection(100, 'normal');
        });
    })
    .then(function () {
      return Promise.resolve(doc.selection.deselect());
    })
    .then(function () {
      // A 0x0 layer here means this host ignored the fill, which `ops/gradient.js`
      // already treats as UNSUPPORTED_OPERATION. Reported as such rather than
      // returned as a success, because a 0x0 layer passes every declared check
      // and produces a document with a hole in it.
      var bounds = ps.boundsOf(layer);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
        throw errors.StudioError(
          'UNSUPPORTED_OPERATION',
          'The "' + spec.name + '" layer came back empty: this Photoshop build creates every pixel layer 0x0 and ' +
            'a selection fill did not give it any area. Text layers still work, so the rest of the demo document is fine.',
          { details: { requested: { x: spec.x, y: spec.y, width: spec.width, height: spec.height }, actual: bounds || null } },
        );
      }
      return fitRect(doc, layer, spec.x, spec.y, spec.width, spec.height);
    });
}

/**
 * `selection.selectRectangle` needs a selection type, and the enum has held
 * different spellings across builds. Mirrors `ops/brush.js` and `ops/canvas.js`,
 * which resolve it the same way for the same reason.
 */
function selectionType() {
  var enumObject = ps.constants && ps.constants.SelectionType;
  if (enumObject) {
    if (typeof enumObject.REPLACE !== 'undefined') return enumObject.REPLACE;
    if (typeof enumObject.replace !== 'undefined') return enumObject.replace;
  }
  return 'set';
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

module.exports = {
  createDemoDocument: createDemoDocument,
  LAYERS: LAYERS,
  CANVAS: CANVAS,
};
