import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSnapshot, type DocumentSnapshot, type ToolMeta } from '@photoshop-ai-studio/shared';
import { TOOL_META } from '@photoshop-ai-studio/shared';
import { DeterministicGateway } from '../src/gateway/deterministic.js';
import { OpenAiCompatibleGateway, coercePlanDraft, parseJsonLoose, plannerSystemPrompt, plannerUserPrompt, renderStateForPrompt } from '../src/gateway/openai-compatible.js';
import { createGateway } from '../src/gateway/index.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '@photoshop-ai-studio/shared/node';

const state: DocumentSnapshot = buildSnapshot(
  { id: 'd1', name: 'banner.psd', width: 1920, height: 1080, resolution: 72, colorMode: 'RGB', layerCount: 4, path: null, saved: false },
  [
    { id: 1, name: 'Background', type: 'pixel', visible: true, opacity: 100, x: 0, y: 0, width: 1920, height: 1080, parentId: null },
    { id: 2, name: 'Logo', type: 'smartObject', visible: true, opacity: 100, x: 120, y: 80, width: 320, height: 120, parentId: null },
    { id: 3, name: 'Title', type: 'text', visible: true, opacity: 100, x: 120, y: 300, width: 900, height: 134, parentId: null },
    { id: 4, name: 'CTA', type: 'text', visible: true, opacity: 100, x: 120, y: 560, width: 300, height: 39, parentId: null },
  ],
);

const tools = TOOL_META as readonly ToolMeta[];

// ---------------------------------------------------------------------------

describe('JSON tolerance', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoose('{"a":1}', 'p', 'm')).toEqual({ a: 1 });
  });

  it('unwraps a markdown fence', () => {
    expect(parseJsonLoose('```json\n{"a":2}\n```', 'p', 'm')).toEqual({ a: 2 });
    expect(parseJsonLoose('```\n{"a":3}\n```', 'p', 'm')).toEqual({ a: 3 });
  });

  it('recovers JSON embedded in prose', () => {
    expect(parseJsonLoose('Here you go:\n{"a":4}\nHope that helps!', 'p', 'm')).toEqual({ a: 4 });
  });

  it('throws a typed error for unusable output', () => {
    expect(() => parseJsonLoose('I cannot do that.', 'p', 'm')).toThrow(/Could not parse JSON/);
  });
});

describe('plan draft coercion', () => {
  const request = { userRequest: 'do the thing', state, tools };

  it('accepts a well-formed plan', () => {
    const draft = coercePlanDraft(
      {
        goal: 'rename',
        steps: [{ tool: 'photoshop.rename_layer', params: { layerName: 'Logo', name: 'X' }, intent: 'rename it' }],
        notes: ['assumed the first match'],
      },
      request,
    );
    expect(draft.steps).toHaveLength(1);
    expect(draft.notes).toEqual(['assumed the first match']);
  });

  it('drops steps that reference tools this build does not have', () => {
    const draft = coercePlanDraft(
      {
        goal: 'x',
        steps: [
          { tool: 'photoshop.invent_something', params: {} },
          { tool: 'photoshop.get_document', params: {} },
        ],
      },
      request,
    );
    expect(draft.steps.map((s) => s.tool)).toEqual(['photoshop.get_document']);
  });

  it('drops malformed step entries without failing the plan', () => {
    const draft = coercePlanDraft(
      { goal: 'x', steps: [null, 42, { params: {} }, { tool: 'photoshop.get_document' }] },
      request,
    );
    expect(draft.steps).toHaveLength(1);
  });

  it('defaults non-array steps to empty', () => {
    expect(coercePlanDraft({ goal: 'x', steps: 'nope' }, request).steps).toEqual([]);
  });

  it('falls back to the user request when the goal is missing', () => {
    expect(coercePlanDraft({ steps: [] }, request).goal).toBe('do the thing');
  });

  it('throws when the reply is not an object', () => {
    expect(() => coercePlanDraft('hello', request)).toThrow(/not a JSON object/);
  });
});

describe('prompt construction', () => {
  it('lists every tool with its destructive flag', () => {
    const prompt = plannerSystemPrompt(tools);
    for (const tool of tools) {
      expect(prompt, tool.tool).toContain(tool.tool);
    }
    expect(prompt).toContain('photoshop.delete_layer [DESTRUCTIVE, needs-confirmation]');
  });

  it('gives the planner the shape of every argument, not just the description', () => {
    // The planner was shown `tool: description` and nothing else, so it invented
    // the shape of anything nested. `place_image` came back with `fit` as the
    // string "820" where the schema wants `{"height": 820}`, and the run died on
    // INVALID_PARAMS with a message that never said which argument was wrong.
    const prompt = plannerSystemPrompt(TOOL_META);

    // `documentId` accepts a number because Photoshop reports ids numerically and a
    // model copies what it was shown; the renderer must unwrap the transform to
    // say so, or it prints `pipe` and the planner learns nothing.
    expect(prompt).toContain('params: documentId?: string | number, path: string, name?: string, fit?: {width?: number, height?: number');
    // Nested objects must stay objects — that is the exact thing it got wrong.
    expect(prompt).toContain('layer: {layerId?: number, layerName?: string}, group: {layerId?: number, layerName?: string}');
    // Colour accepts both spellings, and the model needs to see both.
    expect(prompt).toMatch(/color: \{r: number, g: number, b: number\} \| string/);

    // A shape it could not resolve would send the model guessing again, so an
    // unrendered type is a regression rather than a cosmetic gap.
    expect(prompt, 'every parameter resolved to a concrete type').not.toContain('unknown');
    expect(prompt, 'no parameter rendered as an opaque wrapper').not.toContain(': pipe');
  });

  it('renders the document state as an indented tree', () => {
    const rendered = renderStateForPrompt(state);
    expect(rendered).toContain('document "banner.psd"');
    expect(rendered).toContain('id=3 "Title"');
    expect(rendered).toContain('bottom → top');
  });

  it('renders nesting when layers have parents', () => {
    const nested = buildSnapshot(state.document, [
      state.layers[1]!,
      { ...state.layers[2]!, parentId: 2 },
    ]);
    const rendered = renderStateForPrompt(nested);
    expect(rendered).toContain('parent=2');
    expect(rendered).toMatch(/\n {4}- id=3/);
  });

  it('says so plainly when no document is open', () => {
    expect(renderStateForPrompt(null)).toContain('no document is currently open');
  });

  it('includes the repair hint and previous errors when repairing', () => {
    const prompt = plannerUserPrompt({
      userRequest: 'fix it',
      state,
      tools,
      repairHint: 'Verification failed: opacity',
      previousErrors: [{ code: 'LAYER_NOT_FOUND', message: 'Layer "Logo" was not found', recoverable: true }],
      completedTools: ['photoshop.duplicate_document'],
    });
    expect(prompt).toContain('Repair hint');
    expect(prompt).toContain('LAYER_NOT_FOUND');
    expect(prompt).toContain('Already completed');
  });
});

// ---------------------------------------------------------------------------

describe('deterministic gateway', () => {
  const gateway = new DeterministicGateway('planner', 'deterministic');

  it('plans a proportional square variant with real layout arithmetic', async () => {
    const draft = await gateway.plan({ userRequest: 'Create a square version of this banner.', state, tools });

    expect(draft.steps[0]?.tool).toBe('photoshop.duplicate_document');
    expect(draft.steps[1]?.params).toMatchObject({ width: 1080, height: 1080, anchor: 'center' });

    // scale = min(1080/1920, 1080/1080) = 0.5625
    const resize = draft.steps.find((s) => s.tool === 'photoshop.resize_layer');
    expect(resize?.params).toMatchObject({ scale: 0.5625 });

    // Logo at x=120 in a 1920-wide canvas, re-centred in 1080:
    // newX = (1920-1080)/2 + (120 - (1920-1080)/2) * 0.5625 = 420 + (-300*0.5625) = 251.25
    const logoMove = draft.steps.find((s) => s.tool === 'photoshop.move_layer' && s.params.layerName === 'Logo');
    expect(logoMove?.params).toMatchObject({ x: 251, y: 45 });
  });

  it('scales text with the point size, not the box', async () => {
    const draft = await gateway.plan({ userRequest: 'make a 1080x1080 version', state, tools });
    const fontSteps = draft.steps.filter((s) => s.tool === 'photoshop.set_text_font_size');
    expect(fontSteps).toHaveLength(2);
    // Title height 134 → ~96pt, scaled by 0.5625.
    expect(fontSteps[0]?.params.fontSize).toBeCloseTo(54, 0);
  });

  it('addresses layers by name once it has duplicated the document', async () => {
    const draft = await gateway.plan({ userRequest: 'square version of this banner', state, tools });
    // Duplicating assigns fresh layer ids, so ids taken from the pre-plan
    // snapshot would be stale by the time the steps run.
    expect(draft.steps.filter((s) => s.params.layerId !== undefined)).toEqual([]);
    expect(draft.steps.filter((s) => s.tool.includes('layer')).every((s) => typeof s.params.layerName === 'string')).toBe(true);
  });

  it('honours an explicit target size', async () => {
    const draft = await gateway.plan({ userRequest: 'resize the banner to 1200x600', state, tools });
    expect(draft.steps[1]?.params).toMatchObject({ width: 1200, height: 600 });
  });

  it('centres a named layer', async () => {
    const draft = await gateway.plan({ userRequest: 'center the Title', state, tools });
    expect(draft.steps[0]?.tool).toBe('photoshop.move_layer');
    // Title 900 wide on a 1920 canvas → x = 510; height 134 on 1080 → y = 473.
    expect(draft.steps[0]?.params).toMatchObject({ layerId: 3, x: 510, y: 473 });
  });

  it('groups named layers', async () => {
    const draft = await gateway.plan({ userRequest: 'group the Logo and the Title into a Header', state, tools });
    expect(draft.steps[0]?.tool).toBe('photoshop.create_group');
    expect(draft.steps[0]?.params.name).toBe('Header');
    expect(draft.steps.filter((s) => s.tool === 'photoshop.move_layer_to_group')).toHaveLength(1);
  });

  it('returns an empty plan with a note when it does not understand the request', async () => {
    const draft = await gateway.plan({ userRequest: 'make the sky blue and rotate everything 45 degrees', state, tools });
    expect(draft.steps).toEqual([]);
    expect(draft.notes.join(' ')).toContain('does not understand');
  });

  it('declines to repair rather than guessing', async () => {
    const draft = await gateway.plan({
      userRequest: 'center the Title',
      state,
      tools,
      repairHint: 'Verification failed:\n- step-1: some unmodellable thing — Expected a, got b',
    });
    expect(draft.steps).toEqual([]);
    expect(draft.notes.join(' ')).toContain('cannot synthesise a repair');
  });

  it('derives a mechanical repair from a verification report', async () => {
    const draft = await gateway.plan({
      userRequest: 'center the Title',
      state,
      tools,
      repairHint:
        'Verification failed:\n' +
        '- step-1: x of "Title" — Expected 510, Photoshop reports 3\n' +
        '- step-1: y of "Title" — Expected 473, Photoshop reports 4',
    });
    // Both coordinates are repaired by one step, otherwise the second would
    // replay a stale copy of the first.
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.params).toMatchObject({ layerName: 'Title', x: 510, y: 473 });
  });

  it('produces plans that validate against the tool schemas', async () => {
    const { validateParams } = await import('@photoshop-ai-studio/shared');
    const messages = [
      'Create a square version of this banner.',
      'center the Title',
      'group the Logo and the Title into a Header',
      'resize the banner to 1200x600',
    ];
    for (const message of messages) {
      const draft = await gateway.plan({ userRequest: message, state, tools });
      expect(draft.steps.length, message).toBeGreaterThan(0);
      for (const step of draft.steps) {
        expect(
          () => validateParams(step.tool.replace('photoshop.', '') as never, step.params),
          `${message} / ${step.tool}`,
        ).not.toThrow();
      }
    }
  });

  it('verifies from the deterministic result rather than overriding it', async () => {
    const verdict = await gateway.verify({
      userRequest: 'x',
      goal: 'x',
      state,
      diffText: '',
      deterministic: { passed: false, failedCount: 2, summary: '' },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('2');
  });
});

// ---------------------------------------------------------------------------

describe('gateway factory', () => {
  const config = { ...loadConfig(), logLevel: 'error' as const };
  const logger = createLogger({ source: 'orchestrator', level: 'error', console: false });

  it('builds the offline gateway for provider=mock', () => {
    const gateway = createGateway({ role: 'planner', provider: 'mock', model: 'x', apiKey: undefined, baseUrl: undefined }, config, logger);
    expect(gateway.provider).toBe('mock');
  });

  it('builds an OpenAI-compatible gateway with the default base URL', () => {
    const gateway = createGateway({ role: 'planner', provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-x', baseUrl: undefined }, config, logger);
    expect(gateway.provider).toBe('openai-compatible');
  });

  it('builds an Anthropic gateway', () => {
    const gateway = createGateway({ role: 'vision', provider: 'anthropic', model: 'claude', apiKey: 'k', baseUrl: undefined }, config, logger);
    expect(gateway.provider).toBe('anthropic');
  });

  it('reports a missing API key as a typed, recoverable failure', async () => {
    const gateway = createGateway({ role: 'planner', provider: 'openai', model: 'gpt-4.1', apiKey: undefined, baseUrl: 'https://example.invalid' }, config, logger);
    await expect(gateway.plan({ userRequest: 'x', state, tools })).rejects.toThrow(/No API key configured/);
  });

  it('configures the three roles independently', () => {
    const roles = loadConfig().roles;
    expect(Object.keys(roles).sort()).toEqual(['fast', 'planner', 'vision']);
  });
});

// ---------------------------------------------------------------------------

describe('OpenAI-compatible gateway over HTTP', () => {
  const logger = { warn: () => {} };

  /** Answers every chat completion with `payload`, and records what was sent. */
  const stubFetch = (payload: unknown): { sent: () => any } => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { sent: () => calls.at(-1) };
  };

  const gateway = (maxTokens = 8192) =>
    new OpenAiCompatibleGateway({
      role: 'planner',
      model: 'test-model',
      apiKey: 'k',
      baseUrl: 'https://example.invalid/v1',
      temperature: 0.1,
      timeoutMs: 1000,
      maxTokens,
      logger,
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an explicit max_tokens', async () => {
    // Left to the provider it is what breaks reasoning models: Space Bunny Alpha
    // spends ~19k characters reasoning before its first token of JSON, so the
    // provider default truncated it to `content: null` and the run died as
    // PLAN_INVALID with no indication why.
    const fetchStub = stubFetch({ choices: [{ message: { content: '{"goal":"x","steps":[]}' } }] });
    await gateway().plan({ userRequest: 'x', state, tools });
    expect(fetchStub.sent().max_tokens).toBe(8192);
  });

  it('explains a completion that ran out of budget instead of calling it empty', async () => {
    // These need opposite advice — raise the ceiling vs. fix the model — so
    // reporting both as "empty completion" wasted the only clue there was.
    stubFetch({ choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'thinking…' } }] });
    await expect(gateway().plan({ userRequest: 'x', state, tools })).rejects.toThrow(/budget.*Raise AI_MAX_TOKENS/s);
  });

  it('still reports a genuinely empty completion as such', async () => {
    stubFetch({ choices: [{ finish_reason: 'stop', message: { content: '' } }] });
    await expect(gateway().plan({ userRequest: 'x', state, tools })).rejects.toThrow(/empty completion \(finish_reason: stop\)/);
  });
});
