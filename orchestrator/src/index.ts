import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { LogBus, createLogger } from '@photoshop-ai-studio/shared/node';
import { loadConfig } from './config.js';
import { McpClient } from './mcp/client.js';
import { Orchestrator } from './orchestrator.js';
import { EventHub, createApiApp } from './http/api.js';

/**
 * Orchestrator entry point.
 *
 * One process, one port. The Studio talks REST + an NDJSON event stream; the MCP
 * server is an outbound dependency over HTTP. With `SERVE_STATIC=true` this
 * process also serves the built Studio bundle, so `npm start` is a single
 * command.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (config.logFile) mkdirSync(dirname(config.logFile), { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });

  const bus = new LogBus();
  const logger = createLogger({
    source: 'orchestrator',
    level: config.logLevel,
    bus,
    ...(config.logFile ? { file: config.logFile } : {}),
  });

  const client = new McpClient({ url: config.mcpUrl, timeoutMs: config.mcpTimeoutMs, logger });

  const events = new EventHub(logger);
  const orchestrator = new Orchestrator({ config, logger, client, events });
  const { app } = createApiApp({ orchestrator, client, config, logger, bus, events });

  const server = app.listen(config.port, config.host, () => {
    logger.info({
      event: 'connection',
      message: `studio API listening on http://${config.host}:${config.port}/api`,
      data: { mcp: config.mcpUrl, dataDir: config.dataDir, serveStatic: config.serveStatic },
    });
    if (config.serveStatic) {
      logger.info({ event: 'connection', message: `serving Studio bundle from ${config.studioDist}` });
    }
  });

  server.on('error', (err) => {
    logger.error({ event: 'error', message: `HTTP server failed: ${err.message}` });
    process.exit(1);
  });

  // Fold the MCP server's structured logs into our own stream.
  void events.mirrorMcpEvents(config.mcpEventsUrl, bus);

  const shutdown = (signal: string): void => {
    logger.info({ event: 'connection', message: `received ${signal}, shutting down` });
    void events.close();
    void client.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ event: 'connection', message: `history file ${join(config.dataDir, 'history.jsonl')}` });
}

main().catch((err: unknown) => {
  console.error('orchestrator failed to start:', err);
  process.exit(1);
});
