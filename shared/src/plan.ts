import * as z from 'zod/v4';

import { StudioErrorSchema } from './errors.js';
import { ExpectationSchema } from './photoshop/diff.js';
import { TOOL_NAME_LIST } from './photoshop/operations.js';
import type { LayerSelector } from './photoshop/layer.js';

/**
 * The formal Plan object (§14).
 *
 * A plan is data, never code. The Orchestrator validates it, Studio renders it,
 * the user approves it, the executor walks it, and the VerificationEngine checks
 * the declared expectations against a fresh snapshot. An LLM never gets to skip
 * a stage.
 */
export const PlanStepSchema = z.object({
  id: z.string().min(1).describe('Unique within the plan, e.g. "step-1".'),
  tool: z.enum(TOOL_NAME_LIST as [string, ...string[]]).describe('Exact MCP tool name.'),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Why this step exists. Shown to the user in the plan view. */
  intent: z.string().optional(),
  /** Declarative post-conditions checked against a fresh snapshot. */
  expect: z.array(ExpectationSchema).default([]),
  /** Copied from the tool registry; surfaced to the user for approval. */
  destructive: z.boolean().default(false),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ModelRefSchema = z.object({
  role: z.enum(['planner', 'vision', 'fast', 'jev', 'rule']),
  provider: z.string(),
  model: z.string(),
});

export type ModelRef = z.infer<typeof ModelRefSchema>;

export const ConfirmationRequestSchema = z.object({
  stepId: z.string(),
  tool: z.string(),
  /** Human-readable question, e.g. `Delete layer "Background"?`. */
  question: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;

export const PlanSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  summary: z.string().optional(),
  steps: z.array(PlanStepSchema),
  createdAt: z.string(),
  model: ModelRefSchema,
  /** How the plan was produced. */
  route: z.enum(['jev-fast-path', 'llm', 'rule']),
  requiresConfirmation: z.boolean().default(false),
  confirmations: z.array(ConfirmationRequestSchema).default([]),
  /** Free-form note from the planner about assumptions it had to make. */
  notes: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanValidationIssueSchema = z.object({
  stepId: z.string().nullable(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});
export type PlanValidationIssue = z.infer<typeof PlanValidationIssueSchema>;

/** Plan lifecycle as seen by the Studio UI. */
export const RUN_STATUSES = [
  'planning',
  'awaiting_approval',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'repairing',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RunStatusSchema = z.enum(RUN_STATUSES);

export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'rejected'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const StepStatusSchema = z.enum(STEP_STATUSES);

export const ExecutedStepSchema = z.object({
  stepId: z.string(),
  tool: z.string(),
  params: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
  status: z.enum(STEP_STATUSES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Raw structured result from the MCP tool. */
  result: z.unknown().optional(),
  error: StudioErrorSchema.optional(),
  /** True when produced by the repair loop rather than the original plan. */
  isRepair: z.boolean().default(false),
});
export type ExecutedStep = z.infer<typeof ExecutedStepSchema>;

/** One shot at satisfying the goal: plan → execute → verify → repair. */
export const RunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  status: RunStatusSchema,
  goal: z.string(),
  userRequest: z.string(),
  route: z.enum(['jev-fast-path', 'llm', 'rule']).nullable(),
  plan: PlanSchema.nullable(),
  executedSteps: z.array(ExecutedStepSchema),
  repairAttempts: z.number().int().nonnegative().default(0),
  requiresConfirmation: z.boolean().default(false),
  confirmations: z.array(ConfirmationRequestSchema).default([]),
  error: StudioErrorSchema.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/** Safety prompt shown before a destructive plan step runs (§22). */
export const ConfirmationDecisionSchema = z.object({
  stepId: z.string(),
  approved: z.boolean(),
});

export type ConfirmationDecision = z.infer<typeof ConfirmationDecisionSchema>;

/** Helper: does this plan contain anything the user must confirm? */
export function planRequiresConfirmation(steps: readonly PlanStep[]): boolean {
  return steps.some((s) => s.destructive);
}

/** Compacts a plan for display in the chat transcript. */
export function summarizePlan(plan: Plan): string {
  const lines = [`PLAN — ${plan.goal}`, ''];
  plan.steps.forEach((step, index) => {
    const marker = step.destructive ? '!' : ' ';
    lines.push(`${marker} ${index + 1}. ${step.tool}${step.intent ? ` — ${step.intent}` : ''}`);
  });
  return lines.join('\n');
}

/** Best-effort description of which layers a plan touches, for confirmation dialogs. */
export function layersMentionedInPlan(steps: readonly PlanStep[]): LayerSelector[] {
  const out: LayerSelector[] = [];
  for (const step of steps) {
    for (const key of ['layer', 'group'] as const) {
      const value = step.params[key];
      if (value && typeof value === 'object') {
        const sel = value as LayerSelector;
        if (sel.layerId !== undefined || sel.layerName !== undefined) out.push(sel);
      }
    }
  }
  return out;
}
