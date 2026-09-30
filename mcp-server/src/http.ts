import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { LogEntry, PhotoshopAdapter } from '@photoshop-ai-studio/shared';
import type { Logger } from '@photoshop-ai-studio/shared/node';
import { type LogBus } from '@photoshop-ai-studio/shared/node';
import { createMcpServer } from './server.js';

/**
 * MCP over Streamable HTTP, **stateless** (`sessionIdGenerator: undefined`).
 *
 * Each POST builds a fresh `McpServer` + transport; the shared `PhotoshopAdapter`
 * carries the only state that actually matters (which Photoshop is attached).
 * This is the mode the SDK documents for API-style servers and it is the right
 * fit because our clients are (a) the orchestrator, (b) the MCP Inspector and
 * (c) short-lived browser tabs — none of which benefit from a server-side
 * session map, and all of which would otherwise leak entries.
 *
 * Consequences of statelessness: no `GET` notification stream (405) and no
 * `DELETE` session teardown (405). The Studio's live updates use the separate
 * NDJSON feed at `/events` instead, which needs no MCP session.
 */
export const MCP_ROUTE = '/mcp';

export interface HttpOptions {
  adapter: PhotoshopAdapter;
  logger: Logger;
  bus: LogBus;
  allowedHosts: string[];
  allowedOrigins: string[];
}

export function createHttpApp(options: HttpOptions): { app: Express } {
  const { adapter, logger, bus } = options;

  const app = express();
  app.disable('x-powered-by');
  // The transport reads the raw body; the limit is generous because
  // `render_preview` returns a base64 PNG.
  app.use(express.json({ limit: '48mb' }));

  app.use(hostHeaderGuard(options.allowedHosts));
  if (options.allowedOrigins.length > 0) app.use(corsFor(options.allowedOrigins));

  // --- health / observability ---------------------------------------------

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'mcp-server', adapter: adapter.getConnection() });
  });

  app.get('/tools', (_req, res) => {
    res.json({ adapter: adapter.target, connection: adapter.getConnection() });
  });

  /** Newline-delimited JSON stream of structured logs. */
  app.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const write = (entry: LogEntry): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(entry)}\n`);
    };
    for (const entry of bus.recent(150)) write(entry);

    const unsubscribe = bus.subscribe(write);
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(`{"_":"keepalive"}\n`);
    }, 15_000);
    keepAlive.unref?.();

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      if (!res.writableEnded) res.end();
    });
  });

  // --- MCP -----------------------------------------------------------------

  app.post(
    MCP_ROUTE,
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const server = createMcpServer({ adapter, logger });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: false,
          keepAliveMs: 15_000,
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          logger.error({ event: 'error', message: 'MCP request failed', data: { error: String(err) } });
          if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
          } else {
            res.end();
          }
        } finally {
          void server.close().catch(() => undefined);
          void transport.close().catch(() => undefined);
        }
      })().catch(next);
    },
  );

  // Stateless mode has no session lifecycle to negotiate.
  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This MCP server is stateless: only POST is supported.' },
      id: null,
    });
  };
  app.get(MCP_ROUTE, methodNotAllowed);
  app.delete(MCP_ROUTE, methodNotAllowed);

  app.use(errorHandler);

  return { app };
}

/**
 * DNS-rebinding protection. A hostile page can point a browser at a localhost
 * server, so the Host header must match something we expect before we answer.
 */
function hostHeaderGuard(allowedHosts: string[]) {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (allowed.size === 0) return next();
    const host = (req.headers.host ?? '').toLowerCase();
    const hostOnly = host.replace(/:\d+$/, '');
    const ok = allowed.has(host) || [...allowed].some((entry) => entry.replace(/:\d+$/, '') === hostOnly);
    if (!ok) {
      res.status(421).json({ error: { code: 'HOST_NOT_ALLOWED', message: `Host header "${host}" is not allowed` } });
      return;
    }
    next();
  };
}

function corsFor(origins: string[]): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,mcp-session-id,last-event-id,accept');
      res.setHeader('access-control-expose-headers', 'mcp-session-id,last-event-id');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
}
