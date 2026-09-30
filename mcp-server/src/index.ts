import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { LogBus, createLogger } from '@photoshop-ai-studio/shared/node';
import type { PhotoshopAdapter } from '@photoshop-ai-studio/shared';
import { loadMcpConfig, PLUGIN_ROUTE } from './config.js';
import { PluginBridge } from './bridge/plugin-bridge.js';
import { UxpRemoteAdapter } from './adapter/uxp-remote-adapter.js';
import { MockPhotoshopAdapter } from './adapter/mock-adapter.js';
import { createHttpApp } from './http.js';
import { Workspace } from './workspace.js';

/**
 * MCP server entry point.
 *
 * Two long-lived listeners:
 *   - `MCP_PORT`    Streamable HTTP  → the AI layer talks to this
 *   - `PLUGIN_PORT` WebSocket        → the UXP plugin dials *into* this (ADR-001)
 *
 * The adapter is chosen by configuration: the real UXP bridge by default, the
 * in-memory mock when `MOCK_PHOTOSHOP=true` so the whole pipeline can be
 * developed and tested without a Photoshop licence.
 */
async function main(): Promise<void> {
  const config = loadMcpConfig();

  if (config.logFile) mkdirSync(dirname(config.logFile), { recursive: true });

  const bus = new LogBus();
  const logger = createLogger({
    source: 'mcp',
    level: config.logLevel,
    bus,
    ...(config.logFile ? { file: config.logFile } : {}),
  });

  const workspace = new Workspace(config.workspaceRoot, config.outputDir);
  logger.info({
    event: 'connection',
    message: `workspace ${config.workspaceRoot}`,
    data: { outputDir: config.outputDir, adapter: config.useMockAdapter ? 'mock' : 'uxp' },
  });

  let adapter: PhotoshopAdapter;
  if (config.useMockAdapter) {
    const mock = new MockPhotoshopAdapter({ workspace, demoDocument: config.mockDemoDocument });
    adapter = mock;
    logger.warn({
      event: 'connection',
      message: 'MOCK_PHOTOSHOP=true — serving the in-memory adapter; Photoshop is NOT involved.',
    });
  } else {
    const bridge = new PluginBridge({
      port: config.pluginPort,
      host: '0.0.0.0',
      timeoutMs: config.bridgeTimeoutMs,
      heartbeatMs: config.heartbeatMs,
      logger,
    });
    await bridge.start();
    bridge.on('connect', (connection) =>
      logger.info({ event: 'connection', message: `Photoshop connected: ${connection.hostApp} ${connection.hostVersion}` }),
    );
    bridge.on('disconnect', () => logger.warn({ event: 'connection', message: 'Photoshop disconnected' }));

    adapter = new UxpRemoteAdapter(bridge, workspace);
  }

  const { app } = createHttpApp({
    adapter,
    logger,
    bus,
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedOrigins,
  });

  const httpServer = app.listen(config.mcpPort, config.host, () => {
    logger.info({
      event: 'connection',
      message: `MCP (Streamable HTTP) listening on http://${config.host}:${config.mcpPort}/mcp`,
    });
    if (!config.useMockAdapter) {
      logger.info({
        event: 'connection',
        message: `UXP bridge listening on ws://localhost:${config.pluginPort}${PLUGIN_ROUTE}`,
      });
    }
  });

  httpServer.on('error', (err) => {
    logger.error({ event: 'error', message: `HTTP server failed: ${err.message}` });
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    logger.info({ event: 'connection', message: `received ${signal}, shutting down` });
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('mcp-server failed to start:', err);
  process.exit(1);
});
