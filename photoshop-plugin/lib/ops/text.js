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

  // The colour has to exist before the layer is created, and building one is a
  // round trip through Photoshop, so the whole call is deferred rather than
  // creating the layer and colouring it afterwards — a layer that appears then
  // turns colour is a worse outcome than one that appears already right.
  return (params.color ? solidColor(doc, params.color) : Promise.resolve(null))
    .then(function (textColor) {
      if (textColor) options.textColor = textColor;
      try {
        return doc.createTextLayer(options);
      } catch (err) {
        // `createTextLayer` is the documented API for 24.2+; if it is missing the
        // plugin must say so rather than silently producing an empty layer.
        throw StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build cannot create text layers via the DOM.', {
          details: { document: doc.name, cause: (err && err.message) || String(err) },
        });
      }
    })
    // Same lazy-id behaviour as `createLayer`, so the id is waited for before the
    // layer is described — otherwise `layerId` serialises as undefined.
    .then(function (created) {
      return ps.resolveCreatedLayer(doc, created);
    })
    .then(function (layer) {
      // `createTextLayer` names the layer after its **contents**, ignoring the
      // `name` that was asked for: a layer requested as "Headline" turned up as
      // "Hello world", and every later step that referred to it by name then
      // failed with "layer not found". Renaming is cheap and makes the handle the
      // caller was given actually work.
      if (params.name && String(layer.name) !== String(params.name)) {
        try {
          layer.name = params.name;
        } catch (err) {
          /* a layer that cannot be renamed is still usable by id */
        }
      }
      if (params.width) setParagraphWidth(layer, params.width);
      return textInfo(doc, layer);
    });
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
  if (params.alignment) applyAlignment(layer, params.alignment);

  // Colour comes last and is awaited: it is the only write that has to go
  // through Photoshop, and reading the layer back before it lands would report
  // the previous colour as the result of this edit.
  return (params.color ? applyColor(doc, layer, params.color) : Promise.resolve())
    .then(function () {
      return textInfo(doc, layer);
    });
}

/**
 * `set_text_style` — character and paragraph properties in one shot.
 *
 * Every field is written straight onto `characterStyle` / `paragraphStyle`, for
 * the same reason the colour code is: the descriptor route to these settings
 * opens a modal dialog on 26.11.
 *
 * `leading` and `paragraphWidth` are not `characterStyle` properties on this
 * build — the capability report says so — so they are applied through the paths
 * that do work and the result reports what actually took.
 */
/**
 * `true`/`false` as the `Constants.Underline` value the DOM wants.
 *
 * Falls back to the bare boolean on a build that does accept one, because the
 * two shapes have coexisted and the assignment is wrapped in a try either way.
 */
function underlineValue(on) {
  var enumObject = ps.constants && ps.constants.Underline;
  if (enumObject) {
    if (!on && typeof enumObject.NONE !== 'undefined') return enumObject.NONE;
    // This build has no plain "on": the enum is
    // {NONE, LEFTINVERTICAL, RIGHTINVERTICAL}, i.e. underline for vertical text
    // only. `true` is therefore best-effort — see the capability report, which
    // says so rather than letting a plan assume a horizontal underline appeared.
    var candidate = on ? ['RIGHTINVERTICAL', 'SOLID', 'ON'] : ['NONE'];
    for (var i = 0; i < candidate.length; i += 1) {
      if (typeof enumObject[candidate[i]] !== 'undefined') return enumObject[candidate[i]];
    }
  }
  return on;
}

/**
 * The value `characterStyle.strikeThrough` takes.
 *
 * A separate enum from `Underline`, and not interchangeable with it: writing an
 * underline value into this field is how a "strikethrough" request used to be
 * turned into nonsense, since on this build the underline enum holds only
 * vertical-text variants.
 *
 * The enum object's keys are not the values, and the values are lowercase strings
 * like `strikethroughOff`, so the "on" value is derived from what Photoshop
 * currently reports rather than guessed. That way a build that spells it
 * `strikethroughThick` still works.
 */
function strikeThroughValue(on, current) {
  var enumObject = ps.constants && ps.constants.StrikeThrough;
  if (enumObject) {
    for (var key in enumObject) {
      if (!Object.prototype.hasOwnProperty.call(enumObject, key)) continue;
      if (/off|none/i.test(key)) continue;
      if (typeof enumObject[key] !== 'undefined') return enumObject[key];
    }
  }
  if (typeof current === 'string') {
    var match = current.match(/^(.*?)off$/i);
    if (match) return match[1] + 'On';
  }
  return on;
}

function setTextStyle(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  ps.assertMutable(layer);
  var params = ctx.params;

  var style = characterStyle(layer);
  var item = layer.textItem;
  var applied = [];


  // What each key was actually written as, so the read-back can tell whether
  // Photoshop kept it. Several of these are silently ignored when given a value
  // the host dislikes: the assignment returns without throwing and the run would
  // otherwise report a style change that never happened.
  var wrote = {};
  var numeric = ['tracking', 'leading', 'baselineShift', 'horizontalScale', 'verticalScale'];
  var booleans = ['fauxBold', 'fauxItalic', 'underline', 'strikethrough'];

  numeric.forEach(function (key) {
    if (typeof params[key] !== 'number') return;
    if (key === 'leading') return; // paragraph property; handled below
    try {
      style[key] = params[key];
      wrote[key] = params[key];
      applied.push(key);
    } catch (err) {
      throw StudioError('STEP_FAILED', 'Photoshop would not set ' + key + ' on "' + layer.name + '": ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    }
  });

  booleans.forEach(function (key) {
    if (typeof params[key] !== 'boolean') return;
    try {
      // None of these are booleans on the DOM except fauxBold/fauxItalic:
      // assigning `true` fails with "'Constants.Underline' is of type boolean.
      // Expecting type number". The model still asks for a boolean, because
      // "underlined" is what a request means. Each takes its *own* enum:
      // `Underline` and `StrikeThrough` are separate and not interchangeable.
      style[key] =
        key === 'fauxBold' || key === 'fauxItalic'
          ? params[key]
          : key === 'strikethrough'
            ? strikeThroughValue(params[key], readStyle(item && item.characterStyle, 'strikeThrough'))
            : underlineValue(params[key]);
      wrote[key] = style[key];
      applied.push(key);
    } catch (err) {
      throw StudioError('STEP_FAILED', 'Photoshop would not set ' + key + ' on "' + layer.name + '": ' + ((err && err.message) || String(err)), {
        recoverable: true,
      });
    }
  });

  if (typeof params.leading === 'number' && item && item.paragraphStyle) {
    try {
      item.paragraphStyle.leading = params.leading;
      applied.push('leading');
    } catch (err) {
      /* paragraph leading is a nicety; never fail the whole edit over it */
    }
  }

  var narrowing = typeof params.paragraphWidth === 'number';

  return (narrowing ? setParagraphWidth(layer, params.paragraphWidth) : Promise.resolve())
    .then(function (paragraph) {
      if (paragraph) applied.push('paragraphWidth');
      // `textInfo` is a promise (it reads the colour back); assigning onto it
      // would put `applied` on the promise object and lose the whole list.
      return textInfo(doc, layer).then(function (info) {
        // Read-back, because writing is not the same as taking: the DOM accepted
        // a strikethrough value it did not like and changed nothing, without
        // raising. Anything that did not take is reported as ignored rather than
        // counted as applied.
        var kept = applied.filter(function (key) {
          if (key === 'paragraphWidth') return true;
          if (key === 'leading') return true;
          var expected = wrote[key];
          var actual = info[key];
          if (typeof expected === 'number' && typeof actual === 'number') {
            return Math.abs(expected - actual) < 0.51;
          }
          return String(actual) === String(expected);
        });
        info.applied = kept;
        var ignored = applied.filter(function (key) { return kept.indexOf(key) === -1; });
        if (ignored.length) info.ignored = ignored;
        return info;
      });
    });
}

/** `set_text_position` */
function setTextPosition(ctx) {
  var doc = ps.resolveDocument(ctx.params.documentId);
  var layer = ps.findLayer(doc, ctx.params);
  ps.assertText(layer);
  ps.assertMutable(layer);

  // The DOM positions from the text box origin, which is the top-left of the
  // text box, so the request coordinates can be used directly.
  return layers
    .translateBy(layer, ctx.params.x - originOf(layer).x, ctx.params.y - originOf(layer).y)
    .then(function () {
      return textInfo(doc, layer);
    });
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
  return applyColor(doc, layer, ctx.params.color).then(function () {
    return textInfo(doc, layer);
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Normalised text record for a layer object.
 *
 * `currentColor` is asynchronous — the fill colour has to be read back with
 * `batchPlay`, because the UXP DOM has no reliable text-colour getter. Returning
 * its promise from a synchronous function serialises as `{}`, which the MCP
 * server's result schema rejects, so every text operation looked like a failure
 * even though Photoshop had applied it.
 */
function textInfo(doc, layer) {
  return Promise.resolve(currentColor(layer)).then(function (color) {
    return buildTextInfo(doc, layer, color);
  });
}

function buildTextInfo(doc, layer, color) {
  var item = layer.textItem;
  var bounds = ps.boundsOf(layer);
  var parent = ps.parentOf(doc, layer.id);
  return {
    layerId: layer.id,
    name: layer.name,
    text: item ? String(item.contents) : '',
    font: currentFont(layer),
    fontSize: currentFontSize(layer, bounds),
    color: color,
    alignment: currentAlignment(item),
    tracking: readStyle(item && item.characterStyle, 'tracking'),
    horizontalScale: readStyle(item && item.characterStyle, 'horizontalScale'),
    verticalScale: readStyle(item && item.characterStyle, 'verticalScale'),
    fauxBold: readStyle(item && item.characterStyle, 'fauxBold'),
    fauxItalic: readStyle(item && item.characterStyle, 'fauxItalic'),
    underline: readStyle(item && item.characterStyle, 'underline'),
    strikeThrough: readStyle(item && item.characterStyle, 'strikeThrough'),
    leading: item && item.paragraphStyle ? readStyle(item.paragraphStyle, 'leading') : undefined,

    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
  };
}

/** One style property, or `undefined` when the host does not expose it. */
function readStyle(owner, key) {
  try {
    if (!owner) return undefined;
    var value = owner[key];
    return typeof value === 'undefined' ? undefined : value;
  } catch (err) {
    return undefined;
  }
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

/**
 * Paragraph alignment, normalised to the four values the schema accepts.
 *
 * Photoshop exposes values outside that set (for example "justifyAll" or the
 * default value read back as an empty string), and returning one of those made
 * every text operation fail result validation. Anything unrecognised is omitted
 * rather than passed through.
 */
function currentAlignment(item) {
  try {
    var raw = item && item.paragraphStyle ? String(item.paragraphStyle.alignment) : '';
    var normalized = raw.toLowerCase().replace(/[^a-z]/g, '');
    if (normalized === 'left' || normalized === 'center' || normalized === 'centre') return 'center' === normalized ? 'center' : 'left';
    if (normalized === 'right') return 'right';
    if (normalized.indexOf('justify') === 0) return 'justify';
    return undefined;
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
/**
 * Reads the layer's text colour from the DOM.
 *
 * This used to ask Photoshop with an `_obj: 'get'` descriptor aimed at
 * `textLayer`. On Photoshop 26.11 that command answers with a modal
 * "The 'Get' command is currently unavailable", which blocks the plugin
 * indefinitely — every text operation timed out and the failure presented as a
 * hung bridge rather than as a rejected descriptor.
 *
 * `TextItem.characterStyle.color` is a `SolidColor` straight from the DOM, so
 * nothing has to be asked of Photoshop at all. Its channels follow the
 * document's colour mode, hence the conversions.
 */
function currentColor(layer) {
  var fallback = { r: 0, g: 0, b: 0 };
  try {
    var item = layer && layer.textItem;
    var style = item && item.characterStyle;
    var color = style && style.color;
    return Promise.resolve(color ? solidColorToRgb(color) : fallback);
  } catch (err) {
    return Promise.resolve(fallback);
  }
}

/**
 * A `SolidColor` as an RGB triple.
 *
 * The DOM returns a `SolidColor` whose only own property is `base` — a JSON
 * string holding the descriptor, e.g.
 * `{"desc":{"_obj":"RGBColor","red":255,"blue":255,"green":255}}`. Reading
 * `.rgb`/`.cmyk` off it (as an ExtendScript-shaped object would allow) yields
 * nothing at all, which is why colours came back as black no matter what was
 * set. The structured properties are still consulted afterwards, for a build
 * that does expose them.
 */
function solidColorToRgb(color) {
  var descriptor = null;
  var base = color && color.base;
  if (typeof base === 'string') {
    try {
      descriptor = JSON.parse(base).desc;
    } catch (err) {
      descriptor = null;
    }
  } else if (base && typeof base === 'object') {
    descriptor = base.desc;
  }

  if (descriptor && descriptor._obj === 'RGBColor') {
    return { r: clampByte(descriptor.red), g: clampByte(descriptor.green), b: clampByte(descriptor.blue) };
  }
  if (descriptor && descriptor._obj === 'CMYKColor') {
    var c = Number(descriptor.cyan) / 100;
    var m = Number(descriptor.magenta) / 100;
    var y = Number(descriptor.yellow) / 100;
    var k = Number(descriptor.black) / 100;
    return {
      r: clampByte(255 * (1 - Math.min(1, c + k))),
      g: clampByte(255 * (1 - Math.min(1, m + k))),
      b: clampByte(255 * (1 - Math.min(1, y + k))),
    };
  }
  if (descriptor && descriptor._obj === 'GrayColor') {
    var gray = clampByte(Number(descriptor.gray) * 255);
    return { r: gray, g: gray, b: gray };
  }

  if (color.rgb) {
    var rgb = color.rgb;
    return { r: clampByte(rgb.red), g: clampByte(rgb.green), b: clampByte(rgb.blue) };
  }
  if (color.cmyk) {
    var cmyk = color.cmyk;
    var cc = Number(cmyk.cyan) / 100;
    var mm = Number(cmyk.magenta) / 100;
    var yy = Number(cmyk.yellow) / 100;
    var kk = Number(cmyk.black) / 100;
    return {
      r: clampByte(255 * (1 - Math.min(1, cc + kk))),
      g: clampByte(255 * (1 - Math.min(1, mm + kk))),
      b: clampByte(255 * (1 - Math.min(1, yy + kk))),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

/**
 * The layer's `characterStyle`, or a clear refusal.
 *
 * Style writes address the layer the caller holds rather than the active text
 * layer: a `textStyleRange` write aimed at
 * `{_ref: 'textLayer', _enum: 'ordinal', _value: 'targetEnum'}` answers on
 * Photoshop 26.11 with a modal "Could not complete the request because of a
 * program error" that blocks the plugin until a human dismisses it, which made
 * `set_text_color` hang rather than fail.
 */
function characterStyle(layer) {
  var item = layer && layer.textItem;
  var style = item && item.characterStyle;
  if (!style) {
    throw StudioError('NOT_A_TEXT_LAYER', 'This layer has no text style to modify.', {
      details: { layerId: layer && layer.id },
    });
  }
  return style;
}

function applyFontSize(layer, fontSize) {
  if (typeof fontSize !== 'number' || fontSize <= 0 || fontSize > 1296) {
    throw StudioError('INVALID_PARAMS', 'fontSize must be between 1 and 1296, received ' + fontSize);
  }
  characterStyle(layer).size = fontSize;
}

function applyFont(layer, font) {
  characterStyle(layer).font = font;
}

function applyAlignment(layer, alignment) {
  try {
    var item = layer.textItem;
    if (item && item.paragraphStyle) item.paragraphStyle.alignment = alignment;
  } catch (err) {
    // Alignment is cosmetic in the MVP; never fail the edit over it.
  }
}

/** Applies a colour to every character run of a text layer. */
function applyColor(doc, layer, color) {
  var rgb = normalizeColor(color);
  return withForegroundColor(rgb, function (solid) {
    characterStyle(layer).color = solid;
  });
}

/** `"#rrggbb"` or `{r,g,b}` to a clamped RGB triple. */
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
  return { r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

/**
 * Produces a `SolidColor` for the document's colour mode, restoring whatever the
 * user had as the foreground colour afterwards.
 *
 * There is no direct way to build one on Photoshop 26.11:
 *
 *  - `app.solidColor(...)` does not exist;
 *  - `new app.SolidColor(...)` accepts an argument and ignores it, always
 *    producing white;
 *  - `TextItem.characterStyle.color` rejects anything that is not a real
 *    `SolidColor` ("'color' is of type object. Expecting type SolidColor"), so a
 *    plain `{r,g,b}` cannot be assigned at all.
 *
 * The foreground colour *is* a real `SolidColor` and setting it with a
 * `_ref: 'color'` descriptor is supported. So: set it, hand it over, put it back.
 * The window in which the user's foreground colour differs is one batchPlay.
 */
function withForegroundColor(rgb, fn) {
  var app = ps.app;
  if (!app) {
    return Promise.reject(
      StudioError('UNSUPPORTED_OPERATION', 'This Photoshop build exposes no way to build a colour.', {
        recoverable: false,
      }),
    );
  }

  var previous;
  try {
    previous = app.foregroundColor;
  } catch (err) {
    previous = undefined;
  }

  var restore = function () {
    if (!previous) return Promise.resolve();
    try {
      app.foregroundColor = previous;
    } catch (err) {
      // The colour is cosmetic; failing the edit over the restore is worse.
    }
    return Promise.resolve();
  };

  return ps
    .batchPlay([
      {
        _obj: 'set',
        _target: [{ _ref: 'color', _property: 'foregroundColor' }],
        to: { _obj: 'RGBColor', red: rgb.r, green: rgb.g, blue: rgb.b },
        _options: { dialogOptions: 'dontDisplay' },
      },
    ])
    .then(function () {
      return fn(app.foregroundColor);
    })
    .then(
      function (value) {
        return restore().then(function () {
          return value;
        });
      },
      function (err) {
        return restore().then(function () {
          throw err;
        });
      },
    );
}

/** A `SolidColor` for `createTextLayer`'s `textColor` option. */
function solidColor(doc, color) {
  var rgb = normalizeColor(color);
  var captured = null;
  return withForegroundColor(rgb, function (solid) {
    captured = solid;
  }).then(function () {
    return captured;
  });
}

/** `createTextLayer`'s `position` is the bottom-left of the text box. */
function textPosition(doc, params) {
  var width = params.width || Math.round(String(params.text).length * (params.fontSize || 24) * 0.5);
  var x = typeof params.x === 'number' ? params.x : Math.round((doc.width - width) / 2);
  var y = typeof params.y === 'number' ? params.y : Math.round((doc.height - (params.fontSize || 24)) / 2);
  return { x: x, y: y };
}

/**
 * Narrows a text layer to `width` pixels and wraps the text.
 *
 * Returns whether it did anything, so the caller can report it in `applied`
 * instead of silently omitting a field the plan asked for.
 */
function setParagraphWidth(layer, width) {
  try {
    if (layer.textItem && typeof layer.textItem.convertToParagraphText === 'function') {
      layer.textItem.convertToParagraphText();
      var bounds = ps.boundsOf(layer);
      if (bounds.width > 0 && bounds.width !== width) {
        // Awaited: the caller describes the layer straight after, and reading the
        // bounds before the scale lands reports the pre-resize width.
        return Promise.resolve(layers.scaleBy(layer, width / bounds.width, 1)).then(function () {
          return true;
        });
      }
      return Promise.resolve(true);
    }
  } catch (err) {
    /* paragraph conversion is best effort */
  }
  return Promise.resolve(false);
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
  set_text_style: setTextStyle,
  set_text_font_size: setTextFontSize,
  set_text_color: setTextColor,
  normalizeColor: normalizeColor,
  currentColor: currentColor,
};
