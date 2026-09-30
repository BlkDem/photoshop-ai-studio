import { describe, expect, it } from 'vitest';

import { buildSnapshot, type DocumentSnapshot } from '@photoshop-ai-studio/shared';
import { DeterministicJevRouter } from '../src/jev/deterministic.js';
import { RemoteJevRouter } from '../src/jev/remote.js';
import { DisabledJevRouter } from '../src/jev/types.js';

const state: DocumentSnapshot = buildSnapshot(
  {
    id: 'd1',
    name: 'banner.psd',
    width: 1920,
    height: 1080,
    resolution: 72,
    colorMode: 'RGB',
    layerCount: 3,
    path: null,
    saved: true,
  },
  [
    { id: 1, name: 'Background', type: 'pixel', visible: true, opacity: 100, x: 0, y: 0, width: 1920, height: 1080, parentId: null },
    { id: 2, name: 'Logo', type: 'smartObject', visible: true, opacity: 100, x: 120, y: 80, width: 320, height: 120, parentId: null },
    { id: 3, name: 'Title', type: 'text', visible: true, opacity: 100, x: 120, y: 300, width: 800, height: 90, parentId: null },
  ],
);

const router = new DeterministicJevRouter(0.82);
const route = (text: string, snapshot: DocumentSnapshot | null = state) => router.route({ text, state: snapshot });

describe('JEV deterministic router', () => {
  it('handles the fast-path examples from the brief', async () => {
    const cases: [string, string][] = [
      ['rename Logo to Company Logo', 'photoshop.rename_layer'],
      ['set the Title opacity to 70%', 'photoshop.set_layer_opacity'],
      ['hide Background', 'photoshop.set_layer_visibility'],
      ['export png', 'photoshop.export_png'],
      ['create group Header', 'photoshop.create_group'],
    ];
    for (const [text, tool] of cases) {
      const decision = await route(text);
      expect(decision.kind, `${text} → ${decision.kind}`).toBe('fast');
      if (decision.kind === 'fast') {
        expect(decision.draft.steps[0]?.tool).toBe(tool);
        expect(decision.confidence).toBeGreaterThanOrEqual(0.82);
      }
    }
  });

  it('accepts the bare "set opacity to 70%" only when one layer could be meant', async () => {
    const single = buildSnapshot(state.document, [state.layers[2]!]);
    const decision = await route('set opacity to 70%', single);
    expect(decision.kind).toBe('fast');
    if (decision.kind === 'fast') expect(decision.draft.steps[0]?.params).toMatchObject({ layerId: 3, opacity: 70 });

    // Three layers and no name: choosing one would be a guess.
    expect((await route('set opacity to 70%')).kind).toBe('llm');
  });

  it('resolves the layer against live state rather than trusting the text', async () => {
    const decision = await route('rename Logo to Company Logo');
    expect(decision.kind).toBe('fast');
    if (decision.kind === 'fast') {
      expect(decision.draft.steps[0]?.params).toEqual({ layerId: 2, name: 'Company Logo' });
    }
  });

  it('matches a quoted multi-word layer name', async () => {
    const snapshot = buildSnapshot(state.document, [{ ...state.layers[1]!, name: 'Company Logo' }]);
    const decision = await route('rename "Company Logo" to Logo v2', snapshot);
    expect(decision.kind).toBe('fast');
    if (decision.kind === 'fast') {
      expect(decision.draft.steps[0]?.params).toMatchObject({ layerId: 2, name: 'Logo v2' });
    }
  });

  it('abstains when the layer does not exist', async () => {
    expect((await route('rename Nonexistent to X')).kind).toBe('llm');
  });

  it('abstains when the layer name is ambiguous', async () => {
    const snapshot = buildSnapshot(state.document, [
      ...state.layers,
      { ...state.layers[1]!, id: 9, name: 'Logo' },
    ]);
    expect((await route('rename Logo to X', snapshot)).kind).toBe('llm');
  });

  it('abstains on compound instructions', async () => {
    for (const text of [
      'hide Background and then export png',
      'rename Logo to X, then resize canvas to 100x100',
      'hide Background and also hide Logo',
    ]) {
      expect((await route(text)).kind, text).toBe('llm');
    }
  });

  it('abstains without a document open', async () => {
    expect((await route('rename Logo to X', null)).kind).toBe('llm');
    expect((await route('hide Background', null)).kind).toBe('llm');
  });

  it('abstains on inputs outside its remit', async () => {
    for (const text of ['', 'x'.repeat(200), 'make the sky blue']) {
      expect((await route(text)).kind, JSON.stringify(text.slice(0, 20))).toBe('llm');
    }
  });

  it('defers anything it is not confident about', async () => {
    const strict = new DeterministicJevRouter(0.99);
    const decision = await strict.route({ text: 'create group Header', state });
    // Confidence 0.94 < 0.99 → the planner takes over.
    expect(decision.kind).toBe('llm');
    if (decision.kind === 'llm') expect(decision.reason).toMatch(/scored/);
  });

  it('clamps an absurd opacity instead of emitting an invalid plan', async () => {
    const decision = await route('set the Title opacity to 500%');
    expect(decision.kind).toBe('fast');
    if (decision.kind === 'fast') {
      expect(decision.draft.steps[0]?.params).toMatchObject({ opacity: 100 });
    }
  });

  it('produces valid tool arguments for every fast path', async () => {
    const { validateParams } = await import('@photoshop-ai-studio/shared');
    const texts = [
      'rename Logo to Company Logo',
      'set the Title opacity to 70%',
      'hide Background',
      'show Background',
      'create group Header',
      'export png',
      'export jpg',
      'save psd',
      'resize canvas to 1080x1080',
    ];
    for (const text of texts) {
      const decision = await route(text);
      expect(decision.kind, text).toBe('fast');
      if (decision.kind !== 'fast') continue;
      for (const step of decision.draft.steps) {
        expect(() => validateParams(step.tool.replace('photoshop.', '') as never, step.params), `${text} / ${step.tool}`).not.toThrow();
      }
    }
  });
});

describe('JEV remote router', () => {
  const options = {
    url: 'http://jev.invalid/route',
    apiKey: undefined,
    minConfidence: 0.8,
    timeoutMs: 200,
    logger: { warn: () => undefined, info: () => undefined },
  };

  it('reports its mode and runtime URL', () => {
    const remote = new RemoteJevRouter(options);
    expect(remote.mode).toBe('remote');
    expect(remote.runtimeUrl).toBe(options.url);
  });

  it('falls back to the model when the runtime is unreachable', async () => {
    const decision = await new RemoteJevRouter(options).route({ text: 'hide Background', state });
    expect(decision.kind).toBe('llm');
    if (decision.kind === 'llm') expect(decision.reason).toMatch(/unreachable/);
  });

  it('accepts a well-formed fast decision', async () => {
    const server = await mockRuntime(200, {
      decision: 'fast',
      confidence: 0.95,
      rule: 'rename',
      draft: { goal: 'rename', steps: [{ tool: 'photoshop.rename_layer', params: { layerName: 'Logo', name: 'X' } }] },
    });
    const decision = await new RemoteJevRouter({ ...options, url: server }).route({ text: 'x', state });
    expect(decision.kind).toBe('fast');
    if (decision.kind === 'fast') expect(decision.rule).toBe('rename');
    void (await import('node:http')).default;
  });

  it('rejects a fast decision below the confidence threshold', async () => {
    const server = await mockRuntime(200, {
      decision: 'fast',
      confidence: 0.2,
      draft: { goal: 'x', steps: [{ tool: 'photoshop.get_document', params: {} }] },
    });
    const decision = await new RemoteJevRouter({ ...options, url: server }).route({ text: 'x', state });
    expect(decision.kind).toBe('llm');
  });

  it('rejects a malformed reply instead of guessing', async () => {
    const server = await mockRuntime(200, { decision: 'fast', confidence: 1, draft: { goal: 'x', steps: [] } });
    expect((await new RemoteJevRouter({ ...options, url: server }).route({ text: 'x', state })).kind).toBe('llm');
  });

  it('survives a non-2xx status', async () => {
    const server = await mockRuntime(503, { decision: 'llm' });
    expect((await new RemoteJevRouter({ ...options, url: server }).route({ text: 'x', state })).kind).toBe('llm');
  });

  it('can be disabled entirely', async () => {
    const decision = await new DisabledJevRouter().route();
    expect(decision.kind).toBe('llm');
  });
});

/** Spins up a throwaway HTTP server that answers with `body`. */
async function mockRuntime(status: number, body: unknown): Promise<string> {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  server.unref();
  return `http://127.0.0.1:${port}/route`;
}
