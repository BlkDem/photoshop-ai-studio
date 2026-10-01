import * as z from 'zod/v4';

import { DocumentDiffSchema, VerificationResultSchema } from './photoshop/diff.js';
import { DocumentSnapshotSchema } from './photoshop/snapshot.js';
import { TOOL_META, TOOL_META_MAP, ToolMetaSchema } from './photoshop/operations.js';
import { ConfirmationRequestSchema, ExecutedStepSchema, PlanSchema, RunSchema } from './plan.js';
import { HistoryRecordSchema } from './history.js';
import { LogEntrySchema } from './logging.js';
import { AdapterConnectionSchema } from './photoshop/adapter.js';
import { StudioErrorSchema } from './errors.js';

/**
 * Studio ↔ Orchestrator contract.
 *
 * Deliberately a small REST + event-stream surface: the browser never speaks
 * MCP, never sees the model provider, and never holds a credential.
 */

// --- tool metadata ---------------------------------------------------------

export { ToolMetaSchema };
export type { ToolMeta } from './photoshop/operations.js';

// --- chat ------------------------------------------------------------------

export const CHAT_MESSAGE_KINDS = ['text', 'plan', 'confirmation', 'result', 'error'] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

export const ChatMessageSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  role: z.enum(['user', 'assistant']),
  kind: z.enum(CHAT_MESSAGE_KINDS),
  content: z.string(),
  plan: PlanSchema.nullable().optional(),
  verification: VerificationResultSchema.nullable().optional(),
  diff: DocumentDiffSchema.nullable().optional(),
  confirmations: z.array(ConfirmationRequestSchema).optional(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().min(1).default('default'),
  message: z.string().min(1).max(4000),
  /** Document the request refers to; defaults to Photoshop's active document. */
  documentId: z.string().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// --- runs ------------------------------------------------------------------

export const ApproveRunRequestSchema = z.object({
  /**
   * Per-step answers for destructive steps. The Studio always sends explicit
   * decisions; omitting the field means "approve the whole plan".
   */
  confirmations: z
    .array(z.object({ stepId: z.string(), approved: z.boolean() }))
    .optional(),
});
export type ApproveRunRequest = z.infer<typeof ApproveRunRequestSchema>;

export const RunDetailSchema = z.object({
  run: RunSchema,
  verification: VerificationResultSchema.nullable(),
  diff: DocumentDiffSchema.nullable(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

// --- state / status --------------------------------------------------------

export const ModelRolesSchema = z.object({
  planner: z.object({ provider: z.string(), model: z.string() }),
  vision: z.object({ provider: z.string(), model: z.string() }),
  fast: z.object({ provider: z.string(), model: z.string() }),
});
export type ModelRoles = z.infer<typeof ModelRolesSchema>;

// --- model registry ---------------------------------------------------------

/**
 * One configured LLM the Studio can route a role to.
 *
 * A profile rather than a bare provider/model pair, because the interesting
 * differences are per-model: a reasoning model needs a larger token ceiling than
 * a cheap one, and the same vendor id may be reached through a gateway. The
 * browser is told `hasApiKey` and never the key — the Studio configures models,
 * it does not hold their credentials.
 */
export const ModelProviderIdSchema = z.enum(['openai', 'openai-compatible', 'anthropic', 'mock']);
export type ModelProviderId = z.infer<typeof ModelProviderIdSchema>;

export const ModelProfileSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  provider: ModelProviderIdSchema,
  model: z.string().min(1),
  baseUrl: z.string().nullable(),
  /** Present but never serialised: the browser must not receive a credential. */
  hasApiKey: z.boolean(),
  maxTokens: z.number().int().positive().nullable(),
  /** Where the profile came from, so a seeded one can be traced back to its variable. */
  origin: z.enum(['env', 'studio']).default('studio'),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** What the Studio POSTs when adding or editing a profile. */
export const ModelProfileInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  provider: ModelProviderIdSchema,
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ModelProfileInput = z.infer<typeof ModelProfileInputSchema>;

export const MODEL_ROLES = ['planner', 'vision', 'fast'] as const;
export type ModelRoleId = (typeof MODEL_ROLES)[number];

export const ModelRegistrySchema = z.object({
  profiles: z.array(ModelProfileSchema),
  /** Role → profile id. A null role means the offline deterministic engine. */
  roles: z.object({
    planner: z.string().nullable(),
    vision: z.string().nullable(),
    fast: z.string().nullable(),
  }),
});
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

export const AssignRoleRequestSchema = z.object({
  role: z.enum(MODEL_ROLES),
  /** null sends the role back to the built-in deterministic engine. */
  profileId: z.string().nullable(),
});
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

/** Outcome of a connectivity check against a configured model. */
export const ModelProbeSchema = z.object({
  ok: z.boolean(),
  /** Never contains a key. */
  detail: z.string(),
  latencyMs: z.number().int().nonnegative().nullable(),
});
export type ModelProbe = z.infer<typeof ModelProbeSchema>;

export const StudioStateSchema = z.object({
  connection: AdapterConnectionSchema,
  snapshot: DocumentSnapshotSchema.nullable(),
  /** Tool names the MCP server actually advertises right now. */
  tools: z.array(ToolMetaSchema),
  model: ModelRolesSchema,
  jev: z.object({
    mode: z.enum(['deterministic', 'remote', 'disabled']),
    runtimeUrl: z.string().nullable(),
  }),
  running: z.boolean(),
});
export type StudioState = z.infer<typeof StudioStateSchema>;

export const StatusResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  connection: AdapterConnectionSchema,
  running: z.boolean(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export const HistoryResponseSchema = z.object({
  records: z.array(HistoryRecordSchema),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

export const ToolsResponseSchema = z.object({
  tools: z.array(ToolMetaSchema),
  mcp: z.object({
    connected: z.boolean(),
    url: z.string(),
    toolCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }),
});
export type ToolsResponse = z.infer<typeof ToolsResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export { StudioErrorSchema };

// --- event stream ----------------------------------------------------------
//
// NDJSON over a long-lived GET (one JSON object per line). Chosen over SSE
// because it needs no framing negotiation, proxies cleanly, and is trivial to
// consume from `fetch` + `ReadableStream` in the browser.

export const StudioEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string() }),
  z.object({ type: z.literal('log'), entry: LogEntrySchema }),
  z.object({ type: z.literal('run'), run: RunSchema }),
  z.object({ type: z.literal('step'), runId: z.string(), step: ExecutedStepSchema }),
  z.object({ type: z.literal('connection'), connection: AdapterConnectionSchema }),
  z.object({ type: z.literal('verification'), runId: z.string(), verification: VerificationResultSchema }),
  z.object({ type: z.literal('diff'), runId: z.string(), diff: DocumentDiffSchema }),
  z.object({ type: z.literal('history'), record: HistoryRecordSchema }),
]);
export type StudioEvent = z.infer<typeof StudioEventSchema>;

/** Convenience re-export so the Studio can render tools without importing internals. */
export { TOOL_META, TOOL_META_MAP };
