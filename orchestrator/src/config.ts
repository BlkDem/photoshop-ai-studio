import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { LogBus, env, envBool, envInt, envOptional, parseLogLevel } from '@photoshop-ai-studio/shared/node';

/**
 * Orchestrator configuration.
 *
 * Three independent model roles are configured separately so a deployment can
 * use a strong planner, a vision-capable verifier and a cheap fast model without
 * any provider being hard-coded in business logic (§15).
 */
export type ModelRole = 'planner' | 'vision' | 'fast';

export type ModelProviderId = 'openai' | 'openai-compatible' | 'anthropic' | 'mock';

export interface ModelRoleConfig {
  role: ModelRole;
  provider: ModelProviderId;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

export interface OrchestratorConfig {
  appEnv: string;
  port: number;
  host: string;

  mcpUrl: string;
  /** Extra endpoint of the MCP server's NDJSON log feed, if reachable. */
  mcpEventsUrl: string;
  mcpTimeoutMs: number;

  roles: Record<ModelRole, ModelRoleConfig>;
  temperature: number;
  maxPlanSteps: number;
  maxRepairAttempts: number;

  jevRuntimeUrl: string | undefined;
  jevRuntimeApiKey: string | undefined;
  jevMinConfidence: number;

  dataDir: string;
  logLevel: ReturnType<typeof parseLogLevel>;
  logFile: string | null;
  serveStatic: boolean;
  studioDist: string;
  allowedOrigins: string[];
}

const KNOWN_PROVIDERS: ModelProviderId[] = ['openai', 'openai-compatible', 'anthropic', 'mock'];

function loadRole(role: ModelRole, defaultModel: string): ModelRoleConfig {
  const prefix = `AI_${role.toUpperCase()}`;
  const raw = env(`${prefix}_PROVIDER`, 'mock').trim() as ModelProviderId;
  const provider: ModelProviderId = KNOWN_PROVIDERS.includes(raw) ? raw : 'mock';
  return {
    role,
    provider,
    model: env(`${prefix}_MODEL`, defaultModel),
    apiKey: envOptional(`${prefix}_API_KEY`),
    baseUrl: envOptional(`${prefix}_BASE_URL`),
  };
}

export function loadConfig(): OrchestratorConfig {
  const port = envInt('ORCHESTRATOR_PORT', 3003);
  const mcpPort = envInt('MCP_PORT', 3001);
  const dataDir = resolve(process.cwd(), env('ORCHESTRATOR_DATA_DIR', './data'));
  const studioDist = resolve(process.cwd(), env('STUDIO_DIST', './studio/dist'));
  const logFile = envOptional('LOG_FILE');

  mkdirSync(dataDir, { recursive: true });
  if (logFile) mkdirSync(resolve(logFile, '..'), { recursive: true });

  return {
    appEnv: env('APP_ENV', 'local'),
    port,
    host: env('ORCHESTRATOR_HOST', '127.0.0.1'),
    mcpUrl: env('MCP_URL', `http://127.0.0.1:${mcpPort}/mcp`),
    mcpEventsUrl: env('MCP_EVENTS_URL', `http://127.0.0.1:${mcpPort}/events`),
    mcpTimeoutMs: envInt('MCP_TIMEOUT_MS', 60_000),
    roles: {
      planner: loadRole('planner', 'gpt-4.1'),
      vision: loadRole('vision', 'gpt-4.1'),
      fast: loadRole('fast', 'gpt-4.1-mini'),
    },
    temperature: Number.parseFloat(env('AI_TEMPERATURE', '0.1')) || 0.1,
    maxPlanSteps: envInt('AI_MAX_PLAN_STEPS', 24),
    maxRepairAttempts: envInt('AI_MAX_REPAIR_ATTEMPTS', 2),
    jevRuntimeUrl: envOptional('JEV_RUNTIME_URL'),
    jevRuntimeApiKey: envOptional('JEV_RUNTIME_API_KEY'),
    jevMinConfidence: Number.parseFloat(env('JEV_MIN_CONFIDENCE', '0.82')) || 0.82,
    dataDir,
    logLevel: parseLogLevel(envOptional('LOG_LEVEL'), 'info'),
    logFile: logFile ?? null,
    serveStatic: envBool('SERVE_STATIC', false),
    studioDist,
    allowedOrigins: env('ORCHESTRATOR_ALLOWED_ORIGINS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function createBus(): LogBus {
  return new LogBus();
}
