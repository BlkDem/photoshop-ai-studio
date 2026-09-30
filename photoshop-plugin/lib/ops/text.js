/**
 * Text-layer operations.
 *
 * MVP scope only (§7): content, font, size, colour, position. Full Photoshop
 * typography — leading, tracking, warping, paragraph styles — is deliberately not
 * implemented; the tool descriptions say so, so the planner does not try.
 *
 * Creation uses `document.createTextLayer` (Photoshop 24.2+, so fine for our 25+
 * target) rather than the older `batchPlay` `make`/`textLayer` descriptor.
 * Updates use `layer.textItem` for content and size, and a `batchPlay`
 * `textStyleRange` for colour, because the DOM character style does not expose a
 * reliable colour setter across builds.
 */
'use strict';

var ps = require('../ps.js');
var StudioError = require('../errors.js').StudioError;
var layers = require('./layers.js');

/** `create_text_layer` */
function createTextLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var params = ctx.params;
  var position = textPosition(doc, params);

  var options = {
    name: params.name || firstLine(params.text),
    contents: params.text,
    fontSize: params.fontSize || 24,
    position: position,
  };
  if (params.font) options.fontName = params.font;
  if (params.color) options.textColor = solidColor(doc, params.color);

  var layer;
  try {
    layer = doc.createTextLayer(options);
  } catch (err) {
    // `createTextLayer` is the documented API for 24.2+; if it is missing the
    // plugin must say so rather than silently producing an empty layer.
    throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build cannot create text layers via the DOM.', {
      details: { document: doc.name, cause: (err && err.message) || String(err) },
    });
  }

  if (params.width) setParagraphWidth(layer, params.width);
  return textInfo(doc, layer);
}

/** `get_text_layer` */
function getTextLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  return textInfo(doc, layer);
}

/** `update_text_layer` — only the provided fields change. */
function updateTextLayer(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  ps.assertMutable(layer);
  var params = ctx.params;

  if (typeof params.text === 'string') {
    layer.textItem.contents = params.text;
    // Photoshop derives the layer name from the text; mirror that so the planner
    // can address the layer by its new name on the next step.
    try {
      layer.name = firstLine(params.text);
    } catch (err) {
      /* naming a text layer is cosmetic; never fail the edit over it */
    }
  }

  if (typeof params.fontSize === 'number') applyFontSize(layer, params.fontSize);
  if (params.font) applyFont(layer, params.font);
  if (params.color) applyColor(layer, params.color);
  if (params.alignment) applyAlignment(layer, params.alignment);

  return textInfo(doc, layer);
}

/** `set_text_position` */
function setTextPosition(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  ps.assertMutable(layer);

  // The DOM positions from the text box origin, which is the top-left of the
  // text box, so the request coordinates can be used directly.
  layers.translateBy(layer, ctx.params.x - originOf(layer).x, ctx.params.y - originOf(layer).y);
  return textInfo(doc, layer);
}

/** `set_text_font_size` */
function setTextFontSize(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  applyFontSize(layer, ctx.params.fontSize);
  return textInfo(doc, layer);
}

/** `set_text_color` */
function setTextColor(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  ps.assertMutable(layer);
  applyColor(layer, ctx.params.color);
  return textInfo(doc, layer);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Normalised text record for a layer object. */
function textInfo(doc, layer) {
  var item = layer.textItem;
  var bounds = ps.boundsOf(layer);
  var parent = ps.parentOf(doc, layer.id);
  return {
    layerId: layer.id,
    name: layer.name,
    text: item ? String(item.contents) : '',
    font: currentFont(layer),
    fontSize: currentFontSize(layer, bounds),
    color: currentColor(layer),
    alignment: currentAlignment(item),
    width: bounds.width,
    height: bounds.height,
    x: (parent ? 0 : 0) + bounds.x,
    y: bounds.y,
  };
}

function currentFont(layer) {
  try {
    if (layer.textItem && layer.textItem.characterStyle && layer.textItem.characterStyle.font) {
      return String(layer.textItem.characterStyle.font);
    }
  } catch (err) {
    /* fall through */
  }
  return 'unknown';
}

function currentFontSize(layer, bounds) {
  try {
    if (layer.textItem && layer.textItem.characterStyle && typeof layer.textItem.characterStyle.size === 'number') {
      return ps.round(layer.textItem.characterStyle.size, 1);
    }
  } catch (err) {
    /* fall through */
  }
  // `height` is a usable approximation when the style is unavailable.
  return bounds && bounds.height > 0 ? ps.round(bounds.height / 1.4, 1) : 12;
}

function currentAlignment(item) {
  try {
    var raw = item && item.paragraphStyle ? String(item.paragraphStyle.alignment) : '';
    var map = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFY: 'justify' };
    return map[raw.toUpperCase()] || raw.toLowerCase() || undefined;
  } catch (err) {
    return undefined;
  }
}

/**
 * Current fill colour.
 *
 * The DOM does not reliably expose text colour, so this reads it back with a
 * `textStyleRange` get. Verification depends on it, so it must not be faked.
 */
function currentColor(layer) {
  return ps
    .batchPlay([
      {
        _obj: 'get',
        _target: [
          {
            _ref: 'textLayer',
            _enum: 'ordinal',
            _value: 'targetEnum',
          },
          { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
        ],
        _options: { dialogOptions: 'dontDisplay' },
      },
    ])
    .then(function (result) {
      var style = extractColor(result);
      return style || { r: 0, g: 0, b: 0 };
    })
    .catch(function () {
      return { r: 0, g: 0, b: 0 };
    });
}

function extractColor(result) {
  if (!Array.isArray(result)) return null;
  for (var i = 0; i < result.length; i += 1) {
    var node = result[i];
    if (!node || typeof node !== 'object') continue;
    if (node._obj === 'textStyleRange' || node.textStyle) {
      var found = findColor(node);
      if (found) return found;
    }
  }
  return null;
}

function findColor(node) {
  var stack = [node];
  while (stack.length > 0) {
    var current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (
      typeof current.red === 'number' &&
      typeof current.green === 'number' &&
      typeof current.blue === 'number'
    ) {
      return { r: current.red, g: current.green, b: current.blue };
    }
    for (var key in current) {
      if (Object.prototype.hasOwnProperty.call(current, key) && typeof current[key] === 'object') {
        stack.push(current[key]);
      }
    }
  }
  return null;
}

/** Font size via the DOM, with a `textStyleRange` fallback. */
function applyFontSize(layer, fontSize) {
  if (typeof fontSize !== 'number' || fontSize <= 0 || fontSize > 1296) {
    throw StudioError('INVALID_PARAMS', 'fontSize must be between 1 and 1296, received ' + fontSize);
  }
  try {
    if (layer.textItem && layer.textItem.characterStyle) {
      layer.textItem.characterStyle.size = fontSize;
      return;
    }
  } catch (err) {
    /* fall through to batchPlay */
  }
  return applyTextStyle(layer, { size: fontSize });
}

function applyFont(layer, font) {
  try {
    if (layer.textItem && layer.textItem.characterStyle) {
      layer.textItem.characterStyle.font = font;
      return;
    }
  } catch (err) {
    /* fall through */
  }
  return applyTextStyle(layer, { fontName: font });
}

function applyAlignment(layer, alignment) {
  try {
    if (layer.textItem && layer.textItem.paragraphStyle) {
      layer.textItem.paragraphStyle.alignment = alignment;
    }
  } catch (err) {
    /* alignment is cosmetic in the MVP; never fail the edit over it */
  }
}

/** Colour and font fallbacks both go through one `textStyleRange` write. */
function applyTextStyle(layer, style) {
  var item = layer.textItem;
  var text = item ? String(item.contents) : '';
  var descriptor = {
    _obj: 'textStyleRange',
    from: 0,
    to: Math.max(1, text.length),
  };
  var textStyle = { _obj: 'textStyle' };
  if (style.size !== undefined) textStyle.size = { _unit: 'pointsUnit', _value: style.size };
  if (style.fontName !== undefined) textStyle.fontName = style.fontName;
  if (style.color !== undefined) {
    textStyle.color = { _obj: 'RGBColor', red: style.color.r, green: style.color.g, blue: style.color.b };
  }
  descriptor.textStyle = textStyle;

  return ps.batchPlay([
    {
      _obj: 'set',
      _target: [{ _ref: 'textLayer', _enum: 'ordinal', _value: 'targetEnum' }],
      to: [descriptor],
      _options: { dialogOptions: 'dontDisplay' },
    },
  ]);
}

function applyColor(layer, color) {
  var rgb = normalizeColor(color);
  return applyTextStyle(layer, { color: rgb });
}

function normalizeColor(color) {
  if (typeof color === 'string') {
    var hex = color.replace('#', '');
    if (hex.length !== 6) throw StudioError('INVALID_COLOR', 'Expected "#rrggbb", received "' + color + '"');
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  if (!color || typeof color.r !== 'number') {
    throw StudioError('INVALID_COLOR', 'Expected {r,g,b} or "#rrggbb"');
  }
  return {
    r: clampByte(color.r),
    g: clampByte(color.g),
    b: clampByte(color.b),
  };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

/** `SolidColor` for `createTextLayer`'s `textColor`. */
function solidColor(doc, color) {
  var rgb = normalizeColor(color);
  try {
    if (doc.solidColor) return doc.solidColor(rgb);
  } catch (err) {
    /* fall through */
  }
  try {
    return ps.app.foregroundColor;
  } catch (err) {
    return rgb;
  }
}

/** `createTextLayer`'s `position` is the bottom-left of the text box. */
function textPosition(doc, params) {
  var width = params.width || Math.round(String(params.text).length * (params.fontSize || 24) * 0.5);
  var x = typeof params.x === 'number' ? params.x : Math.round((doc.width - width) / 2);
  var y = typeof params.y === 'number' ? params.y : Math.round((doc.height - (params.fontSize || 24)) / 2);
  return { x: x, y: y };
}

function setParagraphWidth(layer, width) {
  try {
    if (layer.textItem && typeof layer.textItem.convertToParagraphText === 'function') {
      layer.textItem.convertToParagraphText();
      var bounds = ps.boundsOf(layer);
      if (bounds.width > 0 && bounds.width !== width) {
        layers.scaleBy(layer, width / bounds.width, 1);
      }
    }
  } catch (err) {
    /* paragraph conversion is best effort */
  }
}

/** Top-left of the text box, used by `set_text_position`. */
function originOf(layer) {
  var bounds = ps.boundsOf(layer);
  return { x: bounds.x, y: bounds.y };
}

function firstLine(text) {
  var line = String(text).split('\n')[0] || '';
  return line.length > 40 ? line.slice(0, 40) + '…' : line;
}

module.exports = {
  create_text_layer: createTextLayer,
  get_text_layer: getTextLayer,
  update_text_layer: updateTextLayer,
  set_text_position: setTextPosition,
  set_text_font_size: setTextFontSize,
  set_text_color: setTextColor,
  normalizeColor: normalizeColor,
  currentColor: currentColor,
};
