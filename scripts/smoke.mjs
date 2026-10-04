/**
 * End-to-end smoke test.
 *
 * Boots the MCP server and the Orchestrator against the in-memory adapter, runs
 * the §29 demo scenario, and asserts the outcome. This is the pipeline the brief
 * calls the definition of done:
 *
 *     User → Studio → Orchestrator → JEV/LLM → MCP → UXP → Photoshop → State → Verification
 *
 * The UXP plugin cannot run here, so the UXP ↔ Photoshop leg is replaced by the
 * mock adapter. Everything either side of it — MCP tools, schemas, safety,
 * planning, diffing, verification, repair — is the real code.
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MCP_PORT = Number(process.env.SMOKE_MCP_PORT ?? 34101);
const PLUGIN_PORT = Number(process.env.SMOKE_PLUGIN_PORT ?? 34102);
const ORCH_PORT = Number(process.env.SMOKE_ORCH_PORT ?? 34103);
const API = `http://127.0.0.1:${ORCH_PORT}/api`;

const processes = [];
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message) {
  console.log(message);
}

function check(label, condition, detail = '') {
  if (condition) {
    log(`  ✓ ${label}`);
  } else {
    failures += 1;
    log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function start(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  processes.push(child);
  return child;
}

async function waitFor(url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

async function api(path, init) {
  const response = await fetch(API + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data ?? {}) });

async function run(message, { approveDestructive = true } = {}) {
  const { run: submitted, message: reply } = await post('/chat', { sessionId: 'smoke', message });
  if (submitted.status === 'failed') return { submitted, detail: null, reply };
  const decisions = (submitted.confirmations ?? []).map((c) => ({
    stepId: c.stepId,
    approved: approveDestructive,
  }));
  const detail = await post(`/runs/${submitted.id}/approve`, { confirmations: decisions, autoApprove: approveDestructive });
  return { submitted, detail, reply };
}

// ---------------------------------------------------------------------------

const workDir = mkdtempSync(join(tmpdir(), 'studio-smoke-'));
const env = {
  MOCK_PHOTOSHOP: 'true',
  MOCK_DEMO_DOCUMENT: 'true',
  LOG_LEVEL: process.env.SMOKE_VERBOSE ? 'debug' : 'error',
  // Pin the planner to the offline gateway. The child processes load `.env`, so
  // without this a developer's real provider leaks in and the assertions below —
  // which expect the deterministic planner's exact 13-step plan — turn into a
  // network test that fails for reasons unrelated to the code.
  AI_PLANNER_PROVIDER: 'mock',
  AI_PLANNER_MODEL: 'deterministic',
  AI_VISION_PROVIDER: 'mock',
  AI_VISION_MODEL: 'deterministic',
  AI_FAST_PROVIDER: 'mock',
  AI_FAST_MODEL: 'deterministic',
  MCP_PORT: String(MCP_PORT),
  PLUGIN_PORT: String(PLUGIN_PORT),
  ORCHESTRATOR_PORT: String(ORCH_PORT),
  WORKSPACE_ROOT: join(workDir, 'workspace'),
  ORCHESTRATOR_DATA_DIR: join(workDir, 'data'),
};

try {
  log('booting the stack against the in-memory adapter…');
  start('mcp', 'mcp-server/dist/index.js', env);
  await waitFor(`http://127.0.0.1:${MCP_PORT}/health`, 'mcp-server');
  start('orchestrator', 'orchestrator/dist/index.js', env);
  await waitFor(`${API}/health`, 'orchestrator');
  log('  ✓ both services ready\n');

  // --- 1. state ----------------------------------------------------------
  log('1. document state');
  const state = await api('/state');
  check('document is open', state.snapshot?.document.name === 'banner.psd', state.snapshot?.document.name);
  check('canvas is 1920×1080', state.snapshot?.document.width === 1920 && state.snapshot?.document.height === 1080);
  check(
    'demo layers present',
    ['Background', 'Logo', 'Title', 'Subtitle', 'CTA'].every((n) => state.snapshot.layers.some((l) => l.name === n)),
  );
  check('MCP tools advertised', state.tools.length >= 30, `${state.tools.length} tools`);
  check('JEV router configured', state.jev.mode === 'deterministic', state.jev.mode);

  // --- 2. fast path ------------------------------------------------------
  log('\n2. JEV fast path — simple request');
  const rename = await run('rename Logo to Company Logo');
  check('routed through the fast path', rename.submitted.route === 'jev-fast-path', rename.submitted.route);
  check('executed', rename.detail?.run.status === 'succeeded', rename.detail?.run.error?.code);
  check('verified', rename.detail?.verification?.passed === true);
  check('diff shows the rename', rename.detail?.diff?.layers.some((l) => l.name === 'Company Logo'));

  log('\n3. safety gate — destructive request');
  const removal = await run('delete layer CTA', { approveDestructive: false });
  check('requires confirmation', removal.submitted.requiresConfirmation === true);
  check('names the layer in the prompt', /Delete layer/.test(removal.submitted.confirmations?.[0]?.question ?? ''));
  check('declined step is recorded as rejected, not executed', removal.detail?.run.executedSteps[0]?.status === 'rejected');
  const afterRefusal = await api('/state');
  check('layer still exists after refusal', afterRefusal.snapshot.layers.some((l) => l.name === 'CTA'));

  // --- 4. the demo -------------------------------------------------------
  log('\n4. the §29 demo — "Create a square version of this banner."');
  const demo = await run('Create a square version of this banner.');
  const plan = demo.submitted.plan;
  check('plan produced', Boolean(plan) && plan.steps.length > 5, `${plan?.steps.length} steps`);
  check('duplicates before resizing', plan?.steps[0]?.tool === 'photoshop.duplicate_document');
  check('resizes the canvas', plan?.steps[1]?.tool === 'photoshop.resize_canvas');
  check('exports', plan?.steps.some((s) => s.tool === 'photoshop.export_png'));
  check('no stale layer ids after a duplicate', plan?.steps.every((s) => s.params.layerId === undefined));
  check('succeeded', demo.detail?.run.status === 'succeeded', demo.detail?.run.error?.message);
  check('verified every check', demo.detail?.verification?.passed === true && demo.detail?.verification?.failedCount === 0);
  check(
    'canvas diff is 1920×1080 → 1080×1080',
    demo.detail?.diff?.documentChanges.some((c) => c.property === 'width' && c.before === 1920 && c.after === 1080),
  );
  check('layers were repositioned', (demo.detail?.diff?.summary.changed ?? 0) > 0);
  check('every executed step succeeded', demo.detail?.run.executedSteps.every((s) => s.status === 'succeeded'));

  // --- 5. history & events ----------------------------------------------
  log('\n5. history and event stream');
  const history = await api('/history');
  check('history recorded the runs', history.records.length >= 3, `${history.records.length} records`);
  check('records carry plans', history.records.some((r) => r.plan?.steps.length));
  check('records carry verification', history.records.some((r) => r.verification));
  check('records carry diffs', history.records.some((r) => r.diff));

  const preview = await api('/preview');
  check('preview renders a real PNG', String(preview?.preview?.base64 ?? '').startsWith('iVBOR'));

  log('\n6. cancellation');
  const pending = await post('/chat', { sessionId: 'smoke', message: 'export png' });
  const cancelled = await post(`/runs/${pending.run.id}/cancel`);
  check('cancelled before execution', cancelled.run.status === 'cancelled', cancelled.run.status);
  check('nothing was executed', cancelled.run.executedSteps.length === 0);
} catch (err) {
  failures += 1;
  log(`\n✗ smoke test aborted: ${err.message}`);
} finally {
  for (const child of processes) child.kill('SIGTERM');
  await sleep(300);
  for (const child of processes) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
}

log('');
if (failures === 0) {
  log('✓ end-to-end smoke test passed');
  process.exit(0);
} else {
  log(`✗ ${failures} check(s) failed`);
  process.exit(1);
}
