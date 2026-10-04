import type { Server } from 'node:http';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import {
  AssignRoleRequestSchema,
  ChatRequestSchema,
  ModelProfileInputSchema,
  TOOL_META,
  toStudioError,
} from '@photoshop-ai-studio/shared';
import type { ChatMessage, StudioError, StudioEvent } from '@photoshop-ai-studio/shared';
import { type LogBus } from '@photoshop-ai-studio/shared/node';
import type { Logger } from '@photoshop-ai-studio/shared/node';
import { type Orchestrator } from '../orchestrator.js';
import type { McpClient } from '../mcp/client.js';
import type { OrchestratorConfig } from '../config.js';

export interface ApiOptions {
  orchestrator: Orchestrator;
  client: McpClient;
  config: OrchestratorConfig;
  logger: Logger;
  bus: LogBus;
  /** Shared hub, so the Orchestrator can publish before the HTTP app exists. */
  events: EventHub;
}

export function createApiApp(options: ApiOptions): { app: Express; events: EventHub } {
  const { orchestrator, client, config, logger, events } = options;

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  if (config.allowedOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.allowedOrigins.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }

  // --- status / state ------------------------------------------------------

  app.get('/api/health', async (_req, res) => {
    res.json({
      ok: true,
      service: 'orchestrator',
      version: '0.1.0',
      running: orchestrator.isRunning,
      mcp: { url: client.url, connected: client.isConnected(), error: client.error },
    });
  });

  app.get('/api/state', async (_req, res) => {
    const { snapshot, connection, tools } = await orchestrator.getState();
    res.json({
      connection,
      snapshot,
      tools: tools.length > 0 ? TOOL_META.filter((t) => tools.includes(t.tool)) : TOOL_META,
      model: orchestrator.modelRoles,
      jev: orchestrator.jevInfo,
      running: orchestrator.isRunning,
    });
  });

  app.get('/api/tools', async (_req, res) => {
    let advertised: string[] = [];
    let error: string | null = null;
    try {
      advertised = (await client.listTools()).map((t) => t.tool);
    } catch (err) {
      error = (err as Error).message;
    }
    res.json({
      tools: TOOL_META.filter((t) => advertised.length === 0 || advertised.includes(t.tool)),
      mcp: { connected: advertised.length > 0, url: client.url, toolCount: advertised.length, error },
    });
  });

  // --- model registry ------------------------------------------------------

  /**
   * Add, edit, remove and route LLMs.
   *
   * Keys go in through these endpoints and never come back out: every response is
   * built from `publicView()`, which drops the credential, and the browser is
   * told only whether one is set. They also cannot be read back to be edited, so
   * editing a profile without retyping its key keeps the stored one.
   */
  app.get('/api/models', (_req, res) => {
    res.json(orchestrator.listModels());
  });

  app.post('/api/models', (req, res) => {
    const parsed = ModelProfileInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: parsed.error.issues[0]?.message ?? 'invalid model', recoverable: false } });
    }
    res.status(201).json(orchestrator.addModel(parsed.data));
  });

  app.patch('/api/models/:id', (req, res) => {
    const parsed = ModelProfileInputSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: parsed.error.issues[0]?.message ?? 'invalid model', recoverable: false } });
    }
    res.json(orchestrator.updateModel(req.params.id!, parsed.data));
  });

  app.delete('/api/models/:id', (req, res) => {
    orchestrator.removeModel(req.params.id!);
    res.status(204).end();
  });

  app.post('/api/models/:id/assign', (req, res) => {
    const parsed = AssignRoleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: parsed.error.issues[0]?.message ?? 'invalid role', recoverable: false } });
    }
    orchestrator.assignModelRole(parsed.data.role, parsed.data.profileId);
    res.json(orchestrator.listModels());
  });

  /** A real completion, not a socket check: several endpoints answer `/models` and refuse the actual call. */
  app.post('/api/models/:id/probe', async (req, res) => {
    res.json(await orchestrator.probeModel(req.params.id!));
  });

  // --- chat / runs ---------------------------------------------------------

  app.post('/api/chat', async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'INVALID_PARAMS',
          message: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; '),
          recoverable: true,
        },
      });
    }
    const { run, message } = await orchestrator.submit(parsed.data);
    res.status(201).json({ run, message });
  });

  app.get('/api/runs', (req, res) => {
    const limit = clampLimit(req.query.limit, 20);
    res.json({ runs: orchestrator.listRuns(limit) });
  });

  app.get('/api/runs/:id', (req, res) => {
    res.json(orchestrator.getRun(String(req.params.id)));
  });

  app.post('/api/runs/:id/approve', async (req, res) => {
    const body = (req.body ?? {}) as { confirmations?: { stepId: string; approved: boolean }[]; autoApprove?: boolean };
    const detail = await orchestrator.approve(
      String(req.params.id),
      Array.isArray(body.confirmations) ? body.confirmations : [],
      { ...(typeof body.autoApprove === 'boolean' ? { autoApprove: body.autoApprove } : {}) },
    );
    res.json(detail);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    res.json(orchestrator.cancel(String(req.params.id)));
  });

  /**
   * On-demand preview render.
   *
   * A separate endpoint rather than part of `/state` because it costs a real
   * Photoshop round trip (export a downscaled PNG and read it back). The Studio
   * calls it when the document identity or geometry changes.
   */
  app.get('/api/preview', async (_req, res) => {
    try {
      const maxWidth = clampLimit(_req.query.maxWidth, 480);
      const { data } = await client.call('render_preview', {
        documentId: 'active',
        maxWidth,
      } as never);
      const preview = data as { mimeType: string; base64: string };
      res.json({ preview: { mimeType: preview.mimeType, base64: preview.base64 } });
    } catch (err) {
      const error = toStudioError(err);
      // A missing preview must never break the page: the schematic stands in.
      logger.debug({ event: 'connection', message: `preview unavailable: ${error.message}` });
      res.status(200).json({ preview: null, error });
    }
  });

  // --- history -------------------------------------------------------------

  app.get('/api/history', (req, res) => {
    res.json({ records: orchestrator.listHistory(clampLimit(req.query.limit, 50)) });
  });

  // --- live events (NDJSON) ------------------------------------------------

  app.get('/api/events', (req, res) => {
    events.attach(req, res);
  });

  // --- static Studio bundle (optional single-process mode) -----------------

  if (config.serveStatic) {
    app.use(express.static(config.studioDist, { index: 'index.html' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile('index.html', { root: config.studioDist }, (err) => {
        if (err) next();
      });
    });
  }

  app.use(errorHandler);
  return { app, events };
}

/**
 * Newline-delimited JSON fan-out for the Studio.
 *
 * Chosen over SSE because it needs no framing negotiation, survives proxies, and
 * is trivially read from `fetch` + `ReadableStream` in the browser. The MCP
 * server's `/events` feed is piped into the same hub so the LOG tab shows the
 * Photoshop side of every call too.
 */
export class EventHub {
  private readonly clients = new Set<Response>();
  private mcpAbort: AbortController | null = null;

  constructor(private readonly logger: Logger) {}

  publish = (event: StudioEvent): void => {
    const line = `${JSON.stringify(event)}\n`;
    for (const client of this.clients) {
      if (!client.writableEnded) client.write(line);
    }
  };

  attach(req: Request, res: Response): void {
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`${JSON.stringify({ type: 'hello', version: '0.1.0' })}\n`);

    this.clients.add(res);
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write('{"_":"keepalive"}\n');
    }, 15_000);
    keepAlive.unref?.();

    req.on('close', () => {
      clearInterval(keepAlive);
      this.clients.delete(res);
      if (!res.writableEnded) res.end();
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Mirror the MCP server's log stream into our own bus so the Studio's LOG tab
   * shows `photoshop.request` / `photoshop.response` records without the browser
   * opening a second long-lived connection to another origin.
   */
  async mirrorMcpEvents(url: string, bus: LogBus): Promise<void> {
    if (this.mcpAbort) return;
    const controller = new AbortController();
    this.mcpAbort = controller;

    const loop = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index = buffer.indexOf('\n');
            while (index !== -1) {
              const line = buffer.slice(0, index).trim();
              buffer = buffer.slice(index + 1);
              index = buffer.indexOf('\n');
              if (line.length === 0 || line.startsWith('{"_"')) continue;
              try {
                const entry = JSON.parse(line) as Parameters<LogBus['write']>[0];
                if (entry && typeof entry === 'object' && 'event' in entry) bus.write(entry);
              } catch {
                /* ignore a partial line */
              }
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          this.logger.debug({ event: 'connection', message: `MCP event mirror paused: ${(err as Error).message}` });
          await delay(5_000);
        }
      }
    };

    void loop();
  }

  async close(): Promise<void> {
    this.mcpAbort?.abort();
    this.mcpAbort = null;
    for (const client of this.clients) {
      if (!client.writableEnded) client.end();
    }
    this.clients.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampLimit(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(500, Math.max(1, parsed));
}

/**
 * Reports a failed request.
 *
 * A `StudioException` already knows what went wrong and whether retrying could
 * help; discarding that in favour of a blanket `INTERNAL` told the Studio a
 * rejected request had failed on the server. The status is derived from the code
 * so a wrong argument comes back as a 400 the client can act on, and only a
 * genuine fault stays a 5xx.
 */
function errorHandler(err: Error & { status?: number; statusCode?: number; code?: StudioError['code']; recoverable?: boolean }, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  const status = err.status ?? err.statusCode ?? statusForCode(err.code);
  const body: { error: StudioError } = {
    error: {
      code: status === 404 ? 'INVALID_PARAMS' : (err.code ?? 'INTERNAL'),
      message: err.message,
      recoverable: err.recoverable ?? status < 500,
    },
  };
  res.status(status).json(body);
}

/** Client fault → 4xx, everything else → 5xx. */
function statusForCode(code: StudioError['code'] | undefined): number {
  if (!code) return 500;
  switch (code) {
    case 'INVALID_PARAMS':
    case 'UNKNOWN_TOOL':
    case 'UNSUPPORTED_OPERATION':
    case 'UNSUPPORTED_FORMAT':
    case 'INVALID_COLOR':
      return 400;
    case 'MODEL_UNAVAILABLE':
      return 503;
    case 'FILE_NOT_FOUND':
    case 'DOCUMENT_NOT_FOUND':
    case 'LAYER_NOT_FOUND':
    case 'GROUP_NOT_FOUND':
      return 404;
    case 'NOT_CONNECTED':
    case 'WORKSPACE_NOT_GRANTED':
      return 409;
    default:
      return 500;
  }
}

export type { ChatMessage, Server };
