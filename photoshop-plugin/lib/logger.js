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
  file: null,
};

/**
 * A second sink: a log file in the plugin's writable data folder.
 *
 * ## Why this exists
 *
 * The remote sink rides the WebSocket, so it is useless for diagnosing a plugin
 * that cannot open the socket — which is the one failure where you most need to
 * see what the plugin is doing. `console.log` goes to a Photoshop panel no other
 * process can read. This file lands in the same `PluginData` folder as the
 * preview PNGs, which is the one location a UXP plugin may write and a shell can
 * read.
 *
 * ## Why the whole buffer is rewritten each time
 *
 * Appending means read-modify-write, and a read that fails mid-startup would lose
 * the earlier lines — exactly the ones that explain the failure. The buffer is
 * small, held in memory, and written whole, so the file on disk is always a
 * complete prefix of what the plugin has seen.
 */
var fileBuffer = [];

function appendToFile(line) {
  var sink = state.file;
  if (!sink) return;
  fileBuffer.push(line);
  if (fileBuffer.length > 500) fileBuffer.shift();
  try {
    var uxp = require('uxp');
    var fs = uxp.storage.localFileSystem;
    if (!fs || typeof fs.createEntryWithUrl !== 'function') {
      state.file = null;
      return;
    }
    fs.createEntryWithUrl('plugin-data://' + sink.name, { overwrite: true }).then(
      function (entry) {
        return entry.write(fileBuffer.join('\n') + '\n', { format: uxp.storage.formats.utf8 });
      },
      function () {
        /* the data folder is unavailable; the console sink still works */
        state.file = null;
      },
    );
  } catch (err) {
    /* a diagnostic sink must never break logging */
  }
}

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
  appendToFile(new Date().toISOString() + ' [' + level + '] ' + full);
}

var Logger = {
  setLevel: function (level) {
    if (LEVELS.indexOf(level) !== -1) state.threshold = level;
  },
  getLevel: function () {
    return state.threshold;
  },
  /**
   * Turn on the in-plugin-folder log file. Called when `devTools` is enabled.
   *
   * Written last so it captures everything from the very first line, which is the
   * whole point: a plugin that dies during load leaves a file that says so.
   */
  enableFileSink: function (name) {
    state.file = { name: name || 'ai-studio.log' };
    // Written immediately, and unconditionally. A sink that only records once
    // something else has already logged cannot distinguish "nothing happened"
    // from "the sink is broken" — which is the only thing it is here to tell.
    appendToFile(new Date().toISOString() + ' [info] --- log sink enabled ---');
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
