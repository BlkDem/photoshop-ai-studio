import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RunDetail } from '@photoshop-ai-studio/shared';
import { TOOL_META, deriveExpectations } from '@photoshop-ai-studio/shared';

import { LogBus, createLogger } from '@photoshop-ai-studio/shared/node';
import { MockPhotoshopAdapter } from '@photoshop-ai-studio/mcp-server/adapter/mock-adapter';
import { createHttpApp } from '@photoshop-ai-studio/mcp-server/http';
import { Workspace } from '@photoshop-ai-studio/mcp-server/workspace';

import { loadConfig } from '../src/config.js';
import { McpClient } from '../src/mcp/client.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { OrchestratorConfig } from '../src/config.js';

/**
 * Orchestrator tests (brief §28).
 *
 * The stack under test is the real one: a real MCP server on a real socket, a
 * real MCP client, and the real Orchestrator — only the Photoshop adapter and the
 * model provider are substituted. That is deliberate: a unit test that mocks the
 * MCP client would not catch a schema or transport mistake, which is exactly the
 * kind of bug this layer exists to prevent.
 */

let dataDir: string;
let workspaceDir: string;
let adapter: MockPhotoshopAdapter;
let mcpServer: Server;
let client: McpClient;
let events: { publish: (event: unknown) => void };

/**
 * Build a fresh orchestrator against the shared MCP server.
 *
 * The model roles are pinned to the deterministic gateway rather than inherited
 * from `loadConfig()`. `loadConfig` reads the developer's `.env`, so without this
 * the suite silently ran against whatever provider that file names — these tests
 * assert on exact plan steps and error codes, so a real planner turns them into
 * a network test that fails for reasons unrelated to the code, and passes on a
 * machine with no key configured at all.
 */
function makeOrchestrator(overrides: Partial<OrchestratorConfig> = {}): Orchestrator {
  const base = loadConfig();
  const offline: OrchestratorConfig['roles'] = {
    planner: { role: 'planner', provider: 'mock', model: 'deterministic', apiKey: undefined, baseUrl: undefined },
    vision: { role: 'vision', provider: 'mock', model: 'deterministic', apiKey: undefined, baseUrl: undefined },
    fast: { role: 'fast', provider: 'mock', model: 'deterministic', apiKey: undefined, baseUrl: undefined },
  };
  const config: OrchestratorConfig = {
    ...base,
    mcpUrl,
    dataDir,
    logLevel: 'error',
    logFile: null,
    maxRepairAttempts: 2,
    roles: offline,
    ...overrides,
  };
  const logger = createLogger({ source: 'orchestrator', level: 'error', console: false });
  return new Orchestrator({ config, logger, client, events: events as never });
}

let mcpUrl: string;

beforeAll(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'studio-orch-ws-'));
  dataDir = mkdtempSync(join(tmpdir(), 'studio-orch-data-'));
  adapter = new MockPhotoshopAdapter({ workspace: new Workspace(workspaceDir, join(workspaceDir, 'out')) });

  const bus = new LogBus();
  const logger = createLogger({ source: 'mcp', level: 'error', bus, console: false });
  const { app } = createHttpApp({ adapter, logger, bus, allowedHosts: [], allowedOrigins: [] });
  mcpServer = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`;

  client = new McpClient({ url: mcpUrl, timeoutMs: 10_000, logger });
  events = { publish: () => undefined };
});

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => mcpServer?.close(() => resolve()));
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  adapter.reset();
});

/** Reaches into the mock's document store to simulate a Photoshop-side lock. */
function lockLayer(target: MockPhotoshopAdapter, layerId: number, locked: boolean): void {
  const store = (target as unknown as { documents: Map<string, { layers: Record<string, unknown>[] }> }).documents;
  store.forEach((doc) => {
    const layer = doc.layers.find((l) => l.id === layerId);
    if (layer) layer.isLocked = locked;
  });
}

/** Submit + (optionally) approve, returning the finished run detail. */
async function run(
  orchestrator: Orchestrator,
  message: string,
  options: { approve?: boolean; approveDestructive?: boolean } = {},
): Promise<RunDetail> {
  const { run } = await orchestrator.submit({ sessionId: 'test', message });
  const approve = options.approve ?? true;
  if (!approve) return orchestrator.getRun(run.id);
  const decisions = (run.confirmations ?? []).map((c) => ({
    stepId: c.stepId,
    approved: options.approveDestructive ?? true,
  }));
  return orchestrator.approve(run.id, decisions, { autoApprove: true });
}

// ---------------------------------------------------------------------------

describe('simple request (JEV fast path)', () => {
  it('routes a rename to the fast path, executes and verifies it', async () => {
    const orchestrator = makeOrchestrator();
    const submitted = await orchestrator.submit({ sessionId: 'test', message: 'rename Logo to Company Logo' });

    expect(submitted.run.route).toBe('jev-fast-path');
    expect(submitted.run.status).toBe('awaiting_approval');
    expect(submitted.run.plan?.steps).toHaveLength(1);
    expect(submitted.run.plan?.steps[0]?.tool).toBe('photoshop.rename_layer');
    // The fast path resolves the target against real state, so it must use the id.
    expect(submitted.run.plan?.steps[0]?.params).toMatchObject({ name: 'Company Logo' });

    const detail = await orchestrator.approve(submitted.run.id);
    expect(detail.run.status).toBe('succeeded');
    expect(detail.verification?.passed).toBe(true);
    expect(detail.verification?.checks).toHaveLength(1);
    expect(detail.diff?.layers[0]).toMatchObject({ name: 'Company Logo', status: 'changed' });
  });

  it('resolves set-opacity and hide through the fast path', async () => {
    const orchestrator = makeOrchestrator();

    const opacity = await run(orchestrator, 'set the Title opacity to 70%');
    expect(opacity.run.status).toBe('succeeded');
    expect(opacity.verification?.passed).toBe(true);

    const hide = await run(orchestrator, 'hide Background');
    expect(hide.run.status).toBe('succeeded');
    expect(hide.verification?.passed).toBe(true);

  });

  it('defers a compound instruction to the planner', async () => {
    const orchestrator = makeOrchestrator();
    const { run: submitted } = await orchestrator.submit({
      sessionId: 'test',
      message: 'hide Background and then export png',
    });
    expect(submitted.route).not.toBe('jev-fast-path');
  });

  it('asks for clarification instead of failing when the intent is ambiguous', async () => {
    const orchestrator = makeOrchestrator();
    const { run: submitted, message } = await orchestrator.submit({
      sessionId: 'test',
      message: 'set opacity to 70%',
    });
    expect(submitted.status).toBe('failed');
    expect(submitted.error?.code).toBe('PLAN_INVALID');
    expect(submitted.error?.recoverable).toBe(true);
    expect(message.length).toBeGreaterThan(10);
  });
});

describe('complex request', () => {
  it('plans, approves, executes, diffs and verifies a square variant', async () => {
    const orchestrator = makeOrchestrator();
    const detail = await run(orchestrator, 'Create a square version of this banner.');

    expect(detail.run.status).toBe('succeeded');
    expect(detail.run.route).toBe('llm');
    expect(detail.run.plan?.steps.length).toBeGreaterThan(5);

    // The original must be untouched: the first step duplicates.
    expect(detail.run.plan?.steps[0]?.tool).toBe('photoshop.duplicate_document');
    expect(detail.run.plan?.steps[1]?.tool).toBe('photoshop.resize_canvas');
    expect(detail.run.plan?.steps.some((s) => s.tool === 'photoshop.export_png')).toBe(true);

    expect(detail.verification?.passed).toBe(true);
    expect(detail.verification?.failedCount).toBe(0);

    // The diff must show the canvas change and the repositioned layers.
    expect(detail.diff?.documentChanges).toEqual(
      expect.arrayContaining([{ property: 'width', before: 1920, after: 1080 }]),
    );
    expect(detail.diff?.summary.changed).toBeGreaterThan(0);

    const executed = detail.run.executedSteps;
    expect(executed.every((step) => step.status === 'succeeded')).toBe(true);
    expect(executed.some((step) => step.tool === 'photoshop.export_png')).toBe(true);
  });

  it('does not report success when a step failed even though verification passed', async () => {
    // Regression: on a real Photoshop run, `duplicate_document` returned a
    // promise instead of a document, so step 1 failed. Verification then passed
    // over the handful of steps that did run, and the run was reported as
    // `succeeded` — with the other twelve steps silently never executed.
    const orchestrator = makeOrchestrator({ maxRepairAttempts: 0 });
    const original = adapter.duplicateDocument.bind(adapter);
    (adapter as unknown as { duplicateDocument: unknown }).duplicateDocument = () => {
      throw new Error('simulated step failure');
    };

    try {
      const detail = await run(orchestrator, 'Create a square version of this banner.');
      expect(detail.run.executedSteps.some((s) => s.status === 'failed')).toBe(true);
      // The never-executed steps must be visible in the error, not just implied
      // by a status that says everything was fine.
      expect(detail.run.status).not.toBe('succeeded');
      expect(detail.run.error?.message).toMatch(/never executed/);
    } finally {
      (adapter as unknown as { duplicateDocument: unknown }).duplicateDocument = original;
    }
  });

  it('groups layers and verifies the new hierarchy', async () => {
    const orchestrator = makeOrchestrator();
    const detail = await run(orchestrator, 'Group the Logo and the Title into a Header');
    expect(detail.run.status).toBe('succeeded');
    expect(detail.verification?.passed).toBe(true);
  });

  it('reports a diff even when nothing changed', async () => {
    const orchestrator = makeOrchestrator();
    const detail = await run(orchestrator, 'hide Background');
    // Hiding an already-hidden layer changes nothing.
    const second = await run(orchestrator, 'hide Background');
    expect(second.run.status).toBe('succeeded');
    expect(detail.run.status).toBe('succeeded');
  });
});

describe('approval, safety and cancellation', () => {
  it('marks destructive steps and requires confirmation', async () => {
    const orchestrator = makeOrchestrator();
    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'delete layer CTA' });

    expect(submitted.requiresConfirmation).toBe(true);
    expect(submitted.status).toBe('awaiting_confirmation');
    expect(submitted.confirmations[0]?.question).toMatch(/Delete layer/);
    expect(submitted.confirmations[0]?.risk).toBe('high');
  });

  it('does not touch the document until the user approves', async () => {
    const orchestrator = makeOrchestrator();
    const before = await adapter.getDocument();
    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'delete layer CTA' });
    const stillThere = await adapter.getDocument();
    expect(stillThere.layers).toHaveLength(before.layers.length);
    expect(submitted.executedSteps).toHaveLength(0);
  });

  it('skips a rejected step and completes the rest', async () => {
    const orchestrator = makeOrchestrator();
    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'export png' });
    const detail = await orchestrator.approve(submitted.id, [{ stepId: 'step-1', approved: false }]);

    expect(detail.run.executedSteps[0]?.status).toBe('rejected');
    // Verification of a rejected step fails, which is correct: nothing happened.
    expect(detail.verification?.passed).toBe(false);
  });

  it('cancels a run that is still awaiting approval', async () => {
    const orchestrator = makeOrchestrator();
    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'export png' });
    const cancelled = orchestrator.cancel(submitted.id);
    expect(cancelled.run.status).toBe('cancelled');
    expect(cancelled.run.error?.code).toBe('CANCELLED');
  });

  it('rejects approving an unknown run', async () => {
    const orchestrator = makeOrchestrator();
    await expect(orchestrator.approve('nope')).rejects.toThrow(/Unknown run/);
  });
});

describe('verification catches a lying tool', () => {
  it('fails when the plan claims a state Photoshop never reached', async () => {
    const orchestrator = makeOrchestrator();

    // A step that reports success but does not move the layer: verification must
    // notice, because it re-reads the document rather than trusting the result.
    const originalMove = adapter.moveLayer.bind(adapter);
    (adapter as unknown as { moveLayer: typeof adapter.moveLayer }).moveLayer = async () => {
      await originalMove({ layerName: 'Title', x: 5, y: 5 });
      return { id: 3, name: 'Title', type: 'text', visible: true, opacity: 100, x: 5, y: 5, width: 100, height: 40, parentId: null };
    };

    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'center the Title' });
    const detail = await orchestrator.approve(submitted.id);

    expect(detail.run.executedSteps[0]?.status).toBe('succeeded');
    expect(detail.verification?.passed).toBe(false);
    expect(detail.verification?.failedCount).toBeGreaterThan(0);
    expect(detail.verification?.checks.some((c) => c.status === 'failed')).toBe(true);

    (adapter as unknown as { moveLayer: typeof adapter.moveLayer }).moveLayer = originalMove;
  });
});

describe('repair loop', () => {
  it('repairs a failed verification and re-verifies', async () => {
    const orchestrator = makeOrchestrator();

    // Fail the first move; the repair re-issues it from the report.
    let calls = 0;
    const originalMove = adapter.moveLayer.bind(adapter);
    (adapter as unknown as { moveLayer: typeof adapter.moveLayer }).moveLayer = async (sel, position) => {
      calls += 1;
      if (calls === 1) {
        // Report a position Photoshop never applied.
        const fake = await originalMove({ layerName: 'Title' }, {});
        return { ...fake, x: 1, y: 1 };
      }
      return originalMove(sel, position);
    };

    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'center the Title' });
    const detail = await orchestrator.approve(submitted.id);

    // One retry, then success: the repair re-issues the *same* coordinates in a
    // single move_layer step rather than replaying a stale snapshot.
    expect(calls).toBe(2);
    expect(detail.run.repairAttempts).toBe(1);
    expect(detail.verification?.passed).toBe(true);
    expect(detail.run.status).toBe('succeeded');
    expect(detail.run.executedSteps.some((step) => step.isRepair)).toBe(true);

    (adapter as unknown as { moveLayer: typeof adapter.moveLayer }).moveLayer = originalMove;
  });

  it('stops after the configured repair budget', async () => {
    const orchestrator = makeOrchestrator({ maxRepairAttempts: 1 });

    const originalMove = adapter.moveLayer.bind(adapter);
    (adapter as unknown as { moveLayer: typeof adapter.moveLayer }).moveLayer = async (sel, position) => {
      const fake = await originalMove({ layerName: 'Title' }, {});
      void sel;
      void position;
      return { ...fake, x: 7, y: 7 };
    };

    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'center the Title' });
    const detail = await orchestrator.approve(submitted.id);

    expect(detail.run.repairAttempts).toBe(1);
    expect(detail.verification?.passed).toBe(false);
    expect(detail.run.status).toBe('failed');

    (adapter as unknown as { moveLayer: typeof adapter.moveLayer }).moveLayer = originalMove;
  });

  it('never enters a repair loop for a non-recoverable failure', async () => {
    const orchestrator = makeOrchestrator();

    // Lock the layer: the operation cannot be performed at all, so re-planning
    // against the same state would only burn the budget.
    const state = await adapter.getDocument();
    const title = state.layers.find((l) => l.name === 'Title')!;
    lockLayer(adapter, title.id, true);

    const { run: submitted } = await orchestrator.submit({ sessionId: 'test', message: 'center the Title' });
    const detail = await orchestrator.approve(submitted.id);

    expect(detail.run.status).toBe('failed');
    expect(detail.run.repairAttempts).toBe(0);
    expect(detail.run.error?.code).toBe('LAYER_LOCKED');
    expect(detail.run.error?.recoverable).toBe(false);

    lockLayer(adapter, title.id, false);
  });
});

describe('history', () => {
  it('records one entry per finished run with the full audit trail', async () => {
    const orchestrator = makeOrchestrator();
    await run(orchestrator, 'rename Logo to Company Logo');

    const records = orchestrator.listHistory();
    const record = records.find((r) => r.goal === 'Rename "Logo" to "Company Logo"');
    expect(record).toBeDefined();
    expect(record?.userRequest).toBe('rename Logo to Company Logo');
    expect(record?.status).toBe('succeeded');
    expect(record?.toolsExecuted).toEqual(['photoshop.rename_layer']);
    expect(record?.plan?.steps).toHaveLength(1);
    expect(record?.verification?.passed).toBe(true);
    expect(record?.diff).not.toBeNull();
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.route).toBe('jev-fast-path');
    expect(record?.errors).toEqual([]);
  });

  it('records a failed step with its error', async () => {
    const orchestrator = makeOrchestrator();
    // First export writes the file; the second refuses to clobber it, which is a
    // recoverable failure the repair loop then tries to work around.
    await run(orchestrator, 'export png');
    const detail = await run(orchestrator, 'export png');

    expect(detail.run.status).toBe('failed');
    const record = orchestrator.listHistory().find((r) => r.id.startsWith(detail.run.id));
    expect(record?.status).toBe('failed');
    expect(record?.errors.map((e) => e.code)).toContain('FILE_EXISTS');
    expect(record?.errors.find((e) => e.code === 'FILE_EXISTS')?.recoverable).toBe(true);
  });

  it('records a clarification as a failed run rather than a silent no-op', async () => {
    const orchestrator = makeOrchestrator();
    await orchestrator.submit({ sessionId: 'test', message: 'set opacity to 70%' });
    const record = orchestrator.listHistory().find((r) => r.userRequest === 'set opacity to 70%');
    expect(record?.status).toBe('failed');
    expect(record?.errors[0]?.code).toBe('PLAN_INVALID');
    expect(record?.plan).toBeNull();
  });

  it('surfaces the planner’s own reason instead of a canned refusal', async () => {
    // A planner asked for something impossible ("сделай салют") answers with an
    // empty plan *and* a note saying which tool is missing. That note used to be
    // appended after a canned sentence that returned first, so it never
    // survived: the user was told the tools could not turn it into a plan and
    // asked which layer to change, when the real answer was that no drawing
    // tool exists at all.
    const orchestrator = makeOrchestrator();
    // A gateway that declines with a reason, standing in for a model that
    // recognises the request is impossible.
    const declining = {
      role: 'planner' as const,
      provider: 'mock' as const,
      model: 'deterministic',
      plan: async () => ({
        goal: 'fireworks',
        steps: [],
        notes: ['There is no tool in the Photoshop set for drawing vector shapes or generating new pixels.'],
      }),
      analyze: async () => ({ text: 'I could not turn that into a plan with the available tools.' }),
      verify: async () => ({ passed: true, reason: 'n/a' }),
    };
    (orchestrator as unknown as { gateways: Record<string, unknown> }).gateways.planner = declining;

    const { message, run } = await orchestrator.submit({ sessionId: 'test', message: 'сделай салют' });

    expect(message).toContain('no tool');
    // The canned text that blamed the tools and asked about layers must not
    // displace the reason.
    expect(message).not.toContain('Which layer');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toContain('no tool');
  });

  it('persists history to disk as JSONL', async () => {
    const orchestrator = makeOrchestrator();
    await run(orchestrator, 'hide Background');
    const { readFileSync } = await import('node:fs');
    const contents = readFileSync(join(dataDir, 'history.jsonl'), 'utf8').trim().split('\n');
    expect(contents.length).toBeGreaterThan(0);
    expect(JSON.parse(contents[contents.length - 1]!)).toMatchObject({ status: expect.any(String) });
  });
});

describe('state', () => {
  it('exposes a snapshot and the tool list', async () => {
    const orchestrator = makeOrchestrator();
    const { snapshot, tools } = await orchestrator.getState();
    expect(snapshot?.document.name).toBe('banner.psd');
    expect(snapshot?.layers).toHaveLength(5);
    expect(tools).toContain('photoshop.resize_canvas');
    expect(tools.length).toBeGreaterThan(20);
  });

  it('reports a disconnected orchestrator state without throwing', async () => {
    const broken = new McpClient({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 500, logger: createLogger({ source: 'orchestrator', level: 'error', console: false }) });
    const config = { ...loadConfig(), mcpUrl: 'http://127.0.0.1:1/mcp', dataDir };
    const orchestrator = new Orchestrator({
      config,
      logger: createLogger({ source: 'orchestrator', level: 'error', console: false }),
      client: broken,
      events: events as never,
    });
    const { snapshot, connection } = await orchestrator.getState();
    expect(snapshot).toBeNull();
    expect(connection.connected).toBe(false);
    expect(connection.lastError).toBeTruthy();
  });
});

/**
 * Mutating tools whose outcome genuinely cannot be derived from their arguments.
 * Each carries a written reason in `expectations.ts`; listing them here means
 * adding a tool to this set is a conscious decision to give up a check.
 */
const NOT_DERIVABLE: Record<string, string> = {
  trim_document: 'the canvas ends up as small as the artwork allows',
  merge_visible_layers: 'the layer count drops by an unknown amount, depending on grouping',
  close_document: 'the check would be that the document is gone, which no property can express',
  set_layer_locking: 'setLocking is accepted but no flag is readable back: layer.locked stays false either way',
  stroke_path: 'the ink is pixels and no snapshot field reports a pixel footprint; the adapter samples the canvas along the path instead, so the proof happens at execution',
  paint_stroke: 'the ink is pixels and no snapshot field reports a pixel footprint; the adapter samples the canvas along the path instead, so the proof happens at execution',
};

/** Read-only tools: there is no post-condition because nothing changed. */
const READ_ONLY = new Set([
  'get_document', 'get_document_info', 'get_layers', 'get_layer', 'get_text_layer', 'get_documents',
  'get_capabilities', 'render_preview', 'sample_color', 'list_fonts', 'list_brushes',
]);

describe('every mutating tool has a mechanical post-condition', () => {
  /**
   * A mutating tool with no expectation is worse than no tool at all: the run
   * reports that the step was verified when nothing was checked. Twenty-three of
   * the forty-seven operations were in that position, so the derived expectations
   * are guarded here against quietly losing another one.
   */
  const SAMPLES: Record<string, unknown> = {
    set_layer_blend_mode: { layerName: 'Logo', mode: 'multiply' },
    set_layer_fill_opacity: { layerName: 'Logo', opacity: 45 },
    rasterize_layer: { layerName: 'Logo' },
    set_text_style: { layerName: 'Headline', tracking: 50, fauxBold: true, paragraphWidth: 400 },
    create_document: { width: 1200, height: 800 },
    set_selection: { x: 0, y: 0, width: 100, height: 100 },
    flatten_document: {},
    convert_color_mode: { mode: 'grayscale' },
    apply_filter: { layerName: 'Logo', filter: 'gaussianBlur', radius: 4 },
    flip_layer: { layerName: 'Logo', axis: 'horizontal' },
    rotate_layer: { layerName: 'Logo', angle: 90 },
    export_png: { path: '/tmp/out.png' },
    export_jpg: { path: '/tmp/out.jpg' },
    export_document: { path: '/tmp/out.webp' },
    save_document: { path: '/tmp/out.psd' },
    save_psd: { path: '/tmp/out.psd' },
    duplicate_document: { name: 'Logo copy' },
    move_layer_to_group: { layer: { layerName: 'Logo' }, group: { layerName: 'Group' } },
    move_layer: { layerName: 'Logo', x: 10, y: 20 },
    update_text_layer: { layerName: 'Headline', text: 'Hi' },
    // The tools that already had checks, kept in the table so the count stays honest.
    create_layer: { name: 'Logo' },
    delete_layer: { layerName: 'Logo' },
    rename_layer: { layerName: 'Logo', name: 'Mark' },
    set_layer_visibility: { layerName: 'Logo', visible: false },
    set_layer_opacity: { layerName: 'Logo', opacity: 50 },
    create_group: { name: 'Group' },
    reorder_layer: { layerName: 'Logo', toIndex: 0 },
    create_text_layer: { name: 'Headline', text: 'Hi' },
    set_text_position: { layerName: 'Headline', x: 10, y: 20 },
    set_text_font_size: { layerName: 'Headline', size: 48 },
    set_text_color: { layerName: 'Headline', color: { r: 255, g: 0, b: 0 } },
    place_image: { path: '/tmp/logo.png' },
    resize_layer: { layerName: 'Logo', width: 200 },
    resize_canvas: { width: 800, height: 600 },
    crop_document: { left: 0, top: 0, right: 400, bottom: 300 },
    modify_selection: { action: 'grow', amount: 4 },
    apply_image: { layerName: 'Logo', sourceName: 'mark.psd' },
    duplicate_layers: { layerName: 'Logo', name: 'Logo copy' },
  };

  it('derives something checkable for each of them', () => {
    const unverified = [...Object.keys(SAMPLES)].filter(
      (op) => deriveExpectations(op as never, SAMPLES[op] as never).length === 0,
    );
    expect(unverified).toEqual([]);
  });

  it('leaves nothing unexplained', () => {
    // Guards the other direction: a tool dropped into the registry that is neither
    // read-only, nor sampled above, nor justified here, would vanish from testing.
    const accounted = new Set([...Object.keys(SAMPLES), ...READ_ONLY, ...Object.keys(NOT_DERIVABLE)]);
    const missing = TOOL_META.map((t) => t.op).filter((op) => !accounted.has(op));
    expect(missing).toEqual([]);
  });

  it('checks the value a blend-mode or fill-opacity step was asked for', () => {
    expect(deriveExpectations('set_layer_blend_mode', { layerName: 'Logo', mode: 'multiply' } as never)).toEqual([
      { kind: 'layer_property', layer: { layerName: 'Logo' }, property: 'blendMode', equals: 'multiply', tolerance: 0 },
    ]);
    expect(deriveExpectations('set_layer_fill_opacity', { layerName: 'Logo', opacity: 45 } as never)).toEqual([
      { kind: 'layer_property', layer: { layerName: 'Logo' }, property: 'fillOpacity', equals: 45, tolerance: 0.6 },
    ]);
  });

  it('checks that an export actually wrote the file it was asked for', () => {
    // An export that wrote nothing, or wrote to the wrong path, otherwise verified clean.
    expect(deriveExpectations('export_png', { path: '/tmp/out.png' } as never)).toEqual([
      { kind: 'file_exists', path: '/tmp/out.png' },
    ]);
  });

  it('checks that a filter or transform left the layer on the canvas', () => {
    // Content pushed out of the frame is otherwise indistinguishable from an edit.
    const expectations = deriveExpectations('apply_filter', {
      layerName: 'Logo',
      filter: 'gaussianBlur',
      radius: 4,
    } as never);
    expect(expectations.map((e) => e.kind)).toEqual(['layer_exists', 'layer_property']);
    expect(expectations[1]).toMatchObject({ property: 'withinCanvas', equals: true });
  });

  it('checks that a selection survived, without inventing its size', () => {
    for (const action of ['grow', 'shrink', 'expand', 'smooth', 'border', 'invert', 'selectAll'] as const) {
      expect(deriveExpectations('modify_selection', { action, amount: 4 } as never)).toEqual([
        { kind: 'document_property', property: 'selectionActive', equals: true, tolerance: 0 },
      ]);
    }
    expect(deriveExpectations('modify_selection', { action: 'deselect' } as never)[0]).toMatchObject({ equals: false });
  });

  it('gives every tool with no derivable post-condition no invented one', () => {
    for (const [op, reason] of Object.entries(NOT_DERIVABLE)) {
      expect(deriveExpectations(op as never, {} as never), `${op}: ${reason}`).toEqual([]);
    }
  });
});
