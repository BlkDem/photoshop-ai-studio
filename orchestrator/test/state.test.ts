import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildSnapshot, type DocumentSnapshot, type Expectation, type LayerInfo, type TextLayerInfo } from '@photoshop-ai-studio/shared';
import { safeVerify, verifyState } from '../src/state/verification.js';
import { buildPlan } from '../src/execution/plan-builder.js';
import { applyDecisions, evaluateSafety } from '../src/execution/safety.js';

const layer = (over: Partial<LayerInfo> = {}): LayerInfo => ({
  id: 1,
  name: 'Title',
  type: 'text',
  visible: true,
  opacity: 100,
  x: 10,
  y: 20,
  width: 200,
  height: 40,
  parentId: null,
  ...over,
});

const snapshot = (layers: LayerInfo[], doc: Partial<DocumentSnapshot['document']> = {}): DocumentSnapshot =>
  buildSnapshot(
    {
      id: 'd1',
      name: 'banner.psd',
      width: 1920,
      height: 1080,
      resolution: 72,
      colorMode: 'RGB',
      layerCount: layers.length,
      ...doc,
    },
    layers,
  );

const noText = async (): Promise<TextLayerInfo | null> => null;
const textFor = (info: Partial<TextLayerInfo> & { layerId: number }): TextLayerInfo => ({
  layerId: info.layerId,
  name: info.name ?? 'Title',
  text: info.text ?? 'Hello',
  font: info.font ?? 'MyriadPro-Regular',
  fontSize: info.fontSize ?? 24,
  color: info.color ?? { r: 0, g: 0, b: 0 },
  width: info.width ?? 200,
  height: info.height ?? 40,
});

const dir = mkdtempSync(join(tmpdir(), 'studio-verify-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('VerificationEngine', () => {
  it('passes when the state matches', async () => {
    const result = await verifyState({
      expectations: [{ stepId: 'step-1', expectations: [{ kind: 'layer_property', layer: { layerId: 1 }, property: 'opacity', equals: 100, tolerance: 0 }] }],
      snapshot: snapshot([layer()]),
      readText: noText,
    });
    expect(result.passed).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.repairHint).toBeNull();
  });

  it('fails and explains when the state does not match', async () => {
    const result = await verifyState({
      expectations: [{ stepId: 'step-1', expectations: [{ kind: 'layer_property', layer: { layerId: 1 }, property: 'opacity', equals: 70, tolerance: 0.5 }] }],
      snapshot: snapshot([layer({ opacity: 100 })]),
      readText: noText,
    });
    expect(result.passed).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.checks[0]?.detail).toContain('Expected 70');
    expect(result.repairHint).toContain('opacity of "Title"');
    expect(result.repairHint).toContain('step-1');
  });

  it('honours tolerance', async () => {
    const expectations: Expectation[] = [
      { kind: 'layer_property', layer: { layerId: 1 }, property: 'x', equals: 11, tolerance: 2 },
    ];
    const result = await verifyState({ expectations: [{ stepId: 's', expectations }], snapshot: snapshot([layer({ x: 12 })]), readText: noText });
    expect(result.passed).toBe(true);
  });

  it('rejects a property check on a missing layer rather than skipping it', async () => {
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations: [{ kind: 'layer_property', layer: { layerName: 'Ghost' }, property: 'opacity', equals: 70, tolerance: 0 }] }],
      snapshot: snapshot([layer()]),
      readText: noText,
    });
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toContain('does not exist');
  });

  it('checks presence and absence', async () => {
    const expectations: Expectation[] = [
      { kind: 'layer_exists', layer: { layerName: 'Title' }, where: 'document' },
      { kind: 'layer_absent', layer: { layerName: 'Deleted' } },
    ];
    expect((await verifyState({ expectations: [{ stepId: 's', expectations }], snapshot: snapshot([layer()]), readText: noText })).passed).toBe(true);

    const stillThere: Expectation[] = [{ kind: 'layer_absent', layer: { layerName: 'Title' } }];
    expect((await verifyState({ expectations: [{ stepId: 's', expectations: stillThere }], snapshot: snapshot([layer()]), readText: noText })).passed).toBe(false);
  });

  it('verifies group membership by name', async () => {
    const layers = [layer({ id: 2, name: 'Header', type: 'group' }), layer({ id: 3, parentId: 2 })];
    const inside: Expectation[] = [{ kind: 'layer_parent_named', layer: { layerId: 3 }, groupName: 'Header' }];
    expect((await verifyState({ expectations: [{ stepId: 's', expectations: inside }], snapshot: snapshot(layers), readText: noText })).passed).toBe(true);

    const wrongGroup: Expectation[] = [{ kind: 'layer_parent_named', layer: { layerId: 3 }, groupName: 'Footer' }];
    const wrong = await verifyState({ expectations: [{ stepId: 's', expectations: wrongGroup }], snapshot: snapshot(layers), readText: noText });
    expect(wrong.passed).toBe(false);
    expect(wrong.checks[0]?.detail).toContain('not "Footer"');

    const atRoot = [layer({ id: 4, name: 'Loose' })];
    const rooted: Expectation[] = [{ kind: 'layer_parent_named', layer: { layerId: 4 }, groupName: 'Header' }];
    const rootResult = await verifyState({ expectations: [{ stepId: 's', expectations: rooted }], snapshot: snapshot(atRoot), readText: noText });
    expect(rootResult.passed).toBe(false);
    expect(rootResult.checks[0]?.detail).toContain('still at the document root');
  });

  it('verifies document geometry', async () => {
    const expectations: Expectation[] = [
      { kind: 'document_property', property: 'width', equals: 1080, tolerance: 1 },
      { kind: 'document_property', property: 'height', equals: 1080, tolerance: 1 },
    ];
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations }],
      snapshot: snapshot([layer()], { width: 1080, height: 1080 }),
      readText: noText,
    });
    expect(result.passed).toBe(true);
  });

  it('verifies layer count', async () => {
    const expectations: Expectation[] = [{ kind: 'layer_count', equals: 2 }];
    const layers = [layer({ id: 1 }), layer({ id: 2, name: 'Other' })];
    expect((await verifyState({ expectations: [{ stepId: 's', expectations }], snapshot: snapshot(layers), readText: noText })).passed).toBe(true);
  });

  it('verifies text content through the injected reader', async () => {
    const expectations: Expectation[] = [
      { kind: 'text_property', layer: { layerId: 1 }, property: 'text', equals: 'Hello', tolerance: 0 },
    ];
    const passed = await verifyState({
      expectations: [{ stepId: 's', expectations }],
      snapshot: snapshot([layer()]),
      readText: async () => textFor({ layerId: 1, text: 'Hello' }),
    });
    expect(passed.passed).toBe(true);

    const failed = await verifyState({
      expectations: [{ stepId: 's', expectations }],
      snapshot: snapshot([layer()]),
      readText: async () => textFor({ layerId: 1, text: 'Goodbye' }),
    });
    expect(failed.passed).toBe(false);
    expect(failed.checks[0]?.detail).toContain('Goodbye');
  });

  it('treats a text check on a non-text layer as failed, not skipped', async () => {
    const expectations: Expectation[] = [
      { kind: 'text_property', layer: { layerId: 1 }, property: 'fontSize', equals: 24, tolerance: 0 },
    ];
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations }],
      snapshot: snapshot([layer({ type: 'pixel' })]),
      readText: async () => null,
    });
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.detail).toContain('has no text content');
  });

  it('compares colours structurally', async () => {
    const expectations: Expectation[] = [
      { kind: 'text_property', layer: { layerId: 1 }, property: 'color', equals: { r: 255, g: 136, b: 0 }, tolerance: 0 },
    ];
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations }],
      snapshot: snapshot([layer()]),
      readText: async () => textFor({ layerId: 1, color: { r: 255, g: 136, b: 0 } }),
    });
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.actual).toBe('255,136,0');
  });

  it('reads each text layer only once', async () => {
    let reads = 0;
    const expectations: Expectation[] = [
      { kind: 'text_property', layer: { layerId: 1 }, property: 'text', equals: 'Hello', tolerance: 0 },
      { kind: 'text_property', layer: { layerId: 1 }, property: 'fontSize', equals: 24, tolerance: 0 },
    ];
    await verifyState({
      expectations: [{ stepId: 's', expectations }],
      snapshot: snapshot([layer()]),
      readText: async () => {
        reads += 1;
        return textFor({ layerId: 1 });
      },
    });
    expect(reads).toBe(1);
  });

  it('marks custom checks as skipped so the vision model can own them', async () => {
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations: [{ kind: 'custom', description: 'does it look good' }] }],
      snapshot: snapshot([layer()]),
      readText: noText,
    });
    expect(result.checks[0]?.status).toBe('skipped');
    expect(result.passed).toBe(true);
  });

  it('accepts a workspace-relative path when the tool reported an absolute one', async () => {
    const absolute = join(dir, 'out.png');
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations: [{ kind: 'file_exists', path: 'out/out.png' }] }],
      snapshot: snapshot([layer()]),
      readText: noText,
      producedFiles: [absolute],
    });
    expect(result.passed).toBe(true);
  });

  it('fails a file check when nothing was written', async () => {
    const result = await verifyState({
      expectations: [{ stepId: 's', expectations: [{ kind: 'file_exists', path: join(dir, 'missing.png') }] }],
      snapshot: snapshot([layer()]),
      readText: noText,
    });
    expect(result.passed).toBe(false);
  });

  it('passes with zero expectations and does not claim success falsely', async () => {
    const result = await verifyState({ expectations: [], snapshot: snapshot([layer()]), readText: noText });
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  it('degrades to a failed verification instead of throwing', async () => {
    const broken = {
      expectations: [
        { stepId: 's', expectations: [{ kind: 'text_property', layer: { layerId: 1 }, property: 'text', equals: 'x', tolerance: 0 }] as Expectation[] },
      ],
      snapshot: snapshot([layer()]),
      readText: () => {
        throw new Error('Photoshop went away');
      },
      producedFiles: [],
    };
    const result = await safeVerify(broken);
    expect(result.passed).toBe(false);
    expect(result.repairHint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('plan builder', () => {
  const model = { role: 'planner' as const, provider: 'test', model: 'test' };

  it('assigns ids and derives destructive flags from the tool registry', () => {
    const plan = buildPlan({
      draft: {
        goal: 'tidy up',
        steps: [
          { tool: 'photoshop.rename_layer', params: { layerName: 'Logo', name: 'Company Logo' } },
          { tool: 'photoshop.delete_layer', params: { layerName: 'Background' } },
        ],
      },
      model,
      route: 'llm',
      maxSteps: 24,
    });

    expect(plan.steps.map((s) => s.id)).toEqual(['step-1', 'step-2']);
    expect(plan.steps[0]?.destructive).toBe(false);
    expect(plan.steps[1]?.destructive).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.confirmations).toHaveLength(1);
    expect(plan.confirmations[0]?.question).toBe('Delete layer "Background"? This cannot be undone from here.');
  });

  it('merges planner expectations with derived ones instead of replacing them', () => {
    const plan = buildPlan({
      draft: {
        goal: 'x',
        steps: [
          {
            tool: 'photoshop.set_layer_opacity',
            params: { layerId: 1, opacity: 70 },
            expect: [{ kind: 'custom', description: 'still readable' }],
          },
        ],
      },
      model,
      route: 'llm',
      maxSteps: 24,
    });
    const kinds = plan.steps[0]!.expect.map((e) => e.kind);
    expect(kinds).toContain('layer_property');
    expect(kinds).toContain('custom');
  });

  it('does not duplicate an expectation the planner already restated', () => {
    const plan = buildPlan({
      draft: {
        goal: 'x',
        steps: [
          {
            tool: 'photoshop.set_layer_opacity',
            params: { layerId: 1, opacity: 70 },
            expect: [{ kind: 'layer_property', layer: { layerId: 1 }, property: 'opacity', equals: 70, tolerance: 0 }],
          },
        ],
      },
      model,
      route: 'llm',
      maxSteps: 24,
    });
    expect(plan.steps[0]?.expect.filter((e) => e.kind === 'layer_property')).toHaveLength(1);
  });

  it('rejects an unknown tool', () => {
    expect(() =>
      buildPlan({ draft: { goal: 'x', steps: [{ tool: 'photoshop.delete_everything', params: {} }] }, model, route: 'llm', maxSteps: 5 }),
    ).toThrow(/unknown tool/i);
  });

  it('rejects invalid arguments before the user is asked to approve', () => {
    expect(() =>
      buildPlan({ draft: { goal: 'x', steps: [{ tool: 'photoshop.set_layer_opacity', params: { layerId: 1, opacity: 999 } }] }, model, route: 'llm', maxSteps: 5 }),
    ).toThrow(/invalid/i);
  });

  it('rejects an empty plan', () => {
    expect(() => buildPlan({ draft: { goal: 'x', steps: [] }, model, route: 'llm', maxSteps: 5 })).toThrow(/empty plan/i);
  });

  it('rejects a plan above the step ceiling', () => {
    const steps = Array.from({ length: 6 }, () => ({ tool: 'photoshop.get_document', params: {} }));
    expect(() => buildPlan({ draft: { goal: 'x', steps }, model, route: 'llm', maxSteps: 5 })).toThrow(/step limit/i);
  });
});

// ---------------------------------------------------------------------------

describe('safety gate', () => {
  const destructivePlan = buildPlan({
    draft: {
      goal: 'clean up',
      steps: [
        { tool: 'photoshop.rename_layer', params: { layerName: 'Logo', name: 'Company Logo' } },
        { tool: 'photoshop.delete_layer', params: { layerId: 1 } },
        { tool: 'photoshop.export_png', params: { path: 'out/a.png' } },
      ],
    },
    model: { role: 'planner', provider: 'test', model: 'test' },
    route: 'llm',
    maxSteps: 24,
  });

  it('blocks the plan until every destructive step has a decision', () => {
    const decision = evaluateSafety({ plan: destructivePlan, decisions: new Map() });
    expect(decision.allowed).toBe(false);
    expect(decision.pending).toHaveLength(2);
  });

  it('allows once all destructive steps are approved', () => {
    const decision = evaluateSafety({
      plan: destructivePlan,
      decisions: new Map([
        ['step-2', true],
        ['step-3', true],
      ]),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.pending).toHaveLength(0);
  });

  it('honours auto-approve only when explicitly requested', () => {
    expect(evaluateSafety({ plan: destructivePlan, decisions: new Map() }).allowed).toBe(false);
    expect(evaluateSafety({ plan: destructivePlan, decisions: new Map(), autoApprove: true }).allowed).toBe(true);
  });

  it('lets the user refuse a single step without losing the rest', () => {
    const decisions = new Map([
      ['step-2', false],
      ['step-3', true],
    ]);
    const safety = evaluateSafety({ plan: destructivePlan, decisions });
    expect(safety.allowed).toBe(false);
    expect(safety.rejected).toEqual(['step-2']);

    const { runnable, skipped } = applyDecisions(destructivePlan, decisions);
    expect(runnable.map((s) => s.id)).toEqual(['step-1', 'step-3']);
    expect(skipped).toEqual(['step-2']);
  });

  it('never lets the plan override the registry’s destructive flag', () => {
    const tampered = { ...destructivePlan, steps: destructivePlan.steps.map((s) => ({ ...s, destructive: false })) };
    const decision = evaluateSafety({ plan: tampered, decisions: new Map() });
    expect(decision.pending.length).toBe(2);
  });
});
