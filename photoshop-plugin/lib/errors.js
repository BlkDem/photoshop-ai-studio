/**
 * Error taxonomy for the plugin side.
 *
 * Mirrors `shared/src/errors.ts`. The bridge contract says the plugin must never
 * invent its own error shape: every failure crosses the socket as
 * `{ success: false, error: { code, message, recoverable, details?, photoshopCode? } }`
 * so the MCP server, the Orchestrator and the repair loop can all reason about
 * it uniformly.
 *
 * `recoverable` is the important field: it is what tells the AI whether retrying
 * with a different plan could plausibly succeed. A locked layer is not
 * recoverable; a layer that does not exist *yet* is.
 */
'use strict';

var CODES = {
  NOT_CONNECTED: true,
  PLUGIN_BUSY: true,
  TIMEOUT: true,
  MODAL_STATE: true,
  NO_DOCUMENT_OPEN: true,
  DOCUMENT_NOT_FOUND: true,
  DOCUMENT_NOT_SAVED: true,
  LAYER_NOT_FOUND: true,
  LAYER_NOT_MOVABLE: true,
  LAYER_LOCKED: true,
  LAYER_IS_GROUP: true,
  GROUP_NOT_FOUND: true,
  NOT_A_TEXT_LAYER: true,
  FONT_NOT_AVAILABLE: true,
  INVALID_COLOR: true,
  PATH_NOT_ALLOWED: true,
  FILE_NOT_FOUND: true,
  FILE_EXISTS: true,
  EXPORT_FAILED: true,
  UNSUPPORTED_FORMAT: true,
  INVALID_PARAMS: true,
  UNKNOWN_TOOL: true,
  UNSUPPORTED_OPERATION: true,
  PLAN_INVALID: true,
  STEP_FAILED: true,
  CANCELLED: true,
  VERIFICATION_FAILED: true,
  MODEL_UNAVAILABLE: true,
  MODEL_ERROR: true,
  INTERNAL: true,
};

var RECOVERABLE = {
  NOT_CONNECTED: true,
  PLUGIN_BUSY: true,
  TIMEOUT: true,
  MODAL_STATE: true,
  NO_DOCUMENT_OPEN: true,
  DOCUMENT_NOT_FOUND: true,
  DOCUMENT_NOT_SAVED: true,
  LAYER_NOT_FOUND: true,
  GROUP_NOT_FOUND: true,
  NOT_A_TEXT_LAYER: true,
  FONT_NOT_AVAILABLE: true,
  INVALID_COLOR: true,
  FILE_EXISTS: true,
  EXPORT_FAILED: true,
  STEP_FAILED: true,
  VERIFICATION_FAILED: true,
  MODEL_UNAVAILABLE: true,
  CANCELLED: true,
};

/** Error carrying a taxonomy code across the bridge. */
function StudioError(code, message, options) {
  var opts = options || {};
  var resolved = CODES[code] ? code : 'INTERNAL';
  var error = new Error(message || code);
  error.name = 'StudioError';
  error.code = resolved;
  error.recoverable = typeof opts.recoverable === 'boolean' ? opts.recoverable : !!RECOVERABLE[resolved];
  error.details = opts.details;
  error.photoshopCode = opts.photoshopCode;
  return error;
}

StudioError.isStudioError = function (value) {
  return !!value && value.name === 'StudioError' && typeof value.code === 'string';
};

/** Normalises anything thrown inside an op into the wire envelope. */
function toWireError(err) {
  if (StudioError.isStudioError(err)) {
    var wire = { code: err.code, message: err.message, recoverable: err.recoverable };
    if (err.details) wire.details = err.details;
    if (typeof err.photoshopCode === 'number') wire.photoshopCode = err.photoshopCode;
    return wire;
  }
  return {
    code: 'INTERNAL',
    message: (err && err.message) || String(err),
    recoverable: false,
  };
}

function fail(code, message, options) {
  return { success: false, error: toWireError(StudioError(code, message, options)) };
}

function ok(data) {
  return { success: true, data: data };
}

/**
 * Maps a Photoshop action result code onto the taxonomy.
 *
 * These are the well-known `batchPlay` error results. Anything unrecognised is
 * passed through as `photoshopCode` on a generic STEP_FAILED so nothing is lost.
 */
var PS_ERROR_CODES = {
  '-25920': ['DOCUMENT_NOT_FOUND', 'No document is open'],
  '-25921': ['NO_DOCUMENT_OPEN', 'No document is currently open in Photoshop'],
  '-25922': ['NO_DOCUMENT_OPEN', 'The object is not currently available'],
  '-25930': ['LAYER_LOCKED', 'The layer is locked'],
  '-25931': ['LAYER_LOCKED', 'The requested operation is not allowed on this layer'],
  '-128': ['CANCELLED', 'The user cancelled the operation'],
};

function photoshopFailure(result, message) {
  var code = String(result);
  var mapped = PS_ERROR_CODES[code];
  if (mapped) {
    return StudioError(mapped[0], message || mapped[1], { photoshopCode: result });
  }
  return StudioError('STEP_FAILED', 'Photoshop refused the operation: ' + (message || 'code ' + code), {
    photoshopCode: result,
  });
}

module.exports = {
  StudioError: StudioError,
  toWireError: toWireError,
  fail: fail,
  ok: ok,
  photoshopFailure: photoshopFailure,
  CODES: CODES,
};
