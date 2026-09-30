import * as z from 'zod/v4';

import { StudioErrorSchema } from './errors.js';
import { DocumentDiffSchema, VerificationResultSchema } from './photoshop/diff.js';
import { PlanSchema } from './plan.js';

/**
 * History (§21). One record per AI operation, persisted as JSONL so a run
 * survives a restart and can be replayed or audited.
 */
export const HistoryRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),

  /** What the user typed. */
  userRequest: z.string(),
  /** Normalised goal extracted by the planner. */
  goal: z.string(),
  plan: PlanSchema.nullable(),

  /** Flat list of `tool` names in execution order — the "tools executed" column. */
  toolsExecuted: z.array(z.string()),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'partially_applied']),
  verification: VerificationResultSchema.nullable(),
  diff: DocumentDiffSchema.nullable(),
  errors: z.array(StudioErrorSchema),
  repairAttempts: z.number().int().nonnegative(),
  route: z.enum(['jev-fast-path', 'llm', 'rule']).nullable(),
});
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

export const HISTORY_LIMIT = 200;
