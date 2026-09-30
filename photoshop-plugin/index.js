/**
 * Plugin entry point.
 *
 * `entrypoints.setup()` must be called **synchronously at the top level** of the
 * first script UXP evaluates. Calling it later (e.g. after an `await`) throws an
 * uncatchable error on several Photoshop versions, so there is deliberately no
 * async work before this block.
 */
'use strict';

var entrypoints = require('uxp').entrypoints;
var bridge = require('./lib/bridge.js');
var Logger = require('./lib/logger.js').Logger;

var ui = null;

entrypoints.setup({
  plugin: {
    create: function () {
      Logger.setLevel('info');
      Logger.info('Photoshop AI Studio plugin created');
      // Connect eagerly: the panel may never be opened, and the AI should still
      // be able to reach a document the user already has open.
      bridge.connect();
    },
    destroy: function () {
      bridge.disconnect();
    },
  },

  panels: {
    aiStudioPanel: {
      show: function (rootNode) {
        if (!ui) ui = createUi();
        ui.attach(rootNode);
        ui.render(bridge.getStats());
      },
      hide: function () {
        if (ui) ui.detach();
      },
      destroy: function () {
        if (ui) ui.destroy();
        ui = null;
      },
    },
  },

  commands: {
    aiStudioReconnect: {
      run: function () {
        Logger.info('reconnect command invoked');
        bridge.disconnect();
        bridge.connect();
      },
    },
  },
});

// ---------------------------------------------------------------------------
// panel UI
//
// The panel is intentionally minimal (brief §4): connection state, the endpoint
// it is talking to, and a connect toggle. All editing logic lives behind MCP.
// ---------------------------------------------------------------------------

function createUi() {
  var refs = {};
  var listeners = [];

  function ref(id) {
    return document.getElementById(id);
  }

  function attach(rootNode) {
    refs = {
      status: ref('status'),
      endpoint: ref('endpoint'),
      host: ref('host'),
      url: ref('bridge-url'),
      root: ref('workspace-root'),
      error: ref('last-error'),
      docs: ref('stat-docs'),
      active: ref('stat-active'),
      latency: ref('stat-latency'),
      ops: ref('stat-ops'),
      toggle: ref('toggle'),
      ping: ref('ping'),
      save: ref('save-config'),
    };
    if (!refs.toggle) return;

    bind(refs.toggle, 'click', function () {
      if (bridge.isConnected()) {
        bridge.disconnect();
      } else {
        bridge.connect({
          bridgeUrl: refs.url ? refs.url.value : undefined,
          workspaceRoot: refs.root ? refs.root.value : undefined,
        });
      }
      render(bridge.getStats());
    });

    bind(refs.ping, 'click', function () {
      Logger.info('ping requested from the panel');
    });

    bind(refs.save, 'click', function () {
      persistConfig();
      render(bridge.getStats());
    });
  }

  function detach() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i].target.removeEventListener(listeners[i].event, listeners[i].handler);
      } catch (err) {
        /* element already gone */
      }
    }
    listeners = [];
  }

  /**
   * UXP parses `innerHTML` event handlers as code, which needs
   * `allowCodeGenerationFromStrings` and behaves unpredictably. Everything here
   * uses `addEventListener`.
   */
  function bind(target, event, handler) {
    if (!target) return;
    target.addEventListener(event, handler);
    listeners.push({ target: target, event: event, handler: handler });
  }

  function render(stats) {
    if (!refs.status) return;

    if (stats.connected) {
      refs.status.textContent = '● Connected';
      refs.status.className = 'badge badge--on';
    } else if (state.wanted) {
      refs.status.textContent = '○ Connecting…';
      refs.status.className = 'badge badge--wait';
    } else {
      refs.status.textContent = '● Disconnected';
      refs.status.className = 'badge badge--off';
    }

    var config = stats.config || {};
    if (refs.endpoint) refs.endpoint.textContent = config.bridgeUrl || '';
    if (refs.host) {
      refs.host.textContent = 'UXP ' + uxpVersion() + ' · Photoshop ' + hostVersion();
    }
    if (refs.url && document.activeElement !== refs.url) refs.url.value = config.bridgeUrl || '';
    if (refs.root && document.activeElement !== refs.root) {
      refs.root.value = config.workspaceRoot || '';
    }

    if (refs.docs) refs.docs.textContent = String(stats.documents.length);
    if (refs.active) refs.active.textContent = stats.active || '—';
    if (refs.latency) refs.latency.textContent = stats.stats.lastLatencyMs ? stats.stats.lastLatencyMs + ' ms' : '—';
    if (refs.ops) refs.ops.textContent = String(stats.stats.ops);
    if (refs.toggle) refs.toggle.textContent = stats.connected ? 'Disconnect' : 'Connect';
    if (refs.ping) refs.ping.disabled = !stats.connected;
    if (refs.save) refs.save.disabled = !stats.config;
  }

  /** Writes the user's edits back to config.json via the plugin's data folder. */
  function persistConfig() {
    var fs = require('uxp').storage.localFileSystem;
    fs.getPluginFolder()
      .then(function (folder) {
        var entry = folder.getEntry('config.json');
        return entry.read({ format: require('uxp').storage.formats.utf8 });
      })
      .then(function (text) {
        var parsed = JSON.parse(text);
        if (refs.url && refs.url.value) parsed.bridgeUrl = refs.url.value;
        if (refs.root && refs.root.value) parsed.workspaceRoot = refs.root.value;
        return fs
          .getPluginFolder()
          .then(function (folder) {
            var entry = folder.createFile('config.json', { overwrite: true });
            return entry.write(JSON.stringify(parsed, null, 2), { format: require('uxp').storage.formats.utf8 });
          })
          .then(function () {
            Logger.info('configuration saved');
            bridge.loadConfig({ bridgeUrl: parsed.bridgeUrl, workspaceRoot: parsed.workspaceRoot });
          });
      })
      .catch(function (err) {
        if (refs.error) {
          refs.error.hidden = false;
          refs.error.textContent = 'Could not save config.json: ' + ((err && err.message) || String(err));
        }
      });
  }

  bridge.on('status', function () {
    render(bridge.getStats());
  });
  bridge.on('ops', function () {
    render(bridge.getStats());
  });
  bridge.on('config', function () {
    render(bridge.getStats());
  });

  return {
    attach: attach,
    detach: detach,
    destroy: function () {
      detach();
    },
    render: render,
  };
}

var state = { wanted: false };

function uxpVersion() {
  try {
    return String(require('uxp').versions.uxp);
  } catch (err) {
    return '?';
  }
}

function hostVersion() {
  try {
    return String(require('uxp').hostInformation.appVersion);
  } catch (err) {
    return '?';
  }
}

// Keep the "connecting…" badge accurate without a full re-render.
bridge.on('status', function (payload) {
  state.wanted = payload.state === 'connecting';
});
