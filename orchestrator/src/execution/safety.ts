import { TOOL_META_MAP, type ConfirmationRequest, type ExecutedStep, type Plan, type PlanStep } from '@photoshop-ai-studio/shared';

/**
 * Safety gate (§22).
 *
 * The rule is blunt: **nothing destructive runs without the user saying yes to
 * that specific step**. The gate is evaluated at execution time, not at plan
 * time, because a plan can be edited between approval and execution and the
 * decisions must be re-checked against what is actually about to run.
 */
export interface SafetyDecision {
  allowed: boolean;
  /** Steps that need a decision and do not have one yet. */
  pending: ConfirmationRequest[];
  /** Steps the user explicitly refused; the executor skips these. */
  rejected: string[];
}

export interface ApprovalInput {
  plan: Plan;
  /** stepId → approved. Absent means "not decided". */
  decisions: ReadonlyMap<string, boolean>;
  /** Treat "no decision supplied" as approval. Only for API/automation callers. */
  autoApprove?: boolean;
}

export function evaluateSafety(input: ApprovalInput): SafetyDecision {
  const pending: ConfirmationRequest[] = [];
  const rejected: string[] = [];
  let allowed = true;

  for (const step of input.plan.steps) {
    if (!requiresDecision(step, input.plan)) {
      continue;
    }
    const decision = input.decisions.get(step.id);
    if (decision === true) continue;
    if (decision === false) {
      rejected.push(step.id);
      allowed = false;
      continue;
    }
    if (input.autoApprove) continue;
    allowed = false;
    const prompt = input.plan.confirmations.find((c) => c.stepId === step.id);
    pending.push(prompt ?? fallbackPrompt(step));
  }

  return { allowed, pending, rejected };
}

function requiresDecision(step: PlanStep, plan: Plan): boolean {
  // Trust the tool registry over the plan's own flag: if the tool is marked as
  // confirmation-worthy anywhere, it is confirmation-worthy here.
  const meta = TOOL_META_MAP[step.tool];
  return meta?.requiresConfirmation === true || plan.confirmations.some((c) => c.stepId === step.id);
}

function fallbackPrompt(step: PlanStep): ConfirmationRequest {
  return {
    stepId: step.id,
    tool: step.tool,
    question: `Run ${step.tool}?${step.intent ? ` ${step.intent}` : ''}`.trim(),
    risk: 'high',
  };
}

/**
 * Applies the user's per-step decisions.
 *
 * A rejected step is *skipped*, not fatal: if a plan is
 * `rename → delete Background → export` and the user refuses the delete, the
 * export should still happen. Aborting the whole run would make the gate
 * punitive and users would learn to approve blindly.
 */
export function applyDecisions(plan: Plan, decisions: ReadonlyMap<string, boolean>): {
  runnable: PlanStep[];
  skipped: string[];
} {
  const runnable: PlanStep[] = [];
  const skipped: string[] = [];
  for (const step of plan.steps) {
    if (decisions.get(step.id) === false) {
      skipped.push(step.id);
      continue;
    }
    runnable.push(step);
  }
  return { runnable, skipped };
}

/** Skipped steps are recorded in history as `rejected`, never as `succeeded`. */
export function skippedStepRecord(step: PlanStep): ExecutedStep {
  const now = new Date().toISOString();
  return {
    stepId: step.id,
    tool: step.tool,
    params: step.params,
    ...(step.intent ? { intent: step.intent } : {}),
    status: 'rejected',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    isRepair: false,
  };
}
