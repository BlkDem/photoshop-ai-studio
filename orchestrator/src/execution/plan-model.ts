import type { ModelRef as SharedModelRef } from '@photoshop-ai-studio/shared';
import type { DraftStep, PlanDraft } from '../gateway/types.js';

/**
 * The shape a planner must produce, independent of which gateway produced it.
 *
 * Kept in its own module so `shared` never has to know about the Orchestrator's
 * gateway types, and `shared/plan.ts` can validate a draft without importing the
 * gateway layer.
 */
export interface DraftPlanLike {
  goal: string;
  summary?: string;
  steps: DraftStep[];
  notes?: string[];
}

export type ModelRef = SharedModelRef;

/** Compile-time guarantee that a `PlanDraft` satisfies `DraftPlanLike`. */
export type DraftPlanCheck = PlanDraft extends DraftPlanLike ? true : never;
const _draftPlanCheck: DraftPlanCheck = true;
void _draftPlanCheck;
