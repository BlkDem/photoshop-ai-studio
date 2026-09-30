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
import {
  coercePlanDraft,
  parseJsonLoose,
  plannerSystemPrompt,
  plannerUserPrompt,
  renderStateForPrompt,
} from './openai-compatible.js';

/**
 * Anthropic Messages API gateway.
 *
 * Separate from the OpenAI-compatible one because the wire format is genuinely
 * different (system prompt is a top-level field, `max_tokens` is required, the
 * response shape is `content[]`). Everything else — prompts, JSON coercion,
 * error taxonomy — is reused.
 */
export interface AnthropicConfig {
  role: ModelRole;
  model: string;
  apiKey: string | undefined;
  baseUrl: string;
  temperature: number;
  timeoutMs: number;
}

export class AnthropicGateway implements ModelGateway {
  readonly provider = 'anthropic';

  constructor(private readonly config: AnthropicConfig) {}

  get role(): ModelRole {
    return this.config.role;
  }

  get model(): string {
    return this.config.model;
  }

  private async completeJson(system: string, user: string): Promise<unknown> {
    if (!this.config.apiKey) {
      throw new ModelUnavailableError(
        `No API key configured for role "${this.config.role}". Set AI_${this.config.role.toUpperCase()}_API_KEY.`,
        this.provider,
        this.config.model,
      );
    }
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 2048,
          temperature: this.config.role === 'planner' ? this.config.temperature : 0,
          system,
          messages: [{ role: 'user', content: user }],
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
        `Anthropic returned ${response.status}: ${body.slice(0, 400)}`,
        this.provider,
        this.config.model,
      );
    }

    const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = payload.content?.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ModelUnavailableError('Anthropic returned an empty completion', this.provider, this.config.model);
    }
    return parseJsonLoose(text, this.provider, this.config.model);
  }

  async plan(request: PlanRequest): Promise<PlanDraft> {
    return coercePlanDraft(await this.completeJson(plannerSystemPrompt(request.tools), plannerUserPrompt(request)), request);
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
        request.plan ? `\nPlan:\n${request.plan.steps.map((s) => `- ${s.tool}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    const record = raw as Record<string, unknown>;
    const text = typeof record?.text === 'string' ? record.text.trim() : '';
    if (!text) throw new ModelUnavailableError('Model did not return a `text` field', this.provider, this.config.model);
    return { text };
  }

  async verify(request: VerifyRequest): Promise<ModelVerification> {
    const raw = (await this.completeJson(
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
        renderStateForPrompt(request.state),
      ].join('\n'),
    )) as Record<string, unknown>;

    if (typeof raw?.passed !== 'boolean' || typeof raw?.reason !== 'string') {
      throw new ModelUnavailableError('Model verification reply was malformed', this.provider, this.config.model);
    }
    return { passed: raw.passed, reason: raw.reason };
  }
}
