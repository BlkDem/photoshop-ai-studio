import * as z from 'zod/v4';

import { StudioErrorSchema } from './errors.js';
import { OPERATION_NAMES } from './photoshop/operations.js';

/**
 * MCP Server ↔ UXP Plugin bridge protocol.
 *
 * ## Why a WebSocket, and who dials whom
 *
 * The UXP runtime is **WebSocket-client only** — a plugin cannot listen on a
 * port (https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/).
 * Therefore the plugin dials out to the MCP server's bridge, which listens on
 * `PLUGIN_PORT`. That direction works on every platform, survives Photoshop
 * restarts (the plugin reconnects with backoff), and needs no inbound firewall
 * rule in Photoshop. See docs/architecture.md ADR-001.
 *
 * ## Why JSON envelopes instead of MCP over the bridge
 *
 * The plugin is plain ES5-ish JavaScript with no npm dependencies and no
 * bundler, so it cannot speak Streamable HTTP's SSE framing. The bridge
 * therefore carries a deliberately tiny request/response protocol; the MCP
 * semantics (tool names, zod input schemas, structured results, typed errors)
 * live one layer up in the MCP server, where they belong.
 *
 * ## Guarantees
 *
 *  - `v` is bumped whenever an envelope changes shape. The server rejects
 *    mismatched versions rather than guessing.
 *  - Every `op` carries a unique `id`; the plugin must echo it. Unmatched ids
 *    are logged and dropped.
 *  - `result` is always the `{ success, data | error }` envelope from
 *    `shared/errors.ts` — the plugin never invents its own error shape.
 *  - The server serialises all `op` frames. Photoshop UXP mutations must run
 *    inside a single modal scope, so overlapping operations would corrupt state.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

export const PluginHelloPayloadSchema = z.object({
  pluginId: z.string(),
  pluginVersion: z.string(),
  uxpVersion: z.string(),
  hostApp: z.string(),
  hostVersion: z.string(),
  /** Capability set the plugin reports; lets the server fail fast on old plugins. */
  protocolVersion: z.number().int(),
  supports: z.array(z.enum(OPERATION_NAMES)).optional(),
  /**
   * The plugin's own view of its configuration.
   *
   * Not used for control flow — the server logs it, which turns a
   * workspace-root mismatch between two operating systems into a one-line
   * diagnosis instead of a confusing "no workspaceRoot configured" on the
   * first export.
   */
  config: z
    .object({
      workspaceRoot: z.string().nullable(),
      outputDir: z.string().nullable(),
      /** Why the config could not be read, when that happened. */
      error: z.string().nullable().optional(),
    })
    .optional(),
});

export type PluginHelloPayload = z.infer<typeof PluginHelloPayloadSchema>;

const envelopeBase = { v: z.literal(BRIDGE_PROTOCOL_VERSION) };

// --- server → plugin -------------------------------------------------------

export const BridgeRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...envelopeBase, type: z.literal('op'), id: z.string(), op: z.enum(OPERATION_NAMES), params: z.unknown() }),
  z.object({ ...envelopeBase, type: z.literal('ping'), id: z.string() }),
  z.object({ ...envelopeBase, type: z.literal('cancel'), id: z.string(), reason: z.string().optional() }),
  z.object({ ...envelopeBase, type: z.literal('shutdown'), reason: z.string().optional() }),
]);
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>;

// --- plugin → server -------------------------------------------------------

export const BridgeSuccessSchema = z.object({ success: z.literal(true), data: z.unknown() });
export const BridgeFailureSchema = z.object({ success: z.literal(false), error: StudioErrorSchema });
export const BridgeResultSchema = z.union([BridgeSuccessSchema, BridgeFailureSchema]);
export type BridgeResult = z.infer<typeof BridgeResultSchema>;

export const PluginLogPayloadSchema = z.object({
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error']),
  message: z.string(),
  data: z.unknown().optional(),
});

export const BridgeMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...envelopeBase, type: z.literal('hello'), payload: PluginHelloPayloadSchema }),
  z.object({ ...envelopeBase, type: z.literal('op.result'), id: z.string(), result: BridgeResultSchema }),
  z.object({ ...envelopeBase, type: z.literal('log'), payload: PluginLogPayloadSchema }),
  z.object({
    ...envelopeBase,
    type: z.literal('state.changed'),
    reason: z.string(),
    documentId: z.string().optional(),
  }),
  z.object({ ...envelopeBase, type: z.literal('pong'), id: z.string(), t: z.number().optional() }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

export function encodeRequest(req: BridgeRequest): string {
  return JSON.stringify(req);
}

export function encodeMessage(msg: BridgeMessage): string {
  return JSON.stringify(msg);
}

/**
 * Tolerant parse used on the socket. Never throws — a malformed frame is
 * reported so the caller can log it and keep the connection alive.
 */
export function decodeMessage(raw: unknown):
  | { ok: true; message: BridgeMessage }
  | { ok: false; reason: string } {
  if (typeof raw !== 'string') return { ok: false, reason: 'frame is not a string' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }
  const res = BridgeMessageSchema.safeParse(parsed);
  if (!res.success) {
    return { ok: false, reason: `unexpected frame: ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  }
  if (res.data.v !== BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, reason: `protocol version mismatch: server ${BRIDGE_PROTOCOL_VERSION}, plugin ${res.data.v}` };
  }
  return { ok: true, message: res.data };
}
