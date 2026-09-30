/**
 * Structured logger for the plugin.
 *
 * Two sinks: the Photoshop console (always) and — while a bridge is connected —
 * a `log` frame that the MCP server folds into its own structured log stream.
 * That is how the Studio's LOG tab shows what happened *inside* Photoshop
 * without the plugin needing a dependency of its own.
 *
 * Plain ES5-style JavaScript on purpose: UXP has no build step here, so the file
 * is what Photoshop runs.
 */
'use strict';

var LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

var state = {
  threshold: 'info',
  remote: null,
};

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function emit(level, message, data) {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(state.threshold)) {
    return;
  }
  var line = '[' + level + '] ' + message;
  var full = data === undefined ? line : line + ' ' + safeStringify(data);
  if (level === 'error') {
    console.error(full);
  } else if (level === 'warn') {
    console.warn(full);
  } else {
    console.log(full);
  }
  if (state.remote) {
    try {
      state.remote({ level: level, message: message, data: data });
    } catch (err) {
      /* a broken sink must never break logging */
    }
  }
}

var Logger = {
  setLevel: function (level) {
    if (LEVELS.indexOf(level) !== -1) state.threshold = level;
  },
  getLevel: function () {
    return state.threshold;
  },
  /** Wired up by the bridge while a socket is open. */
  setRemoteSink: function (sink) {
    state.remote = sink;
  },
  trace: function (message, data) {
    emit('trace', message, data);
  },
  debug: function (message, data) {
    emit('debug', message, data);
  },
  info: function (message, data) {
    emit('info', message, data);
  },
  warn: function (message, data) {
    emit('warn', message, data);
  },
  error: function (message, data) {
    emit('error', message, data);
  },
};

module.exports = { Logger: Logger, LEVELS: LEVELS };
