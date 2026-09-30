import type { DocumentSnapshot, Expectation, StudioError, ToolMeta } from '@photoshop-ai-studio/shared';

/**
 * The Model Gateway boundary (§15).
 *
 * The Orchestrator never imports a vendor SDK. It talks to this interface, the
 * interface is configured from the environment, and adding a provider means
 * adding one file here plus one `case` in `createGateway`.
 */

export type ModelRole = 'planner' | 'vision' | 'fast';

/** One step as produced by a planner — no ids, no destructive flags. */
export interface DraftStep {
  tool: string;
  params: Record<string, unknown>;
  intent?: string;
  expect?: Expectation[];
}

export interface PlanDraft {
  goal: string;
  summary?: string;
  steps: DraftStep[];
  notes?: string[];
}

export interface PlanRequest {
  /** The user's words, verbatim. */
  userRequest: string;
  /** Current Photoshop state. The planner is expected to ground itself in this. */
  state: DocumentSnapshot | null;
  /** Tools this build actually exposes (from the MCP server). */
  tools: readonly ToolMeta[];
  /** Free-form guidance: a previous failure being repaired, or an extra hint. */
  repairHint?: string;
  /** Structured failures from the attempt being repaired, if any. */
  previousErrors?: StudioError[];
  /** Steps that already succeeded, so a repair does not repeat them. */
  completedTools?: string[];
}

export interface AnalyzeRequest {
  userRequest: string;
  state: DocumentSnapshot | null;
  /** Draft of what is about to happen / did happen. */
  plan?: PlanDraft;
  diffText?: string;
}

export interface AnalyzeResponse {
  /** One or two sentences for the chat bubble. */
  text: string;
}

export interface VerifyRequest {
  userRequest: string;
  goal: string;
  state: DocumentSnapshot | null;
  diffText: string;
  /** Deterministic checks that already ran; the model reviews them + the diff. */
  deterministic: {
    passed: boolean;
    failedCount: number;
    summary: string;
  };
}

export interface ModelVerification {
  passed: boolean;
  /** Short explanation shown in the verification panel. */
  reason: string;
}

export interface ModelGateway {
  readonly role: ModelRole;
  readonly provider: string;
  readonly model: string;
  /** Cheap natural-language reply (chat bubbles). */
  analyze(request: AnalyzeRequest): Promise<AnalyzeResponse>;
  /** Turn a user request + state into a plan draft. */
  plan(request: PlanRequest): Promise<PlanDraft>;
  /** Judge the outcome of a plan. Deterministic checks remain authoritative. */
  verify(request: VerifyRequest): Promise<ModelVerification>;
}

export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelUnavailableError';
  }
}

/** Shared system-prompt preamble. Kept provider-agnostic. */
export const SYSTEM_PREAMBLE = [
  'You are the planning core of Photoshop AI Studio, an AI assistant that edits Adobe Photoshop documents.',
  'You never talk to Photoshop directly: you emit a JSON plan, a human approves it, a tool layer executes it,',
  'and the resulting document state is verified against the plan.',
  '',
  'Rules you must follow:',
  '1. Ground every decision in the supplied document state. Never invent layer ids or names.',
  '2. Prefer `layerId` over `layerName` when the state gives you an id.',
  '3. Keep the plan minimal. Do not add steps the user did not ask for.',
  '4. Never emit `photoshop.delete_layer`, `crop_document` or any export/save unless the user asked for it.',
  '5. If the request cannot be satisfied with the available tools, return an empty `steps` array and say so in `notes`.',
  '6. Coordinates are absolute document pixels with the origin at the canvas top-left.',
].join('\n');
