import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  OP_NAMES,
  OPERATIONS,
  StudioErrorSchema,
  StudioException,
  toStudioError,
  validateParams,
  type OperationDefinition,
  type PhotoshopAdapter,
  type PhotoshopOpName,
} from '@photoshop-ai-studio/shared';
import type { Logger } from '@photoshop-ai-studio/shared/node';
import { DISPATCH } from './dispatch.js';

/**
 * The MCP surface.
 *
 * Every entry in `shared/photoshop/operations.ts` becomes one `photoshop.*` MCP
 * tool with:
 *   - a strict zod input schema (with defaults) and a structured output schema
 *   - a description written for a planner model
 *   - `annotations` telling the client whether the call is read-only/destructive
 *   - a uniform `{ success, data | error }` structured result
 *
 * There is deliberately **no** `execute_anything` tool and no exposed
 * `batchPlay`: an open escape hatch would let a model bypass schema validation,
 * the workspace allowlist and the confirmation gate. `batchPlay` lives only
 * inside the plugin's adapter methods (docs/architecture.md §"Tool surface").
 */
export interface CreateMcpServerOptions {
  adapter: PhotoshopAdapter;
  logger: Logger;
  version?: string;
}

/**
 * Structured result schema.
 *
 * The SDK only advertises `outputSchema` when the schema's root is an *object*
 * (`normalizeObjectSchema` returns `undefined` for a root union), so the
 * success/failure envelope is expressed as one flat object with two optional
 * payloads rather than a discriminated union. The invariant `success === true ⇒
 * data present` is enforced in the handler and documented here; the JSON Schema
 * still tells clients the exact shape of a success payload, which is what the
 * planner and the Inspector need.
 */
function outputSchemaFor(op: PhotoshopOpName): z.ZodType {
  return z.object({
    success: z.boolean().describe('True when the operation succeeded.'),
    data: OPERATIONS[op].result.optional().describe('Result payload. Present only when success is true.'),
    error: StudioErrorSchema.optional().describe('Failure detail. Present only when success is false.'),
  });
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { adapter, logger } = options;
  const server = new McpServer(
    { name: 'photoshop-ai-studio', version: options.version ?? '0.1.0' },
    { capabilities: { logging: {}, tools: {} } },
  );

  for (const name of OP_NAMES) {
    const op = name;
    const def: OperationDefinition = OPERATIONS[op];

    // The registry is runtime data, so `registerTool` cannot infer a per-tool
    // input type from it. Type safety is not lost, it moves: `def.params.parse`
    // validates at runtime, `DISPATCH` is a compile-time-checked table over
    // `PhotoshopOpName`, and `def.result` validates the response below.
    server.registerTool(
      def.tool,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.params as unknown as z.ZodRawShape,
        outputSchema: outputSchemaFor(op) as unknown as z.ZodRawShape,
        annotations: {
          readOnlyHint: !def.destructive,
          destructiveHint: def.destructive,
          idempotentHint: !def.destructive,
          openWorldHint: false,
        },
        _meta: {
          'studio/category': def.category,
          'studio/destructive': def.destructive,
          'studio/requiresConfirmation': def.requiresConfirmation,
        },
      } as Parameters<typeof server.registerTool>[1],
      (async (args: unknown): Promise<CallToolResult> => {
        const startedAt = Date.now();
        const log = logger.child({ tool: def.tool });

        try {
          const parsed = validateParams(op, args);
          log.debug({ event: 'mcp.call', message: 'validated arguments', data: parsed });

          const data = await DISPATCH[op](adapter, parsed as never);

          // Validate our own output against the registry's result schema so a
          // malformed adapter response is caught here, not three layers up.
          const validated = OPERATIONS[op].result.parse(data);

          const durationMs = Date.now() - startedAt;
          log.info({ event: 'mcp.result', message: `${def.tool} ok`, durationMs, data: summarize(validated) });
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true, data: validated }) }],
            structuredContent: { success: true, data: validated },
          };
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          const error = err instanceof StudioException ? err.toStudioError() : toStudioError(err);

          // A schema violation in `args` or in the adapter's response is a
          // programming error, not a Photoshop failure — classify it so the
          // planner can retry with corrected arguments.
          if (isZodError(err)) {
            error.code = 'INVALID_PARAMS';
            error.recoverable = true;
            error.message = `${def.tool} rejected its input/output: ${error.message}`;
          }

          log.error({ event: 'mcp.result', message: `${def.tool} failed: ${error.code}`, durationMs, data: error });
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error }) }],
            structuredContent: { success: false, error } as unknown as Record<string, unknown>,
            isError: true,
          };
        }
      }) as never,
    );
  }

  return server;
}

function isZodError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'ZodError';
}

/** Keeps log payloads small: the full result is already available over MCP. */
function summarize(data: unknown): unknown {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record);
    if (Array.isArray(record.layers)) return `document "${String(record.name)}" with ${record.layers.length} layers`;
    if ('id' in record && 'name' in record) return `${String(record.name)} (#${String(record.id)})`;
    return `object{${keys.slice(0, 6).join(',')}}`;
  }
  return data;
}
