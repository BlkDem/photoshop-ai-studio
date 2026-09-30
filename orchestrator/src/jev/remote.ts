import type { PlanDraft } from '../gateway/types.js';
import type { JevDecision, JevInput, JevMode, JevRouter } from './types.js';

/**
 * Remote JEV runtime adapter.
 *
 * Wire format (deliberately trivial so a runtime in any language can serve it):
 *
 *   POST $JEV_RUNTIME_URL
 *   { "text": "...", "state": { document, layers } }
 *   → 200 { "decision": "fast", "confidence": 0.93, "rule": "rename",
 *           "draft": { "goal": "...", "steps": [{ "tool": "...", "params": {} }] } }
 *   → 200 { "decision": "llm", "reason": "unsupported phrasing" }
 *
 * A transport error, a non-2xx status, a malformed body or a low confidence all
 * resolve to `{ kind: 'llm' }`. The fast path is an optimisation; it must never
 * be a new way for the system to fail.
 */
export interface RemoteJevOptions {
  url: string;
  apiKey: string | undefined;
  minConfidence: number;
  timeoutMs: number;
  logger: { warn(input: { event: string; message: string; data?: unknown }): void; info(input: { event: string; message: string; data?: unknown }): void };
}

export class RemoteJevRouter implements JevRouter {
  readonly mode: JevMode = 'remote';
  readonly runtimeUrl: string;

  constructor(private readonly options: RemoteJevOptions) {
    this.runtimeUrl = options.url;
  }

  async route(input: JevInput): Promise<JevDecision> {
    let response: Response;
    try {
      response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({ text: input.text, state: input.state }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      this.options.logger.warn({
        event: 'jev.route',
        message: `JEV runtime unreachable, falling back to the model: ${(err as Error).message}`,
      });
      return { kind: 'llm', reason: `JEV runtime unreachable: ${(err as Error).message}` };
    }

    if (!response.ok) {
      this.options.logger.warn({ event: 'jev.route', message: `JEV runtime returned ${response.status}` });
      return { kind: 'llm', reason: `JEV runtime returned ${response.status}` };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      this.options.logger.warn({ event: 'jev.route', message: `JEV runtime sent invalid JSON: ${(err as Error).message}` });
      return { kind: 'llm', reason: 'JEV runtime sent invalid JSON' };
    }

    const record = asRecord(payload);
    if (!record) return { kind: 'llm', reason: 'JEV runtime reply was not an object' };

    const decision = typeof record.decision === 'string' ? record.decision.toLowerCase() : '';
    if (decision !== 'fast') {
      return { kind: 'llm', reason: typeof record.reason === 'string' ? record.reason : 'JEV deferred to the model' };
    }

    const confidence = typeof record.confidence === 'number' ? record.confidence : 0;
    const draft = coerceDraft(record.draft);
    if (!draft || draft.steps.length === 0) {
      return { kind: 'llm', reason: 'JEV fast path returned an unusable draft' };
    }
    if (confidence < this.options.minConfidence) {
      return { kind: 'llm', reason: `JEV confidence ${confidence.toFixed(2)} below threshold ${this.options.minConfidence}` };
    }

    this.options.logger.info({
      event: 'jev.route',
      message: `JEV fast path matched (${record.rule ?? 'unknown'}) at ${confidence.toFixed(2)}`,
      data: { rule: record.rule },
    });
    return {
      kind: 'fast',
      confidence,
      rule: typeof record.rule === 'string' ? record.rule : 'remote',
      draft,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function coerceDraft(value: unknown): PlanDraft | null {
  const record = asRecord(value);
  if (!record) return null;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  const parsedSteps = steps.flatMap((entry) => {
    const step = asRecord(entry);
    if (!step || typeof step.tool !== 'string') return [];
    const params = asRecord(step.params) ?? {};
    return [
      {
        tool: step.tool,
        params,
        ...(typeof step.intent === 'string' ? { intent: step.intent } : {}),
        ...(Array.isArray(step.expect) ? { expect: step.expect as PlanDraft['steps'][number]['expect'] } : {}),
      },
    ];
  });
  if (parsedSteps.length === 0) return null;
  return {
    goal: typeof record.goal === 'string' ? record.goal : '',
    steps: parsedSteps,
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  };
}
