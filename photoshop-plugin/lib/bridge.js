/**
 * WebSocket client to the MCP server.
 *
 * ## Why the plugin dials out
 *
 * The UXP runtime is a WebSocket **client only**: a plugin can connect to a
 * server but cannot listen on a port. So the MCP server hosts the bridge and the
 * plugin connects to it. That direction also means Photoshop needs no inbound
 * firewall allowance, and a Photoshop restart is recovered from by the reconnect
 * loop rather than by the user re-enabling something.
 *
 * ## Manifest permission note
 *
 * `requiredPermissions.network.domains` must list the loopback origin with an
 * explicit scheme and a trailing slash (`ws://localhost/`) and the connection
 * must be made to the hostname `localhost`, not the IP literal. Adobe documents
 * neither; this is the combination that works in practice (see
 * docs/architecture.md ADR-001). If a future Photoshop build rejects the
 * connection the symptom is a `bridge.close` with no `hello`, and the panel
 * shows the exact URL it tried.
 *
 * ## Serialisation
 *
 * Operations arrive one at a time and each opens its own modal scope, so a
 * request received while another is running is queued rather than interleaved.
 * The MCP server also serialises; this is the second half of the guarantee and it
 * matters for any future second client.
 */
'use strict';

var adapter = require('./adapter.js');
var errors = require('./errors.js');
var Logger = require('./logger.js').Logger;
var versions = require('uxp').versions;

var PROTOCOL_VERSION = 1;

var state = {
  socket: null,
  config: null,
  attempt: 0,
  wantConnected: false,
  handlers: {},
  stats: { ops: 0, lastLatencyMs: null, lastPingAt: null },
};

function emit(event, payload) {
  var handler = state.handlers[event];
  if (!handler) return;
  try {
    handler(payload);
  } catch (err) {
    Logger.error('bridge listener for "' + event + '" threw: ' + ((err && err.message) || String(err)));
  }
}

function send(frame) {
  var socket = state.socket;
  if (!socket || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch (err) {
    Logger.error('send failed: ' + ((err && err.message) || String(err)));
    return false;
  }
}

function sendLog(payload) {
  send({ v: PROTOCOL_VERSION, type: 'log', payload: payload });
}

Logger.setRemoteSink(sendLog);

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function loadConfig(overrides) {
  var config = {
    bridgeUrl: 'ws://localhost:3002/bridge',
    workspaceRoot: '',
    outputDir: '',
    reconnectBaseMs: 500,
    reconnectMaxMs: 15000,
  };

  // config.json sits next to the plugin; fs.getPluginFolder() is read-only and
  // needs no permission beyond `localFileSystem: "plugin"`.
  try {
    var fs = require('uxp').storage.localFileSystem;
    fs.getPluginFolder()
      .then(function (folder) {
        var entry = folder.getEntry('config.json');
        return entry.read({ format: require('uxp').storage.formats.utf8 });
      })
      .then(function (text) {
        var parsed = JSON.parse(text);
        for (var key in config) {
          if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== undefined && parsed[key] !== null) {
            config[key] = parsed[key];
          }
        }
        applyOverrides(config, overrides);
        state.config = config;
        emit('config', config);
        Logger.info('configuration loaded', { bridgeUrl: config.bridgeUrl, workspaceRoot: config.workspaceRoot });
      })
      .catch(function (err) {
        Logger.warn('config.json unreadable, using defaults: ' + ((err && err.message) || String(err)));
        applyOverrides(config, overrides);
        state.config = config;
        emit('config', config);
      });
  } catch (err) {
    Logger.error('could not read plugin configuration: ' + ((err && err.message) || String(err)));
  }

  return config;
}

function applyOverrides(config, overrides) {
  if (!overrides) return;
  for (var key in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key]) {
      config[key] = overrides[key];
    }
  }
}

function connect(overrides) {
  if (state.config) applyOverrides(state.config, overrides);
  else loadConfig(overrides);

  state.wantConnected = true;
  open();
}

function open() {
  var config = state.config || loadConfig();
  var socket;

  Logger.info('connecting to ' + config.bridgeUrl);
  emit('status', { connected: false, state: 'connecting' });

  try {
    socket = new WebSocket(config.bridgeUrl);
  } catch (err) {
    Logger.error('WebSocket construction failed: ' + ((err && err.message) || String(err)));
    scheduleReconnect();
    return;
  }

  state.socket = socket;

  socket.onopen = function () {
    state.attempt = 0;
    Logger.info('socket open, sending hello');
    send({
      v: PROTOCOL_VERSION,
      type: 'hello',
      payload: {
        pluginId: 'com.blkdem.photoshop-ai-studio',
        pluginVersion: '0.1.0',
        uxpVersion: versions ? String(versions.uxp) : 'unknown',
        hostApp: 'photoshop',
        hostVersion: hostVersion(),
        protocolVersion: PROTOCOL_VERSION,
        supports: adapter.SUPPORTED,
      },
    });
  };

  socket.onmessage = function (event) {
    var frame;
    try {
      frame = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch (err) {
      Logger.warn('unparseable frame from the MCP server');
      return;
    }
    handle(frame);
  };

  socket.onerror = function () {
    // UXP does not surface useful error detail here; the close handler reports.
    Logger.warn('socket error');
  };

  socket.onclose = function (event) {
    state.socket = null;
    Logger.warn('socket closed (' + (event && event.code) + ')', {
      reason: event && event.reason ? event.reason : undefined,
      url: config.bridgeUrl,
    });
    emit('status', { connected: false, state: 'closed', code: event && event.code });
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!state.wantConnected) return;
  var config = state.config || {};
  var base = config.reconnectBaseMs || 500;
  var max = config.reconnectMaxMs || 15000;
  var delay = Math.min(max, base * Math.pow(2, state.attempt));
  state.attempt += 1;
  Logger.info('reconnecting in ' + delay + 'ms (attempt ' + state.attempt + ')');
  setTimeout(open, delay);
}

function disconnect() {
  state.wantConnected = false;
  if (state.socket) {
    try {
      state.socket.close(1000, 'disconnected by user');
    } catch (err) {
      /* already gone */
    }
  }
  state.socket = null;
  emit('status', { connected: false, state: 'idle' });
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

function handle(frame) {
  if (!frame || frame.v !== PROTOCOL_VERSION) {
    Logger.warn('frame with protocol version ' + (frame && frame.v) + ' ignored; expected ' + PROTOCOL_VERSION);
    return;
  }

  if (frame.type === 'ping') {
    send({ v: PROTOCOL_VERSION, type: 'pong', id: frame.id, t: Date.now() });
    return;
  }
  if (frame.type === 'shutdown') {
    Logger.info('server asked the plugin to disconnect: ' + (frame.reason || 'no reason given'));
    disconnect();
    return;
  }
  if (frame.type === 'cancel') {
    Logger.warn('cancel for ' + frame.id + ' arrived after the operation returned; nothing to stop');
    return;
  }
  if (frame.type !== 'op') return;

  var started = Date.now();
  Logger.info('op ' + frame.op, frame.params);
  state.stats.ops += 1;

  adapter
    .execute(frame.op, frame.params, state.config || {})
    .then(function (result) {
      state.stats.lastLatencyMs = Date.now() - started;
      if (result.success) {
        Logger.debug('op ' + frame.op + ' ok in ' + state.stats.lastLatencyMs + 'ms');
      }
      send({ v: PROTOCOL_VERSION, type: 'op.result', id: frame.id, result: result });
      emit('ops', { total: state.stats.ops, lastLatencyMs: state.stats.lastLatencyMs });
    })
    .catch(function (err) {
      // adapter.execute is contracted not to throw; this is the belt-and-braces
      // path so a bug can never leave a request hanging on the server.
      var wire = errors.toWireError(err);
      Logger.error('op ' + frame.op + ' threw unexpectedly: ' + wire.message);
      send({
        v: PROTOCOL_VERSION,
        type: 'op.result',
        id: frame.id,
        result: { success: false, error: wire },
      });
    });
}

// ---------------------------------------------------------------------------
// state reporting
// ---------------------------------------------------------------------------

function hostVersion() {
  try {
    var info = require('uxp').hostInformation;
    return info ? String(info.appVersion) : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function isConnected() {
  return !!state.socket && state.socket.readyState === 1;
}

function getStats() {
  var docs = [];
  var active = null;
  try {
    var app = require('photoshop').app;
    for (var i = 0; i < app.documents.length; i += 1) {
      docs.push(app.documents[i].name);
      if (String(app.activeDocument.id) === String(app.documents[i].id)) active = app.documents[i].name;
    }
  } catch (err) {
    /* no document open */
  }
  return {
    connected: isConnected(),
    documents: docs,
    active: active,
    stats: state.stats,
    config: state.config,
  };
}

module.exports = {
  connect: connect,
  disconnect: disconnect,
  isConnected: isConnected,
  getStats: getStats,
  loadConfig: loadConfig,
  on: function (event, handler) {
    state.handlers[event] = handler;
  },
  SUPPORTED: adapter.SUPPORTED,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
};
