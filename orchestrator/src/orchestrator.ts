import { randomUUID } from 'node:crypto';

import {
  EMPTY_SNAPSHOT,
  StudioException,
  buildSnapshot,
  diffSnapshots,
  formatDiff,
  toStudioError,
  type AdapterConnection,
  type ConfirmationDecision,
  type DocumentDiff,
  type DocumentSnapshot,
  type DocumentState,
  type ExecutedStep,
  type HistoryRecord,
  type ModelProfile,
  type ModelProfileInput,
  type ModelProbe,
  type ModelRef,
  type ModelRoleId,
  type Plan,
  type Run,
  type RunDetail,
  type StudioError,
  type StudioEvent,
  type VerificationResult,
} from '@photoshop-ai-studio/shared';
import type { Logger } from '@photoshop-ai-studio/shared/node';

import { type McpClient } from './mcp/client.js';
import { createGateway } from './gateway/index.js';
import type { ModelGateway } from './gateway/types.js';
import { ModelUnavailableError } from './gateway/types.js';
import { createJevRouter } from './jev/index.js';
import type { JevRouter } from './jev/types.js';
import { buildPlan } from './execution/plan-builder.js';
import { executeStep } from './execution/executor.js';
import { applyDecisions, evaluateSafety, skippedStepRecord } from './execution/safety.js';
import { safeVerify } from './state/verification.js';
import { HistoryStore } from './execution/history.js';
import type { ModelRoleConfig, OrchestratorConfig } from './config.js';
import { ModelStore, registryPath } from './models/registry.js';

/**
 * The Orchestrator (§13).
 *
 * The pipeline is explicit and every stage is observable:
 *
 *     request → intent → plan → validation → approval → execution → diff → verification → (repair) → history
 *
 * Design commitments that shape the code below:
 *
 *  - **The model never executes.** It emits a plan; the plan is validated against
 *    the tool registry; the user approves it; a fixed executor walks it.
 *  - **State is read, not assumed.** The document snapshot is taken before
 *    planning (grounding) and again after execution (verification). A run that
 *    changed nothing fails verification even if every tool reported success.
 *  - **Failures are typed.** Every error carries `recoverable`, and only
 *    recoverable failures enter the repair loop. Non-recoverable ones stop.
 *  - **The loop is bounded.** `AI_MAX_REPAIR_ATTEMPTS`, always.
 */
export interface OrchestratorDeps {
  config: OrchestratorConfig;
  logger: Logger;
  client: McpClient;
  /** Live event fan-out for the Studio (logs, run updates, diffs). */
  events: { publish: (event: StudioEvent) => void };
}

export interface SubmitInput {
  sessionId: string;
  message: string;
  documentId?: string;
}

export interface SubmitResult {
  run: Run;
  /** Short assistant message describing what happens next. */
  message: string;
}

interface RunContext {
  run: Run;
  userRequest: string;
  before: DocumentSnapshot | null;
  after: DocumentSnapshot | null;
  verification: VerificationResult | null;
  diff: DocumentDiff | null;
  producedFiles: string[];
  repairAttempts: number;
  aborted: boolean;
  decisions: Map<string, boolean>;
  autoApprove: boolean;
  /** Set once the run has been persisted to history. */
  recorded: boolean;
}

export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly logger: Logger;
  private readonly client: McpClient;
  private readonly publish: (event: StudioEvent) => void;
  private readonly history: HistoryStore;
  private readonly jev: JevRouter;
  /**
   * Rebuilt whenever the registry changes, so a model added through the Studio
   * takes effect without a restart. Not readonly for that reason: the gateways
   * are exactly as long-lived as the configuration behind them.
   */
  private gateways: Record<'planner' | 'vision' | 'fast', ModelGateway>;
  private readonly models: ModelStore;

  private readonly runs = new Map<string, RunContext>();
  /** Serialises execution: two concurrent mutations in one document is a bug. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.client = deps.client;
    this.publish = deps.events.publish;
    this.history = new HistoryStore(deps.config.dataDir);
    this.jev = createJevRouter(deps.config, deps.logger);
    this.models = new ModelStore(registryPath(deps.config), deps.config.roles);
    this.gateways = this.buildGateways();
    this.logger.info({
      event: 'connection',
      message: 'orchestrator ready',
      data: {
        planner: `${this.gateways.planner.provider}/${this.gateways.planner.model}`,
        jev: this.jev.mode,
        maxRepairAttempts: this.config.maxRepairAttempts,
      },
    });
  }

  // --- model registry ------------------------------------------------------

  /**
   * Resolves the three roles through the registry.
   *
   * A role with no profile falls back to the offline deterministic engine rather
   * than to whatever `.env` happened to say: the registry is what the Studio
   * edits, so once it exists it is the only truth, and silently reverting to the
   * environment would make a removed model come back.
   */
  private buildGateways(): Record<'planner' | 'vision' | 'fast', ModelGateway> {
    const role = (id: ModelRoleId): ModelRoleConfig =>
      this.models.resolveRole(id) ?? {
        role: id,
        provider: 'mock',
        model: 'deterministic',
        apiKey: undefined,
        baseUrl: undefined,
      };
    return {
      planner: createGateway(role('planner'), this.config, this.logger),
      vision: createGateway(role('vision'), this.config, this.logger),
      fast: createGateway(role('fast'), this.config, this.logger),
    };
  }

  listModels(): ReturnType<ModelStore['publicView']> {
    return this.models.publicView();
  }

  addModel(input: ModelProfileInput): ModelProfile {
    const profile = this.models.add(input);
    this.afterRegistryChange(`added model "${profile.label}"`);
    return profile;
  }

  updateModel(id: string, patch: Partial<ModelProfileInput>): ModelProfile {
    const profile = this.models.update(id, patch);
    this.afterRegistryChange(`updated model "${profile.label}"`);
    return profile;
  }

  removeModel(id: string): void {
    this.models.remove(id);
    this.afterRegistryChange(`removed a model`);
  }

  assignModelRole(role: ModelRoleId, profileId: string | null): void {
    this.models.assign(role, profileId);
    this.afterRegistryChange(profileId === null ? `${role} → offline engine` : `assigned ${role}`);
  }

  /**
   * Asks a configured model for a completion and reports what came back.
   *
   * A real call rather than a URL ping: several endpoints answer `/models`
   * happily while rejecting the actual completion, and a probe that only proves
   * the socket opens sends the operator to find that out mid-plan instead.
   */
  async probeModel(id: string): Promise<ModelProbe> {
    const resolved = this.models.resolveProfile(id);
    if (!resolved) throw new StudioException('MODEL_UNAVAILABLE', `No model profile with id "${id}"`, { recoverable: false });

    const gateway = createGateway(resolved, this.config, this.logger);
    const started = Date.now();
    try {
      const { text } = await gateway.analyze({
        userRequest: 'Reply with the single word: ready',
        state: null,
        plan: null,
        diffText: '',
      } as never);
      return { ok: typeof text === 'string' && text.length > 0, detail: String(text).slice(0, 200), latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, detail: (err as Error).message.slice(0, 300), latencyMs: Date.now() - started };
    }
  }

  private afterRegistryChange(message: string): void {
    this.gateways = this.buildGateways();
    this.logger.info({
      event: 'models.changed',
      message,
      data: {
        planner: `${this.gateways.planner.provider}/${this.gateways.planner.model}`,
        vision: `${this.gateways.vision.provider}/${this.gateways.vision.model}`,
        fast: `${this.gateways.fast.provider}/${this.gateways.fast.model}`,
      },
    });
  }

  // --- public API ----------------------------------------------------------

  /** Entry point for `POST /api/chat`. */
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const runId = randomUUID();
    const startedMs = Date.now();
    const run: Run = {
      id: runId,
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      status: 'planning',
      goal: input.message,
      userRequest: input.message,
      route: null,
      plan: null,
      executedSteps: [],
      repairAttempts: 0,
      requiresConfirmation: false,
      confirmations: [],
      error: null,
    };

    const context: RunContext = {
      run,
      userRequest: input.message,
      before: null,
      after: null,
      verification: null,
      diff: null,
      producedFiles: [],
      repairAttempts: 0,
      aborted: false,
      decisions: new Map(),
      autoApprove: false,
      recorded: false,
    };
    this.runs.set(runId, context);

    const log = this.logger.child({ runId, sessionId: input.sessionId });
    log.info({ event: 'ai.request', message: input.message });
    log.info({ event: 'run.start', message: 'starting run' });

    try {
      // --- 1. state first: never plan against assumptions ------------------
      context.before = await this.snapshot(input.documentId);

      // --- 2. intent routing: JEV fast path, then the planner -------------
      const { plan, route, message } = await this.createPlan(input, context);

      if (!plan) {
        // Nothing executable was produced: ask the user instead of pretending.
        run.status = 'failed';
        run.route = route;
        run.error = {
          code: 'PLAN_INVALID',
          message,
          recoverable: true,
        };
        this.finish(context, startedMs);
        return { run, message };
      }

      run.plan = plan;
      run.route = route;
      run.goal = plan.goal;
      run.requiresConfirmation = plan.requiresConfirmation;
      run.confirmations = plan.confirmations;

      log.info({
        event: 'ai.plan',
        message: `plan ready via ${route}: ${plan.steps.length} step(s)`,
        data: { goal: plan.goal, tools: plan.steps.map((s) => s.tool), destructive: plan.steps.filter((s) => s.destructive).map((s) => s.id) },
      });

      const safety = evaluateSafety({ plan, decisions: context.decisions });
      if (plan.requiresConfirmation && safety.pending.length > 0) {
        run.status = 'awaiting_confirmation';
        log.info({
          event: 'safety.confirmation',
          message: `${safety.pending.length} step(s) need confirmation`,
          data: { questions: safety.pending.map((p) => p.question) },
        });
      } else {
        run.status = 'awaiting_approval';
      }
      this.publishRun(context);
      return { run, message };
    } catch (err) {
      const error = this.classify(err);
      run.status = 'failed';
      run.error = error;
      this.finish(context, startedMs);
      log.error({ event: 'error', message: `planning failed: ${error.code}`, data: error });
      this.publishRun(context);
      return {
        run,
        message: `${error.code}: ${error.message}`,
      };
    }
  }

  /** `POST /api/runs/:id/approve` — the user accepted the plan. */
  /**
   * Executes an approved plan.
   *
   * `autoApprove` exists for API callers that have already obtained consent
   * out of band; the Studio always sends explicit per-step decisions.
   */
  async approve(
    runId: string,
    decisions: readonly ConfirmationDecision[] = [],
    options: { autoApprove?: boolean } = {},
  ): Promise<RunDetail> {
    const context = this.mustGet(runId);
    context.autoApprove = options.autoApprove === true;
    if (!context.run.plan) {
      throw new StudioException('PLAN_INVALID', `Run ${runId} has no plan to approve`);
    }
    if (['succeeded', 'failed', 'cancelled'].includes(context.run.status)) {
      throw new StudioException('INVALID_PARAMS', `Run ${runId} already finished with status "${context.run.status}"`);
    }

    for (const decision of decisions) context.decisions.set(decision.stepId, decision.approved);

    const startedMs = Date.now();
    this.publishRun(context);

    const task = this.queue.then(
      () => this.execute(context, startedMs),
      () => this.execute(context, startedMs),
    );
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    await task;

    return this.toDetail(context);
  }

  /** `POST /api/runs/:id/cancel` — cooperative abort. */
  cancel(runId: string): RunDetail {
    const context = this.mustGet(runId);
    if (['succeeded', 'failed', 'cancelled'].includes(context.run.status)) {
      return this.toDetail(context);
    }
    context.aborted = true;
    if (context.run.status === 'awaiting_approval' || context.run.status === 'awaiting_confirmation') {
      context.run.status = 'cancelled';
      context.run.error = { code: 'CANCELLED', message: 'Cancelled by the user before execution', recoverable: true };
      context.run.finishedAt = new Date().toISOString();
      context.recorded = false;
      this.record(context);
      context.recorded = true;
      this.publishRun(context);
      this.logger.info({ event: 'run.end', runId, message: 'run cancelled before execution' });
    }
    return this.toDetail(context);
  }

  getRun(runId: string): RunDetail {
    return this.toDetail(this.mustGet(runId));
  }

  listRuns(limit = 20): Run[] {
    return [...this.runs.values()]
      .slice(-limit)
      .reverse()
      .map((c) => c.run);
  }

  listHistory(limit = 50): HistoryRecord[] {
    return this.history.list(limit);
  }

  /** Current Photoshop state for the Studio's layers tree + header. */
  async getState(documentId?: string): Promise<{ snapshot: DocumentSnapshot | null; connection: AdapterConnection; tools: string[] }> {
    let snapshot: DocumentSnapshot | null = null;
    let connection: AdapterConnection;
    try {
      connection = await this.connection();
      snapshot = await this.snapshot(documentId);
    } catch (err) {
      const error = toStudioError(err);
      this.logger.debug({ event: 'connection', message: `state unavailable: ${error.message}` });
      connection = {
        connected: false,
        pluginId: null,
        pluginVersion: null,
        uxpVersion: null,
        hostApp: null,
        hostVersion: null,
        lastError: error.message,
        connectedAt: null,
        lastLatencyMs: null,
      };
    }
    let tools: string[] = [];
    try {
      tools = (await this.client.listTools()).map((t) => t.tool);
    } catch {
      tools = [];
    }
    return { snapshot, connection, tools };
  }

  async connection(): Promise<AdapterConnection> {
    // A successful `get_document_info` *is* the connectivity probe: it proves
    // the MCP server is up and the adapter is attached to a document.
    await this.client.call('get_document_info', {} as never);
    return {
      connected: true,
      pluginId: null,
      pluginVersion: null,
      uxpVersion: null,
      hostApp: 'Photoshop',
      hostVersion: null,
      lastError: null,
      connectedAt: null,
      lastLatencyMs: null,
    };
  }

  get isRunning(): boolean {
    return [...this.runs.values()].some((c) => c.run.status === 'executing' || c.run.status === 'verifying' || c.run.status === 'repairing');
  }

  get modelRoles(): Record<string, { provider: string; model: string }> {
    return {
      planner: { provider: this.gateways.planner.provider, model: this.gateways.planner.model },
      vision: { provider: this.gateways.vision.provider, model: this.gateways.vision.model },
      fast: { provider: this.gateways.fast.provider, model: this.gateways.fast.model },
    };
  }

  get jevInfo(): { mode: 'deterministic' | 'remote' | 'disabled'; runtimeUrl: string | null } {
    return { mode: this.jev.mode, runtimeUrl: this.jev.runtimeUrl };
  }

  // --- stage: planning -----------------------------------------------------

  private async createPlan(
    input: SubmitInput,
    context: RunContext,
  ): Promise<{ plan: Plan | null; route: Plan['route']; message: string }> {
    const tools = await this.client.listTools();
    const snapshot = context.before;

    // --- JEV fast path (§16) ---------------------------------------------
    const decision = await this.jev.route({ text: input.message, state: snapshot });
    this.logger.info({
      event: 'jev.route',
      message: decision.kind === 'fast' ? `fast path: ${decision.rule} (${decision.confidence.toFixed(2)})` : `deferred to model: ${decision.reason}`,
      data: { kind: decision.kind },
    });

    if (decision.kind === 'fast') {
      const plan = buildPlan({
        draft: decision.draft,
        model: { role: 'jev', provider: this.jev.mode, model: decision.rule },
        route: 'jev-fast-path',
        maxSteps: this.config.maxPlanSteps,
        notes: [`Routed by the JEV fast path (confidence ${decision.confidence.toFixed(2)}).`],
      });
      return { plan, route: 'jev-fast-path', message: this.chatLine(input.message, plan) };
    }

    // --- planner ----------------------------------------------------------
    const draft = await this.gateways.planner.plan({
      userRequest: input.message,
      state: snapshot,
      tools,
    });

    // An empty plan is a legitimate outcome ("which layer did you mean?"), not a
    // crash. Ask the model to phrase the question, fall back to a plain prompt.
    if (draft.steps.length === 0) {
      const clarification = await this.clarify(input.message, snapshot, draft.notes ?? []);
      return { plan: null, route: 'llm', message: clarification };
    }

    const plan = buildPlan({
      draft,
      model: this.modelRef('planner'),
      route: 'llm',
      maxSteps: this.config.maxPlanSteps,
    });
    return { plan, route: 'llm', message: this.chatLine(input.message, plan) };
  }

  /**
   * Turns "I could not plan this" into a question the user can answer.
   *
   * This is the difference between a demo that feels broken and one that feels
   * like an assistant: an ambiguous instruction must come back as a question.
   */
  private async clarify(userRequest: string, state: DocumentSnapshot | null, notes: readonly string[]): Promise<string> {
    // The planner's own explanation leads, because it is the only part that
    // says *why*. It used to be appended after a canned sentence that returned
    // first, so it never survived: asking for a firework came back as "I could
    // not turn that into a plan with the available tools" and "which layer
    // should I change?" — which blames the tools for an impossible request,
    // asks a question about layers when the request was not about layers, and
    // discards the model's actual note that no drawing tool exists.
    const reason = notes.map((n) => n.trim()).filter(Boolean);
    if (reason.length > 0) return reason.join(' ');

    try {
      const { text } = await this.gateways.fast.analyze({
        userRequest,
        state,
        plan: { goal: userRequest, steps: [] },
      });
      if (text.trim()) return text.trim();
    } catch {
      /* the deterministic gateway is the fallback, not an error path */
    }
    const layers = state?.layers.map((l) => `"${l.name}"`).join(', ') ?? 'none';
    return `I could not turn "${userRequest}" into a plan with the available tools. Which layer should I change? Available layers: ${layers}.`;
  }

  private chatLine(userRequest: string, plan: Plan): string {
    try {
      // The fast gateway only shapes the wording; a failure here must not stop
      // the plan, so fall back to a deterministic sentence.
      const destructive = plan.steps.filter((s) => s.destructive).length;
      return [
        `Plan ready for "${userRequest}".`,
        `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}: ${plan.steps.map((s) => s.tool.replace('photoshop.', '')).join(' → ')}.`,
        destructive > 0 ? `${destructive} step${destructive === 1 ? '' : 's'} need your confirmation.` : '',
      ]
        .filter(Boolean)
        .join(' ');
    } catch {
      return `Plan ready: ${plan.steps.length} step(s).`;
    }
  }

  // --- stage: execution ----------------------------------------------------

  private async execute(context: RunContext, startedMs: number): Promise<void> {
    const run = context.run;
    const log = this.logger.child({ runId: run.id, sessionId: run.sessionId });

    const plan = run.plan!;
    const safety = evaluateSafety({
      plan,
      decisions: context.decisions,
      autoApprove: context.autoApprove || (context.decisions.size === 0 && !plan.requiresConfirmation),
    });

    if (!safety.allowed && safety.pending.length > 0) {
      // Confirmation still outstanding — go back to waiting rather than running.
      run.status = 'awaiting_confirmation';
      run.confirmations = safety.pending;
      this.publishRun(context);
      return;
    }

    const { runnable, skipped } = applyDecisions(plan, context.decisions);
    for (const stepId of skipped) {
      const step = plan.steps.find((s) => s.id === stepId)!;
      run.executedSteps.push(skippedStepRecord(step));
    }
    if (safety.rejected.length > 0) {
      log.info({
        event: 'safety.confirmation',
        message: `user rejected ${safety.rejected.length} step(s); continuing with the rest`,
        data: { rejected: safety.rejected },
      });
    }

    run.status = 'executing';
    this.publishRun(context);

    const errors: StudioError[] = [];
    const failedSteps: { step: Plan['steps'][number]; error: StudioError }[] = [];
    const completedTools: string[] = [];

    for (const step of runnable) {
      if (context.aborted) {
        log.warn({ event: 'run.end', message: 'abort requested; stopping before the next step' });
        break;
      }

      const result = await executeStep(step, {
        client: this.client,
        logger: this.logger,
        runId: run.id,
      });
      run.executedSteps.push(result.record);
      context.producedFiles.push(...result.producedFiles);
      this.publish({ type: 'step', runId: run.id, step: result.record });

      if (result.error) {
        errors.push(result.error);
        failedSteps.push({ step, error: result.error });
        // Stop on the first failure: later steps usually depend on earlier ones.
        // Only recoverable errors are worth repairing.
        break;
      }
      completedTools.push(step.tool);
    }

    // --- state after ------------------------------------------------------
    run.status = 'verifying';
    this.publishRun(context);

    try {
      context.after = await this.snapshot();
    } catch (err) {
      const error = toStudioError(err);
      log.warn({ event: 'snapshot', message: `post-run snapshot failed: ${error.message}` });
      context.after = context.before;
    }

    if (context.before && context.after) {
      context.diff = diffSnapshots(context.before, context.after);
      this.publish({ type: 'diff', runId: run.id, diff: context.diff });
      log.info({ event: 'diff', message: formatDiff(context.diff) });
    }

    // --- verification (§17) ----------------------------------------------
    context.verification = await this.verify(context, plan);
    this.publish({ type: 'verification', runId: run.id, verification: context.verification });
    log.info({
      event: 'verification',
      message: context.verification.passed
        ? `verified: ${context.verification.checks.length} check(s) passed`
        : `verification FAILED: ${context.verification.failedCount} check(s)`,
      data: { failed: context.verification.checks.filter((c) => c.status === 'failed').map((c) => c.label) },
    });

    // --- repair loop (§24) ------------------------------------------------
    if (shouldRepair(context.verification, errors) && context.repairAttempts < this.config.maxRepairAttempts) {
      await this.repair(context, failedSteps, errors, completedTools, startedMs);
      return;
    }

    this.settle(context, startedMs, errors);
  }

  private async verify(context: RunContext, plan: Plan): Promise<VerificationResult> {
    const expectations = plan.steps
      .filter((s) => s.expect.length > 0)
      .map((s) => ({ stepId: s.id, expectations: s.expect }));

    const snapshot = context.after ?? context.before ?? EMPTY_SNAPSHOT;

    const deterministic = await safeVerify({
      expectations,
      snapshot,
      readText: async (selector) => {
        try {
          const { data } = await this.client.call('get_text_layer', selector as never);
          return data as never;
        } catch (err) {
          // A text check degrades to "failed" rather than crashing the run; log it
          // so the LOG tab explains *why* the check could not be made.
          this.logger.debug({
            event: 'verification',
            message: `could not read text layer ${JSON.stringify(selector)}: ${(err as Error).message}`,
          });
          return null;
        }
      },
      producedFiles: context.producedFiles,
    });

    // Model commentary is advisory only (§17).
    if (!deterministic.checks.some((c) => c.status === 'skipped')) return deterministic;

    try {
      const modelVerdict = await this.gateways.vision.verify({
        userRequest: context.userRequest,
        goal: plan.goal,
        state: snapshot,
        diffText: context.diff ? formatDiff(context.diff) : '',
        deterministic: {
          passed: deterministic.passed,
          failedCount: deterministic.failedCount,
          summary: deterministic.checks.map((c) => `${c.status === 'passed' ? '✓' : '✗'} ${c.label}`).join('\n'),
        },
      });
      return {
        ...deterministic,
        modelAssisted: true,
        repairHint: modelVerdict.passed ? deterministic.repairHint : `${deterministic.repairHint ?? ''}\nModel review: ${modelVerdict.reason}`,
      };
    } catch (err) {
      this.logger.debug({ event: 'verification', message: `model verification skipped: ${(err as Error).message}` });
      return deterministic;
    }
  }

  // --- stage: repair -------------------------------------------------------

  private async repair(
    context: RunContext,
    failedSteps: { step: Plan['steps'][number]; error: StudioError }[],
    errors: StudioError[],
    completedTools: string[],
    startedMs: number,
  ): Promise<void> {
    const run = context.run;
    const log = this.logger.child({ runId: run.id });
    context.repairAttempts += 1;
    run.repairAttempts = context.repairAttempts;
    run.status = 'repairing';
    this.publishRun(context);

    const hint = [
      context.verification?.repairHint ?? '',
      ...errors.map((e) => `Execution error: ${e.code} — ${e.message}`),
      failedSteps.length > 0 ? `Failed step: ${failedSteps[0]!.step.id} (${failedSteps[0]!.step.tool})` : '',
    ]
      .filter(Boolean)
      .join('\n');

    log.info({
      event: 'ai.repair',
      message: `repair attempt ${context.repairAttempts}/${this.config.maxRepairAttempts}`,
      data: { hint },
    });

    let draft;
    try {
      draft = await this.gateways.planner.plan({
        userRequest: context.userRequest,
        state: context.after ?? context.before,
        tools: await this.client.listTools(),
        repairHint: hint,
        previousErrors: errors,
        completedTools,
      });
    } catch (err) {
      log.error({ event: 'ai.repair', message: `repair planning failed: ${(err as Error).message}` });
      this.settle(context, startedMs, errors);
      return;
    }

    let repairPlan: Plan;
    try {
      repairPlan = buildPlan({
        draft,
        model: this.modelRef('planner'),
        route: 'llm',
        maxSteps: this.config.maxPlanSteps,
        notes: [`Repair attempt ${context.repairAttempts}.`],
      });
    } catch (err) {
      const error = this.classify(err);
      if (error.code === 'PLAN_INVALID' && draft.steps.length === 0) {
        // The planner declined to repair. That is an answer, not a crash: record
        // *why* it declined and let the run settle as a verification failure.
        log.warn({
          event: 'ai.repair',
          message: `planner declined to repair: ${draft.notes?.join(' ') || 'no reason given'}`,
        });
      } else {
        log.error({ event: 'ai.plan_rejected', message: `repair plan rejected: ${error.message}`, data: error });
        errors.push(error);
      }
      this.settle(context, startedMs, errors);
      return;
    }

    if (context.aborted) {
      this.settle(context, startedMs, errors);
      return;
    }

    // Repair steps bypass user approval only when they are non-destructive:
    // asking again for every retry would make the loop unusable, but a repair
    // must never be a way to sneak a deletion past the safety gate.
    const destructive = repairPlan.steps.filter((s) => s.destructive);
    if (destructive.length > 0) {
      run.status = 'awaiting_confirmation';
      run.confirmations = repairPlan.confirmations;
      run.plan = { ...repairPlan, goal: `REPAIR: ${repairPlan.goal}` };
      this.publishRun(context);
      log.warn({
        event: 'safety.confirmation',
        message: 'repair plan contains destructive steps; pausing for confirmation',
        data: { steps: destructive.map((s) => s.id) },
      });
      return;
    }

    run.plan = { ...repairPlan, goal: `REPAIR: ${repairPlan.goal}` };

    for (const step of repairPlan.steps) {
      if (context.aborted) break;
      const result = await executeStep(step, {
        client: this.client,
        logger: this.logger,
        runId: run.id,
        isRepair: true,
      });
      run.executedSteps.push(result.record);
      context.producedFiles.push(...result.producedFiles);
      this.publish({ type: 'step', runId: run.id, step: result.record });
      if (result.error) {
        errors.push(result.error);
        break;
      }
    }

    try {
      context.after = await this.snapshot();
    } catch {
      /* keep the previous snapshot */
    }
    if (context.before && context.after) {
      context.diff = diffSnapshots(context.before, context.after);
      this.publish({ type: 'diff', runId: run.id, diff: context.diff });
    }

    context.verification = await this.verify(context, repairPlan);
    this.publish({ type: 'verification', runId: run.id, verification: context.verification });
    log.info({
      event: 'verification',
      message: context.verification.passed ? 'repair verified' : `repair did not fix it (${context.verification.failedCount} failed)`,
    });

    if (shouldRepair(context.verification, errors) && context.repairAttempts < this.config.maxRepairAttempts) {
      await this.repair(context, [], errors, completedTools, startedMs);
      return;
    }

    this.settle(context, startedMs, errors);
  }

  // --- finalisation --------------------------------------------------------

  private settle(context: RunContext, startedMs: number, errors: StudioError[]): void {
    const run = context.run;
    const verification = context.verification;
    const succeeded = context.verification?.passed ?? false;
    const stepFailures = run.executedSteps.filter((s) => s.status === 'failed');
    // Execution stops at the first failure, so a failed step means everything
    // after it in the plan never ran.
    const neverExecuted = Math.max(0, (run.plan?.steps.length ?? 0) - run.executedSteps.length);

    if (context.aborted) {
      run.status = 'cancelled';
      run.error = { code: 'CANCELLED', message: 'Cancelled by the user', recoverable: true };
    } else if (succeeded && stepFailures.length === 0) {
      run.status = 'succeeded';
    } else {
      run.status = 'failed';
      const reason = errors[0] ?? stepFailures[0]?.error;
      run.error = reason ?? {
        code: 'VERIFICATION_FAILED',
        message: verification?.repairHint ?? 'Verification failed',
        recoverable: true,
      };

      if (neverExecuted > 0) {
        run.error = {
          ...run.error,
          message: `${run.error.message} (${neverExecuted} step(s) never executed)`,
        };
      }

      if (succeeded && stepFailures.length > 0) {
        // Verification passed, but over the steps that did run. Those checks
        // describe a subset of the request, so this is not success — and saying
        // it is is how the tool teaches people to trust a green light that means
        // nothing. A repair that did fix the goal leaves its steps appended to
        // `executedSteps`, so the original failure stays visible here too.
        this.logger.warn({
          event: 'run.end',
          runId: run.id,
          message: 'verification passed after a failed step; reporting failure',
          data: { failed: stepFailures.map((s) => s.stepId), neverExecuted },
        });
      }
    }

    this.finish(context, startedMs);
  }

  private finish(context: RunContext, startedMs: number): void {
    const run = context.run;
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedMs;

    if (!context.recorded) {
      this.record(context);
      context.recorded = true;
    }
    this.publishRun(context);
    this.logger.info({
      event: 'run.end',
      runId: run.id,
      message: `run ${run.status} in ${run.durationMs}ms`,
      durationMs: run.durationMs,
      data: {
        status: run.status,
        steps: run.executedSteps.length,
        repairs: context.repairAttempts,
        verified: context.verification?.passed ?? null,
      },
    });
  }

  private record(context: RunContext): void {
    const run = context.run;
    const status: HistoryRecord['status'] =
      run.status === 'succeeded'
        ? 'succeeded'
        : run.status === 'cancelled'
          ? 'cancelled'
          : run.status === 'failed'
            ? 'failed'
            : 'partially_applied';

    const record: HistoryRecord = {
      id: `${run.id}-${Date.now()}`,
      runId: run.id,
      sessionId: run.sessionId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      userRequest: run.userRequest,
      goal: run.goal,
      plan: run.plan,
      toolsExecuted: run.executedSteps.filter((s) => s.status === 'succeeded').map((s) => s.tool),
      status,
      verification: context.verification,
      diff: context.diff,
      errors: collectErrors(run),
      repairAttempts: context.repairAttempts,
      route: run.route,
    };
    this.history.add(record);
    this.publish({ type: 'history', record });
  }

  // --- helpers -------------------------------------------------------------

  private modelRef(role: 'planner' | 'vision' | 'fast'): ModelRef {
    const gateway = this.gateways[role];
    return { role, provider: gateway.provider, model: gateway.model };
  }

  private async snapshot(documentId?: string): Promise<DocumentSnapshot | null> {
    const { data } = await this.client.call('get_document', { documentId: documentId ?? 'active' } as never);
    const state = data as DocumentState;
    const snapshot = buildSnapshot(state, state.layers);
    this.logger.debug({ event: 'snapshot', message: `captured "${snapshot.document.name}"`, data: { layers: snapshot.layers.length } });
    return snapshot;
  }

  private classify(err: unknown): StudioError {
    if (err instanceof ModelUnavailableError) {
      return { code: 'MODEL_UNAVAILABLE', message: err.message, recoverable: true };
    }
    return toStudioError(err);
  }

  private mustGet(runId: string): RunContext {
    const context = this.runs.get(runId);
    if (!context) throw new StudioException('INVALID_PARAMS', `Unknown run "${runId}"`);
    return context;
  }

  private publishRun(context: RunContext): void {
    this.publish({ type: 'run', run: context.run });
  }

  private toDetail(context: RunContext): RunDetail {
    return {
      run: context.run,
      verification: context.verification,
      diff: context.diff,
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Whether another planning round could plausibly help.
 *
 * A non-recoverable error ends the loop even when verification also failed: the
 * operation never happened (a locked layer, a denied path), so re-planning
 * against the same state would just burn the budget and, worse, tempt the model
 * into trying to route around the restriction.
 */
function shouldRepair(verification: VerificationResult | null, errors: readonly StudioError[]): boolean {
  if (errors.some((error) => !error.recoverable)) return false;
  if (verification && !verification.passed) return true;
  return errors.length > 0;
}

function collectErrors(run: Run): StudioError[] {
  const errors: StudioError[] = [];
  for (const step of run.executedSteps) {
    if (step.error) errors.push(step.error);
  }
  if (run.error) errors.push(run.error);
  return errors;
}

export type { ExecutedStep, DocumentDiff };
