import { randomUUID } from 'node:crypto';

import {
  OPERATIONS,
  StudioException,
  TOOL_META_MAP,
  mergeExpectations,
  opForTool,
  type ConfirmationRequest,
  type Expectation,
  type Plan,
  type PlanStep,
} from '@photoshop-ai-studio/shared';
import type { DraftPlanLike, ModelRef } from './plan-model.js';

/**
 * Turns a planner's draft into a formal, validated `Plan` (§14).
 *
 * The model supplies *what* and *why*; it never supplies step ids, destructive
 * flags or confirmation prompts. Those are derived here from the tool registry,
 * so a model cannot talk its way past the safety gate.
 */
export interface BuildPlanInput {
  draft: DraftPlanLike;
  model: ModelRef;
  route: Plan['route'];
  maxSteps: number;
  notes?: string[];
}

export function buildPlan(input: BuildPlanInput): Plan {
  if (input.draft.steps.length === 0) {
    throw new StudioException(
      'PLAN_INVALID',
      'The planner produced an empty plan. Ask the user to be more specific, or check the model configuration.',
    );
  }
  if (input.draft.steps.length > input.maxSteps) {
    throw new StudioException(
      'PLAN_INVALID',
      `The plan has ${input.draft.steps.length} steps, above the ${input.maxSteps} step limit.`,
    );
  }

  const steps: PlanStep[] = [];
  const confirmations: ConfirmationRequest[] = [];

  input.draft.steps.forEach((step, index) => {
    const meta = TOOL_META_MAP[step.tool];
    if (!meta) {
      throw new StudioException('UNKNOWN_TOOL', `The planner referenced an unknown tool "${step.tool}"`, {
        details: { stepId: `step-${index + 1}`, tool: step.tool },
      });
    }
    const op = meta.op;

    // Validate arguments now, before the user is asked to approve anything.
    const validated = validateToolArgs(step.tool, step.params);

    const derived = mergeExpectations((step.expect ?? []) as Expectation[], op, validated);
    const stepId = `step-${index + 1}`;
    const planStep: PlanStep = {
      id: stepId,
      tool: step.tool,
      params: validated as Record<string, unknown>,
      ...(step.intent ? { intent: step.intent } : {}),
      expect: derived,
      destructive: meta.destructive,
    };
    steps.push(planStep);

    if (meta.requiresConfirmation) {
      confirmations.push(buildConfirmation(stepId, meta.tool, meta.destructive, validated));
    }
  });

  return {
    id: randomUUID(),
    goal: input.draft.goal,
    ...(input.draft.summary ? { summary: input.draft.summary } : {}),
    steps,
    createdAt: new Date().toISOString(),
    model: input.model,
    route: input.route,
    requiresConfirmation: confirmations.length > 0,
    confirmations,
    notes: [...(input.notes ?? []), ...(input.draft.notes ?? [])],
  };
}

function validateToolArgs(tool: string, params: Record<string, unknown>): unknown {
  const meta = TOOL_META_MAP[tool];
  if (!meta) throw new StudioException('UNKNOWN_TOOL', `Unknown tool "${tool}"`);
  const op = opForTool(meta.tool);
  if (!op) throw new StudioException('UNKNOWN_TOOL', `Tool "${tool}" has no registered operation`);
  const schema = OPERATIONS[op].params;
  const result = schema.safeParse(params ?? {});
  if (!result.success) {
    throw new StudioException(
      'INVALID_PARAMS',
      `Step arguments for ${tool} are invalid: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
      { details: { tool, issues: result.error.issues } },
    );
  }
  return result.data;
}

/**
 * Human-readable confirmation question. This is the last line of defence shown
 * to the user, so it names the concrete thing that will happen rather than the
 * tool that will run.
 */
function buildConfirmation(
  stepId: string,
  tool: string,
  destructive: boolean,
  params: unknown,
): ConfirmationRequest {
  const p = (params ?? {}) as Record<string, unknown>;
  const target =
    typeof p.layerName === 'string'
      ? `"${p.layerName}"`
      : typeof p.layerId === 'number'
        ? `layer #${p.layerId}`
        : null;

  switch (tool) {
    case 'photoshop.delete_layer':
      return { stepId, tool, question: `Delete ${target ? `layer ${target}` : 'this layer'}? This cannot be undone from here.`, risk: 'high' };
    case 'photoshop.crop_document':
      return { stepId, tool, question: `Crop the canvas to ${p.width}×${p.height} at (${p.x}, ${p.y})? Pixels outside are discarded.`, risk: 'high' };
    case 'photoshop.save_document':
      return {
        stepId,
        tool,
        question: p.path ? `Save the document to ${p.path}?` : 'Save the document, overwriting the current file?',
        risk: p.path ? 'medium' : 'high',
      };
    case 'photoshop.save_psd':
      return { stepId, tool, question: `Save a .psd to ${p.path ?? 'the default output path'}?`, risk: 'medium' };
    case 'photoshop.export_png':
      return { stepId, tool, question: `Export a PNG to ${p.path ?? 'the default output path'}?`, risk: 'medium' };
    case 'photoshop.export_jpg':
      return { stepId, tool, question: `Export a JPEG to ${p.path ?? 'the default output path'}?`, risk: 'medium' };
    case 'photoshop.export_document':
      return { stepId, tool, question: `Export the document to ${p.path ?? 'the default output path'}?`, risk: 'medium' };
    default:
      return {
        stepId,
        tool,
        question: `Run ${tool}? This operation is ${destructive ? 'destructive' : 'sensitive'}.`,
        risk: destructive ? 'high' : 'medium',
      };
  }
}
