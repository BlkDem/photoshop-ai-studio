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

// Startup diagnostics, emitted once the socket is actually open.
bridge.on('connect', function (connection) {
  Logger.info('plugin connected', {
    pluginId: connection.pluginId,
    pluginVersion: connection.pluginVersion,
    hostApp: connection.hostApp,
    hostVersion: connection.hostVersion,
    uxpVersion: connection.uxpVersion,
  });
  // Dump the host's LayerKind mapping: it is the ground truth for the taxonomy in
  // lib/ps.js, and having it in the MCP server's log makes a future mismatch a
  // lookup rather than a guess.
  require('./lib/ps.js').logLayerKindEnum();
});

Logger.setLevel('info');

/**
 * Start the in-folder log file before anything else can fail.
 *
 * `devTools` gates it so it is off in normal use. It has to be enabled *first*:
 * the failure this exists to diagnose is the plugin going quiet during startup,
 * and a log file that starts after that point records nothing useful.
 */
// Unconditional, and first. A sink gated on `config.devTools` cannot work during
// module load, because the config has not been read yet — so the gate silently
// kept it off in exactly the case it existed for. `appendToFile` is a no-op until
// something calls `enableFileSink`, and it costs one file write.
Logger.enableFileSink('ai-studio.log');

entrypoints.setup({
  panels: {
    aiStudioPanel: {
      show: function (rootNode) {
        if (!ui) ui = createUi();
        ui.attach(rootNode);
        // Opening the panel connects, so the plugin recovers without a restart.
        // `connect()` is idempotent, so this is safe even when the module-load
        // connect below already got there first.
        bridge.connect();
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

/**
 * Connect as soon as the plugin loads.
 *
 * `plugin.create` also connects, and it works — the MCP server's log shows the
 * plugin reaching it repeatedly. This is belt and braces, and it is here for two
 * measured reasons rather than on the belief that the entrypoint was broken:
 *
 *  - It does not depend on the panel ever being opened. `loadEvent: "startup"`
 *    loads the plugin, but the AI should still reach a document the user already
 *    has open without a UI interaction first.
 *  - `connect()` is idempotent (see lib/bridge.js), so calling it from here, from
 *    the panel's `show`, and from the reconnect command cannot produce a second
 *    socket.
 *
 * An earlier version of this comment claimed UXP has no `plugin` lifecycle hook.
 * That was wrong — it was inferred from a connection problem that turned out to
 * be a duplicate MCP server in another checkout, not from anything about the
 * plugin. Do not remove this call on the strength of that claim.
 */
try {
  bridge.connect();
} catch (err) {
  // A throw here would abort the rest of this file. Everything below is a hoisted
  // function declaration and `entrypoints.setup` has already run, so the panel
  // would keep working perfectly and the plugin would simply never connect —
  // indistinguishable from a network problem. Nothing after this line may throw.
  console.error('AI Studio: bridge.connect() threw: ' + ((err && err.message) || String(err)));
}

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
      devTools: ref('dev-tools'),
      demoDoc: ref('demo-doc'),
      grant: ref('grant-access'),
      grantStatus: ref('grant-status'),
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

    if (refs.grant) {
      bind(refs.grant, 'click', function () {
        grantWorkspaceAccess();
      });
    }

    if (refs.demoDoc) {
      bind(refs.demoDoc, 'click', function () {
        createDemoDocument();
      });
    }
  }

  /**
   * Asks the user to grant this plugin access to the configured workspace.
   *
   * UXP gives a plugin filesystem access to exactly one folder the user picks,
   * for the session, and no amount of configuration can widen that. It has to
   * happen from a gesture, so it is a button rather than something the AI can
   * trigger — the plan is unchanged by granting access.
   */
  function grantWorkspaceAccess() {
    var ps = require('./lib/ps.js');
    if (refs.grant) refs.grant.disabled = true;
    if (refs.error) refs.error.hidden = true;

    ps.requestWorkspaceGrant(bridge.getConfig())
      .then(function (folder) {
        if (refs.grantStatus) {
          refs.grantStatus.hidden = false;
          refs.grantStatus.textContent = 'Granted: ' + folder.nativePath;
        }
        Logger.info('workspace access granted: ' + folder.nativePath);
      })
      .catch(function (err) {
        if (refs.grantStatus) {
          refs.grantStatus.hidden = false;
          refs.grantStatus.textContent = ((err && err.message) || String(err));
        }
        Logger.error('workspace access not granted: ' + ((err && err.message) || String(err)));
      })
      .then(function () {
        if (refs.grant) refs.grant.disabled = false;
      });
  }

  /**
   * Creates the demo document inside Photoshop's modal scope.
   *
   * This is a panel affordance, not an MCP tool: the AI has no `create_document`
   * capability, and giving it one purely so a demo can bootstrap itself would be
   * widening the product for testing convenience.
   */
  function createDemoDocument() {
    var demo = require('./lib/demo.js');
    var photoshop = require('photoshop');

    if (refs.demoDoc) refs.demoDoc.disabled = true;
    if (refs.error) refs.error.hidden = true;

    photoshop.core
      .executeAsModal(
        function () {
          return demo.createDemoDocument();
        },
        { commandName: 'AI Studio: demo document', interactive: false },
      )
      .then(function (result) {
        Logger.info('demo document ready: ' + result.name);
        render(bridge.getStats());
      })
      .catch(function (err) {
        Logger.error('demo document failed: ' + ((err && err.message) || String(err)));
        if (refs.error) {
          refs.error.hidden = false;
          refs.error.textContent = 'Could not create the demo document: ' + ((err && err.message) || String(err));
        }
      })
      .then(function () {
        if (refs.demoDoc) refs.demoDoc.disabled = false;
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
    if (refs.devTools) {
      // Opt-in: a shipped plugin should not offer this.
      refs.devTools.hidden = !(stats.config && stats.config.devTools);
    }
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
