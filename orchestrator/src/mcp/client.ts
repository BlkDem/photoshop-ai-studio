import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  OPERATIONS,
  StudioException,
  TOOL_META,
  TOOL_META_MAP,
  opForTool,
  type Expectation,
  type ParamsOf,
  type PhotoshopOpName,
  type ResultOf,
  type StudioError,
  type ToolMeta,
} from '@photoshop-ai-studio/shared';
import type { Logger } from '@photoshop-ai-studio/shared/node';

/**
 * The Orchestrator's MCP client.
 *
 * Two things worth knowing:
 *
 * 1. The MCP server is **stateless**, so this client holds no session. It
 *    re-`initialize`s per call, which is cheap on loopback and removes a whole
 *    class of "stale session after restart" bugs.
 * 2. A schema violation is rejected by the server with JSON-RPC `-32602`
 *    *before* dispatch, so `callTool` can **throw** rather than return an error
 *    envelope. Both channels are normalised into `StudioException` here, so
 *    callers only ever see one failure type.
 */
export interface McpCallResult<K extends PhotoshopOpName> {
  data: ResultOf<K>;
  durationMs: number;
  raw: unknown;
}

export interface McpClientOptions {
  url: string;
  timeoutMs: number;
  logger: Logger;
}

export class McpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private advertised: Set<string> | null = null;
  private lastError: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly options: McpClientOptions) {}

  get url(): string {
    return this.options.url;
  }

  get error(): string | null {
    return this.lastError;
  }

  isConnected(): boolean {
    return this.client !== null && this.transport !== null;
  }

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) {
      await this.connecting;
      if (this.client) return this.client;
    }

    this.connecting = (async () => {
      const client = new Client(
        { name: 'photoshop-ai-studio-orchestrator', version: '0.1.0' },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
        requestInit: { signal: AbortSignal.timeout(this.options.timeoutMs) },
      });
      transport.onerror = (error: Error) => {
        this.lastError = error.message;
      };
      transport.onclose = () => {
        this.client = null;
        this.transport = null;
        this.advertised = null;
      };
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.lastError = null;
      this.options.logger.info({ event: 'mcp.call', message: `connected to MCP server at ${this.options.url}` });
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    if (!this.client) throw new StudioException('MODEL_UNAVAILABLE', 'MCP client failed to connect');
    return this.client;
  }

  /** Lists tools once and caches the result; also our MCP liveness probe. */
  async listTools(): Promise<ToolMeta[]> {
    if (this.advertised) return TOOL_META.filter((t) => this.advertised!.has(t.tool));
    const client = await this.ensure();
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      this.advertised = names;
      const unknown = [...names].filter((n) => !TOOL_META_MAP[n]);
      if (unknown.length > 0) {
        this.options.logger.warn({
          event: 'mcp.call',
          message: `MCP server advertises ${unknown.length} tool(s) this build does not know about`,
          data: { unknown },
        });
      }
      return TOOL_META.filter((t) => names.has(t.tool));
    } catch (err) {
      this.lastError = (err as Error).message;
      throw new StudioException('MODEL_UNAVAILABLE', `MCP server unreachable at ${this.options.url}: ${this.lastError}`, {
        cause: err,
      });
    }
  }

  /**
   * Invokes a Photoshop tool. Returns the adapter's structured payload; throws
   * `StudioException` for every failure mode.
   */
  async call<K extends PhotoshopOpName>(op: K, params: ParamsOf<K>): Promise<McpCallResult<K>> {
    const tool = OPERATIONS[op].tool;
    const started = Date.now();
    const log = this.options.logger.child({ tool, event: 'mcp.call' });

    const client = await this.ensure();
    log.debug({ message: `→ ${tool}`, data: params });

    let result;
    try {
      result = await client.callTool(
        { name: tool, arguments: params as Record<string, unknown> },
        undefined,
        { timeout: this.options.timeoutMs },
      );
    } catch (err) {
      const durationMs = Date.now() - started;
      const error = this.normalizeCallFailure(err, tool);
      log.error({ message: `✗ ${tool}`, durationMs, data: error });
      throw new StudioException(error.code, error.message, {
        recoverable: error.recoverable,
        details: error.details,
        cause: err,
      });
    }

    const durationMs = Date.now() - started;
    const structured = result.structuredContent as { success?: boolean; data?: unknown; error?: StudioError } | undefined;

    if (result.isError || structured?.success === false) {
      // The SDK validates arguments against the tool's JSON Schema *before* the
      // handler runs, so a schema violation arrives as a JSON-RPC error with no
      // structured payload. Classify it properly: a bad argument is exactly the
      // recoverable failure the repair loop should react to.
      const error: StudioError =
        structured?.error ?? classifyProtocolError(firstText(result.content), tool);
      log.error({ message: `✗ ${tool}: ${error.code}`, durationMs, data: error });
      throw new StudioException(error.code, error.message, {
        recoverable: error.recoverable,
        details: error.details,
        photoshopCode: error.photoshopCode,
      });
    }

    if (structured?.success === true && structured.data !== undefined) {
      log.info({ message: `✓ ${tool}`, durationMs });
      return { data: structured.data as ResultOf<K>, durationMs, raw: structured };
    }

    // Some clients drop `structuredContent`; fall back to the text block rather
    // than reporting a phantom failure.
    const text = firstText(result.content);
    if (text) {
      try {
        const parsed = JSON.parse(text) as { success?: boolean; data?: unknown; error?: StudioError };
        if (parsed.success === true && parsed.data !== undefined) {
          log.info({ message: `✓ ${tool}`, durationMs });
          return { data: parsed.data as ResultOf<K>, durationMs, raw: parsed };
        }
        if (parsed.error) {
          log.error({ message: `✗ ${tool}: ${parsed.error.code}`, durationMs, data: parsed.error });
          throw new StudioException(parsed.error.code, parsed.error.message, {
            recoverable: parsed.error.recoverable,
            details: parsed.error.details,
          });
        }
      } catch (err) {
        if (err instanceof StudioException) throw err;
        /* fall through to the generic failure below */
      }
    }

    log.error({ message: `✗ ${tool}: unparseable result`, durationMs });
    throw new StudioException('INTERNAL', `${tool} returned a result this client could not read`, {
      recoverable: false,
    });
  }

  /** Convenience: call a tool described by a plan step. */
  async callStep(tool: string, params: Record<string, unknown>): Promise<McpCallResult<PhotoshopOpName>> {
    const op = opForTool(tool);
    if (!op) {
      throw new StudioException('UNKNOWN_TOOL', `"${tool}" is not a Photoshop tool`, {
        details: { tool, known: Object.keys(TOOL_META_MAP) },
      });
    }
    return this.call(op, params as never) as Promise<McpCallResult<PhotoshopOpName>>;
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* already closed */
    }
    this.client = null;
    this.transport = null;
    this.advertised = null;
  }

  /**
   * Maps transport/protocol failures onto the shared error taxonomy so the
   * repair loop can reason about them like any other Photoshop error.
   */
  private normalizeCallFailure(err: unknown, tool: string): StudioError {
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof err === 'object' && err !== null && 'code' in err ? Number((err as { code: unknown }).code) : undefined;

    if (code === -32602 || /input validation/i.test(message)) {
      return { code: 'INVALID_PARAMS', message: `${tool} rejected its arguments: ${message}`, recoverable: true };
    }
    if (code === -32001 || code === -32000) {
      return { code: 'MODEL_UNAVAILABLE', message: `MCP server rejected the request: ${message}`, recoverable: true };
    }
    if (/fetch failed|ECONNREFUSED|socket|terminated|timeout|aborted/i.test(message)) {
      this.client = null;
      this.transport = null;
      this.advertised = null;
      return { code: 'MODEL_UNAVAILABLE', message: `MCP server unreachable: ${message}`, recoverable: true };
    }
    return { code: 'INTERNAL', message, recoverable: false };
  }
}

/** Maps a pre-dispatch SDK rejection onto the shared taxonomy. */
function classifyProtocolError(text: string | null, tool: string): StudioError {
  const message = text ?? `${tool} failed`;
  if (/-32602|input validation|unknown tool|not found/i.test(message)) {
    return {
      code: 'UNKNOWN_TOOL',
      message: `${tool} was rejected before dispatch: ${message}`,
      recoverable: true,
      details: { tool },
    };
  }
  return { code: 'INTERNAL', message, recoverable: false };
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

export type { Expectation };
