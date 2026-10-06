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
var uxp = require('uxp');
var buildInfo = require('./build-info.js');
var versions = uxp.versions;
var storage = uxp.storage;

var PROTOCOL_VERSION = 1;

var state = {
  socket: null,
  config: null,
  configError: null,
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

/**
 * How long `config.json` gets before the plugin gives up on it.
 *
 * A `.catch` is not enough. The read goes through `fs.getEntryWithUrl`, and a UXP
 * filesystem promise that never settles takes neither the resolve nor the reject
 * path — which deadlocks `connect()` before it ever opens the socket. The
 * symptom is a plugin that is loaded, whose panel works, and which never once
 * attempts a connection: indistinguishable from a suspended plugin, and measured
 * here rather than assumed.
 */
var CONFIG_TIMEOUT_MS = 2000;

/**
 * Reads `config.json` from the plugin folder.
 *
 * Returns a promise that always resolves: a missing, malformed, or *slow* config
 * must leave the plugin running with defaults, not dead. Sequencing matters —
 * `connect` waits for this before opening the socket, because an operation that
 * arrives before the config has loaded would run with an empty workspace root and
 * fail every filesystem operation.
 */
function loadConfig(overrides) {
  var config = {
    // `localhost`, NOT an IP literal. UXP's manifest parser discards IP-literal
    // hosts before matching a URL against `requiredPermissions.network.domains`,
    // so `ws://127.0.0.1:3002/bridge` is refused with "Manifest entry not found"
    // no matter how the domains are spelled — measured, after spending a cycle
    // changing this to an IP to chase an unrelated IPv6 theory. ADR-001 in
    // docs/architecture.md records the real behaviour; do not "fix" it again.
    bridgeUrl: 'ws://localhost:3002/bridge',
    workspaceRoot: '',
    outputDir: '',
    reconnectBaseMs: 500,
    reconnectMaxMs: 15000,
    // Matches the shipped config.json, and has to be here as well: `getConfig()`
    // returns these defaults until config.json has loaded, so without it every
    // consumer that asks during module load sees `undefined` for a setting that is
    // in fact on. That is how the in-folder log sink got switched off by the very
    // check meant to switch it on.
    devTools: true,
  };
  applyOverrides(config, overrides);
  state.config = config;

  var fs = storage.localFileSystem;
  var formatsUtf8 = storage.formats.utf8;

  var text0 = null;

  /**
   * Reads `config.json` from the plugin's own folder.
   *
   * Two strategies, because `Folder.getEntry()` did not return a readable entry
   * on Photoshop 26.11 / UXP 9.0.2 — the error surfaced as
   * "getEntry(...).read is not a function". `plugin:/` is the documented URL for
   * the folder holding `manifest.json` and works regardless; the folder walk is
   * kept as a fallback, guarded so a host that changes the shape cannot turn a
   * configuration problem into a dead plugin.
   */
  function readPluginFile(name) {
    // Every entry point is feature-detected and every promise is entered inside
    // a `try`, because a *synchronous* throw here would escape `loadConfig`
    // entirely: it would skip both the timeout race and the `.catch`, propagate
    // out of `connect()`, and take the rest of index.js with it. Since
    // `entrypoints.setup()` has already run by then, the panel still registers and
    // every UI function is a hoisted declaration — so the plugin looks completely
    // healthy while never once opening a socket. That is precisely the failure
    // this guarding exists to prevent, and it is why the plugin connected to
    // nothing at all for so long with no error anywhere.
    var strategies = [];

    if (fs && typeof fs.getEntryWithUrl === 'function') {
      strategies.push(function () {
        return fs.getEntryWithUrl('plugin:/' + name).then(function (entry) {
          if (!entry || typeof entry.read !== 'function') {
            throw new Error('getEntryWithUrl("plugin:/' + name + '") did not return a readable entry');
          }
          return entry.read({ format: storage.formats.utf8 });
        });
      });
    }

    if (fs && typeof fs.getPluginFolder === 'function') {
      strategies.push(function () {
        return fs.getPluginFolder().then(function (folder) {
          var entry = folder && typeof folder.getEntry === 'function' ? folder.getEntry(name) : null;
          if (!entry || typeof entry.read !== 'function') {
            throw new Error('could not read ' + name + ' from the plugin folder');
          }
          return entry.read({ format: storage.formats.utf8 });
        });
      });
    }

    if (strategies.length === 0) {
      return Promise.reject(
        new Error('no usable filesystem API for reading ' + name + ' (getEntryWithUrl=' + typeof (fs && fs.getEntryWithUrl) + ', getPluginFolder=' + typeof (fs && fs.getPluginFolder) + ')'),
      );
    }

    function attempt(index, lastError) {
      if (index >= strategies.length) {
        return Promise.reject(lastError || new Error('could not read ' + name));
      }
      var started;
      try {
        started = strategies[index]();
      } catch (err) {
        return attempt(index + 1, err);
      }
      return Promise.resolve(started).catch(function (err) {
        return attempt(index + 1, err);
      });
    }

    return attempt(0, null);
  }

  var read = readPluginFile('config.json');

  // Racing a real timeout rather than trusting the promise to settle.
  var guarded = new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, CONFIG_TIMEOUT_MS);
    read.then(
      function (text) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ text: text });
      },
      function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: err });
      },
    );
  });

  return guarded
    .then(function (outcome) {
      if (outcome.timedOut) {
        state.configError =
          'config.json did not answer within ' + CONFIG_TIMEOUT_MS + 'ms; continuing with defaults';
        Logger.warn(state.configError);
        applyOverrides(config, overrides);
        state.config = config;
        emit('config', config);
        return config;
      }
      if (outcome.error) throw outcome.error;
      return outcome.text;
    })
    .then(function (text) {
      if (typeof text !== 'string') return null;
      text0 = text;
      var parsed = JSON.parse(text);
      for (var key in parsed) {
        // `_`-prefixed keys are documentation, not settings.
        if (key.charAt(0) === '_') continue;
        if (parsed[key] === undefined || parsed[key] === null) continue;
        config[key] = parsed[key];
      }
      applyOverrides(config, overrides);
      state.config = config;
      emit('config', config);
      Logger.info('configuration loaded', { bridgeUrl: config.bridgeUrl, workspaceRoot: config.workspaceRoot });
    })
    .catch(function (err) {
      // Remembered and reported in `hello`: a config failure is otherwise
      // invisible, because the plugin is still running and still connected.
      state.configError = ((err && err.message) || String(err)) + ' | read=' + typeof text0;
      Logger.warn('config.json unreadable, using defaults: ' + state.configError);
      applyOverrides(config, overrides);
      state.config = config;
      emit('config', config);
    })
    .then(function () {
      return config;
    });
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
  state.wantConnected = true;

  // Idempotent. `connect()` is called from three places — module load, the panel's
  // `show`, and the reconnect command — and each call spends time loading
  // config.json before a socket exists.
  //
  // The guard has to cover *that* window, not just an open socket. Keying it on
  // `state.socket` alone let the panel's connect slip through while the module-load
  // one was still reading config, so two sockets opened ~200ms apart; the server
  // replaces the older connection on every new arrival, so the first was closed,
  // which scheduled a reconnect, which replaced the second — a loop that left the
  // plugin flapping and the server reporting "disconnected" the whole time.
  if (state.connecting) {
    Logger.info('connect: a connect is already in flight, ignoring this one');
    return;
  }
  var existing = state.socket;
  if (existing && (existing.readyState === 0 || existing.readyState === 1)) {
    Logger.info('connect: already ' + (existing.readyState === 1 ? 'open' : 'connecting') + ', not opening another');
    return;
  }
  state.connecting = true;

  // Sequenced deliberately: opening the socket first would let the first
  // operation run before the workspace root is known.
  // Belt and braces: `connect()` is called at module load, from the panel and
  // from a menu command. If any of those can throw, one bad call takes down
  // index.js with it, so nothing here is allowed to propagate.
  try {
    Promise.resolve(loadConfig(overrides))
      .then(function () {
        state.connecting = false;
        open();
      })
      .catch(function (err) {
        state.connecting = false;
        Logger.error('connect failed: ' + ((err && err.message) || String(err)));
        scheduleReconnect();
      });
  } catch (err) {
    state.connecting = false;
    Logger.error('connect threw: ' + ((err && err.message) || String(err)));
    scheduleReconnect();
  }
}

function open() {
  // `connect` sequences loadConfig before open, so state.config is always set
  // here; the guard keeps a direct `open()` from reading `undefined`.
  var config = state.config;
  if (!config) {
    Logger.error('open() called before the configuration was loaded');
    return;
  }
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
    state.connecting = false;
    Logger.info('socket open, sending hello');
    var sent = send({
      v: PROTOCOL_VERSION,
      type: 'hello',
      payload: {
        pluginId: 'com.blkdem.photoshop-ai-studio',
        pluginVersion: '0.1.0',
        // Which source this was built from, so "is the running plugin the code on
        // disk" is answerable instead of guessed at from log text. Photoshop caches
        // a loaded plugin, and reinstalling does not replace it in memory.
        buildId: buildInfo.buildId,
        uxpVersion: uxpVersion(),
        hostApp: 'photoshop',
        hostVersion: hostVersion(),
        protocolVersion: PROTOCOL_VERSION,
        supports: adapter.SUPPORTED,
        // Reported so a mismatch is visible from the MCP server's log instead of
        // surfacing later as a puzzling "workspaceRoot is not configured" on the
        // first export. Cross-OS setups get this wrong constantly.
        config: {
          workspaceRoot: config.workspaceRoot || null,
          outputDir: config.outputDir || null,
          error: state.configError || null,
        },
      },
    });
    // `connect` fires HERE, not on an inbound hello frame. This plugin is the
    // side that initiates, so nothing would ever arrive to trigger it otherwise —
    // and every listener (the panel's status badge, startup diagnostics) would
    // silently wait for an event that cannot happen.
    if (sent) {
      emit('status', { connected: true, state: 'connected' });
      emit('connect', {
        connected: true,
        pluginId: 'com.blkdem.photoshop-ai-studio',
        pluginVersion: '0.1.0',
        uxpVersion: uxpVersion(),
        hostApp: 'photoshop',
        hostVersion: hostVersion(),
      });
    }
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
    state.connecting = false;
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

/**
 * The Photoshop version.
 *
 * `hostInformation.appVersion` is the documented source, but it is not present on
 * every host build — reporting the literal string "unknown" in the Studio's header
 * is worse than reporting what we can actually verify, so fall back to a clearly
 * labelled UXP build id instead.
 */
function hostVersion() {
  try {
    var info = require('uxp').hostInformation;
    if (info && info.appVersion) return String(info.appVersion);
    if (info && info.appName) return String(info.appName) + ' (version unavailable)';
  } catch (err) {
    /* fall through */
  }
  return 'unknown (UXP ' + uxpVersion() + ')';
}

function uxpVersion() {
  try {
    return String(versions.uxp);
  } catch (err) {
    return '?';
  }
}

/**
 * Tells the server the document changed without an operation being responsible.
 *
 * Used by the panel's demo-document button: the Studio should refresh its snapshot
 * when the user changes something in Photoshop by hand, not only when a tool ran.
 */
function notifyStateChanged(reason, documentId) {
  send({
    v: PROTOCOL_VERSION,
    type: 'state.changed',
    reason: reason || 'external',
    documentId: documentId,
  });
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

/**
 * The configuration currently in force.
 *
 * The panel needs it to grant filesystem access to the right folder, and the
 * grant is only valid for the exact root the plugin is configured with.
 */
function getConfig() {
  return state.config || { bridgeUrl: 'ws://localhost:3002/bridge', workspaceRoot: '', outputDir: '' };
}

module.exports = {
  getConfig: getConfig,
  connect: connect,
  disconnect: disconnect,
  isConnected: isConnected,
  notifyStateChanged: notifyStateChanged,
  getStats: getStats,
  loadConfig: loadConfig,
  on: function (event, handler) {
    state.handlers[event] = handler;
  },
  SUPPORTED: adapter.SUPPORTED,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
};
