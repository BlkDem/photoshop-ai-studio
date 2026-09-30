/**
 * `@photoshop-ai-studio/shared`
 *
 * The one place every component agrees on. Nothing here imports a runtime
 * dependency other than zod, and nothing here knows about transports, HTTP
 * servers, or UXP — it is pure contracts + pure functions.
 *
 * Layout:
 *   errors.ts            error taxonomy shared by all processes
 *   bridge.ts            MCP server <-> UXP plugin protocol
 *   plan.ts              Plan / Run / confirmation objects (§14, §22)
 *   history.ts           HistoryRecord (§21)
 *   logging.ts           structured log records (§25)
 *   api.ts               Studio <-> Orchestrator REST/stream contract
 *   photoshop/*.ts       normalised document model, adapter contract,
 *                        snapshot, diff, verification vocabulary
 */

export * from './errors.js';
export * from './bridge.js';
export * from './plan.js';
export * from './history.js';
export * from './logging.js';
export * from './api.js';

export * from './photoshop/document.js';
export * from './photoshop/layer.js';
export * from './photoshop/text.js';
export * from './photoshop/operations.js';
export * from './photoshop/adapter.js';
export * from './photoshop/snapshot.js';
export * from './photoshop/diff.js';
export * from './photoshop/validation.js';
export * from './photoshop/expectations.js';

export const SHARED_VERSION = '0.1.0';

/**
 * Node-only helpers (env loading, structured logger). Kept out of the barrel so
 * the browser bundle never pulls in `node:fs`.
 *
 *   import { OPERATIONS } from '@photoshop-ai-studio/shared';
 *   import { createLogger } from '@photoshop-ai-studio/shared/node';
 */
export const NODE_ONLY = 'Use "@photoshop-ai-studio/shared/node" instead.' as const;
