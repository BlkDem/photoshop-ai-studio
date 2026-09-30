import {
  StudioException,
  opForTool,
  toStudioError,
  type ExecutedStep,
  type PlanStep,
  type StudioError,
} from '@photoshop-ai-studio/shared';
import type { McpClient } from '../mcp/client.js';
import type { Logger } from '@photoshop-ai-studio/shared/node';

/**
 * Executes one plan step against the MCP server.
 *
 * Responsibilities kept deliberately narrow: call, time, classify, log, return.
 * It does not decide whether to continue — that is the run loop's job, because
 * "stop on failure" depends on whether the failure is recoverable.
 */
export interface ExecuteStepOptions {
  client: McpClient;
  logger: Logger;
  runId: string;
  isRepair?: boolean;
  signal?: AbortSignal;
}

export interface ExecuteStepResult {
  record: ExecutedStep;
  error: StudioError | null;
  /** Files the step claims to have written, for `file_exists` verification. */
  producedFiles: string[];
}

export async function executeStep(step: PlanStep, options: ExecuteStepOptions): Promise<ExecuteStepResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const log = options.logger.child({ runId: options.runId, stepId: step.id, tool: step.tool });

  const op = opForTool(step.tool);
  if (!op) {
    const error: StudioError = {
      code: 'UNKNOWN_TOOL',
      message: `"${step.tool}" is not a Photoshop tool`,
      recoverable: false,
    };
    return {
      record: failure(step, startedAt, startedMs, error, false),
      error,
      producedFiles: [],
    };
  }

  try {
    if (options.signal?.aborted) {
      throw new StudioException('CANCELLED', 'Run cancelled before this step started');
    }

    const { data, durationMs } = await options.client.call(op, step.params as never);

    log.info({ event: 'mcp.result', message: `step "${step.id}" ok`, durationMs, data: summarize(data) });

    return {
      record: {
        stepId: step.id,
        tool: step.tool,
        params: step.params,
        ...(step.intent ? { intent: step.intent } : {}),
        status: 'succeeded',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        result: data,
        isRepair: options.isRepair ?? false,
      },
      error: null,
      producedFiles: extractPaths(data),
    };
  } catch (err) {
    const error = toStudioError(err);
    const durationMs = Date.now() - startedMs;
    log.error({
      event: 'error',
      message: `step "${step.id}" failed: ${error.code}`,
      durationMs,
      data: error,
    });
    return {
      record: failure(step, startedAt, startedMs, error, options.isRepair ?? false),
      error,
      producedFiles: [],
    };
  }
}

function failure(
  step: PlanStep,
  startedAt: string,
  startedMs: number,
  error: StudioError,
  isRepair: boolean,
): ExecutedStep {
  return {
    stepId: step.id,
    tool: step.tool,
    params: step.params,
    ...(step.intent ? { intent: step.intent } : {}),
    status: 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    error,
    isRepair,
  };
}

function summarize(data: unknown): unknown {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.layers)) return `${record.layers.length} layers`;
    if ('name' in record) return String(record.name);
  }
  return undefined;
}

/**
 * Pulls filesystem paths out of a tool result.
 *
 * Only paths the tool actually reported are trusted here; `file_exists`
 * verification also probes the filesystem, so this is an accelerator, not the
 * single source of truth.
 */
function extractPaths(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const path = (data as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 ? [path] : [];
}
