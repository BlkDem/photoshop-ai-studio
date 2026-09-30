import type { DocumentSnapshot, ToolMeta } from '@photoshop-ai-studio/shared';
import {
  ModelUnavailableError,
  SYSTEM_PREAMBLE,
  type AnalyzeRequest,
  type AnalyzeResponse,
  type ModelGateway,
  type ModelRole,
  type ModelVerification,
  type PlanDraft,
  type PlanRequest,
  type VerifyRequest,
} from './types.js';

/**
 * OpenAI-compatible chat-completions gateway.
 *
 * One implementation covers OpenAI, Groq, OpenRouter, Together, LM Studio,
 * vLLM and Ollama's `/v1` surface — they all speak the same wire format. That
 * keeps the vendor list in configuration rather than in code.
 *
 * No SDK: Node 22 has `fetch`, and a dependency would only add surface area.
 */
export interface OpenAiCompatibleConfig {
  role: ModelRole;
  model: string;
  apiKey: string | undefined;
  baseUrl: string;
  temperature: number;
  timeoutMs: number;
  logger: { warn(input: { event: string; message: string; data?: unknown }): void };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAiCompatibleGateway implements ModelGateway {
  readonly provider = 'openai-compatible';

  constructor(private readonly config: OpenAiCompatibleConfig) {}

  get role(): ModelRole {
    return this.config.role;
  }

  get model(): string {
    return this.config.model;
  }

  private async complete(system: string, user: string): Promise<string> {
    if (!this.config.apiKey) {
      throw new ModelUnavailableError(
        `No API key configured for role "${this.config.role}". Set AI_${this.config.role.toUpperCase()}_API_KEY.`,
        this.provider,
        this.config.model,
      );
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: this.config.role === 'planner' ? this.config.temperature : 0,
          messages,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      throw new ModelUnavailableError(
        `Request to ${this.config.baseUrl} failed: ${(err as Error).message}`,
        this.provider,
        this.config.model,
        { cause: err },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ModelUnavailableError(
        `Model returned ${response.status}: ${body.slice(0, 400)}`,
        this.provider,
        this.config.model,
      );
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ModelUnavailableError('Model returned an empty completion', this.provider, this.config.model);
    }
    return content;
  }

  private async completeJson(system: string, user: string): Promise<unknown> {
    const raw = await this.complete(system, user);
    return parseJsonLoose(raw, this.provider, this.config.model);
  }

  async plan(request: PlanRequest): Promise<PlanDraft> {
    const raw = await this.completeJson(plannerSystemPrompt(request.tools), plannerUserPrompt(request));
    return coercePlanDraft(raw, request);
  }

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    const raw = await this.completeJson(
      [
        SYSTEM_PREAMBLE,
        '',
        'Answer the user in at most two short sentences. Explain what you are about to do, or what the result is.',
        'Reply with JSON: {"text": "..."}',
      ].join('\n'),
      [
        `User request: ${request.userRequest}`,
        '',
        'Document state:',
        renderStateForPrompt(request.state),
        request.diffText ? `\nResulting diff:\n${request.diffText}` : '',
        request.plan ? `\nPlan:\n${renderPlan(request.plan)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    const text = readString(raw, 'text');
    if (!text) throw new ModelUnavailableError('Model did not return a `text` field', this.provider, this.config.model);
    return { text };
  }

  async verify(request: VerifyRequest): Promise<ModelVerification> {
    const raw = await this.completeJson(
      [
        SYSTEM_PREAMBLE,
        '',
        'You verify whether a completed edit achieved the user\'s goal.',
        'Deterministic state checks have already run and are authoritative for the facts they cover.',
        'Judge only what those checks cannot: intent, composition, whether the design still makes sense.',
        'Reply with JSON: {"passed": true|false, "reason": "one sentence"}',
      ].join('\n'),
      [
        `User request: ${request.userRequest}`,
        `Goal: ${request.goal}`,
        '',
        'Deterministic checks:',
        `${request.deterministic.summary} (passed=${request.deterministic.passed}, failed=${request.deterministic.failedCount})`,
        '',
        `Document diff:\n${request.diffText || '(no changes)'}`,
        '',
        'Current document state:',
        renderStateForPrompt(request.state),
      ].join('\n'),
    );
    const passed = readBoolean(raw, 'passed');
    const reason = readString(raw, 'reason');
    if (passed === null || !reason) {
      throw new ModelUnavailableError('Model verification reply was malformed', this.provider, this.config.model);
    }
    return { passed, reason };
  }
}

// ---------------------------------------------------------------------------
// prompt construction (shared by the anthropic gateway too)
// ---------------------------------------------------------------------------

export function plannerSystemPrompt(tools: readonly ToolMeta[]): string {
  const catalogue = tools
    .map((t) => {
      const flags = [t.destructive ? 'DESTRUCTIVE' : null, t.requiresConfirmation ? 'needs-confirmation' : null]
        .filter(Boolean)
        .join(', ');
      return `- ${t.tool}${flags ? ` [${flags}]` : ''}: ${t.description}`;
    })
    .join('\n');

  return [
    SYSTEM_PREAMBLE,
    '',
    'Available Photoshop tools:',
    catalogue,
    '',
    'Reply with JSON only, no prose and no markdown fences, in exactly this shape:',
    '{',
    '  "goal": "<one-line restatement of the user intent>",',
    '  "summary": "<optional one-line summary>",',
    '  "steps": [',
    '    {',
    '      "tool": "photoshop.get_document_info",',
    '      "params": {},',
    '      "intent": "<why this step>",',
    '      "expect": [ { "kind": "document_property", "property": "width", "equals": 1080, "tolerance": 1 } ]',
    '    }',
    '  ],',
    '  "notes": ["<assumption or limitation, optional>"]',
    '}',
    '',
    'Step rules:',
    '- Steps run in order; each one sees the result of the previous.',
    '- Do not include `photoshop.get_document` / `get_layers` as steps: the orchestrator already fetched the state.',
    '- `expect` entries are checked against a fresh snapshot after the plan finishes. Use kinds:',
    '  layer_exists | layer_absent | layer_property | document_property | layer_count | file_exists | custom.',
    '- `photoshop.duplicate_document` must come first when you are deriving a variant of the current document.',
].join('\n');
}

export function plannerUserPrompt(request: PlanRequest): string {
  return [
    `User request: ${request.userRequest}`,
    '',
    'Current Photoshop document state (this is ground truth):',
    renderStateForPrompt(request.state),
    request.completedTools?.length ? `\nAlready completed, do not repeat: ${request.completedTools.join(', ')}` : '',
    request.repairHint ? `\nA previous attempt failed and must be repaired. Repair hint: ${request.repairHint}` : '',
    request.previousErrors?.length
      ? `\nPrevious errors:\n${request.previousErrors.map((e) => `- ${e.code}: ${e.message}`).join('\n')}`
      : '',
    '',
    'Produce the plan as JSON.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderStateForPrompt(state: DocumentSnapshot | null): string {
  if (!state) return '(no document is currently open in Photoshop)';
  const doc = state.document;
  const lines = [
    `document "${doc.name}" id=${doc.id} ${doc.width}×${doc.height} @${doc.resolution}ppi ${doc.colorMode}`,
    `layers (bottom → top, ${state.layers.length}):`,
  ];
  const byId = new Map(state.layers.map((l) => [l.id, l]));
  for (const layer of state.layers) {
    const depth = depthOf(layer.id, byId);
    const indent = '  '.repeat(depth + 1);
    lines.push(
      `${indent}- id=${layer.id} "${layer.name}" type=${layer.type} visible=${layer.visible} opacity=${layer.opacity} ` +
        `x=${layer.x} y=${layer.y} w=${layer.width} h=${layer.height}${layer.parentId !== null ? ` parent=${layer.parentId}` : ''}`,
    );
  }
  return lines.join('\n');
}

function depthOf(id: number, byId: Map<number, { parentId: number | null }>): number {
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<number>([id]);
  while (current?.parentId != null) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    depth += 1;
    current = byId.get(current.parentId);
  }
  return depth;
}

function renderPlan(plan: PlanDraft): string {
  return plan.steps
    .map((s, i) => `${i + 1}. ${s.tool} ${JSON.stringify(s.params)}${s.intent ? ` — ${s.intent}` : ''}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// tolerant parsing: models wrap JSON in prose and fences far more often than
// they should, and a hard failure here would lose an otherwise good plan.
// ---------------------------------------------------------------------------

export function parseJsonLoose(raw: string, provider: string, model: string): unknown {
  const attempt = (text: string): unknown | undefined => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const direct = attempt(raw.trim());
  if (direct !== undefined) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = attempt(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const parsed = attempt(raw.slice(firstBrace, lastBrace + 1));
    if (parsed !== undefined) return parsed;
  }

  throw new ModelUnavailableError(
    `Could not parse JSON from ${provider}/${model} response: ${raw.slice(0, 200)}`,
    provider,
    model,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(source: unknown, key: string): string | null {
  const record = asRecord(source);
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readBoolean(source: unknown, key: string): boolean | null {
  const record = asRecord(source);
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

function readStringArray(source: unknown, key: string): string[] {
  const record = asRecord(source);
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Turns whatever the model returned into a `PlanDraft`, dropping unusable steps. */
export function coercePlanDraft(raw: unknown, request: PlanRequest): PlanDraft {
  const record = asRecord(raw);
  if (!record) {
    throw new ModelUnavailableError('Plan response was not a JSON object', 'unknown', 'unknown');
  }

  const knownTools = new Set(request.tools.map((t) => t.tool));
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps = rawSteps.flatMap((entry, index) => {
    const step = asRecord(entry);
    if (!step) return [];
    const tool = typeof step.tool === 'string' ? step.tool : '';
    if (!tool || !knownTools.has(tool)) return [];
    const params = asRecord(step.params) ?? {};
    return [
      {
        tool,
        params,
        ...(typeof step.intent === 'string' && step.intent.trim() !== '' ? { intent: step.intent.trim() } : {}),
        ...(Array.isArray(step.expect) ? { expect: step.expect as PlanDraft['steps'][number]['expect'] } : {}),
        // `index` is intentionally unused; ids are assigned by the orchestrator.
      },
    ].filter((s): s is NonNullable<typeof s> => s !== undefined && index >= 0);
  });

  return {
    goal: typeof record.goal === 'string' && record.goal.trim() !== '' ? record.goal.trim() : request.userRequest,
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    steps,
    notes: readStringArray(record, 'notes'),
  };
}
