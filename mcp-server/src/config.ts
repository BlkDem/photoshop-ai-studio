import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { env, envBool, envInt, envList, parseLogLevel } from '@photoshop-ai-studio/shared/node';

/**
 * MCP server configuration. Everything external is read from the environment so
 * the same build runs against a real Photoshop, the in-memory mock adapter, or CI.
 */
export interface McpServerConfig {
  appEnv: string;
  /** Streamable HTTP port for MCP clients (Studio dev proxy, Inspector, orchestrator). */
  mcpPort: number;
  /** WebSocket port the UXP plugin dials into. */
  pluginPort: number;
  host: string;
  /** Allowed Host headers — DNS-rebinding guard. */
  allowedHosts: string[];
  allowedOrigins: string[];
  /** Root every filesystem operation is confined to. */
  workspaceRoot: string;
  /** Default destination for exports with no explicit path. */
  outputDir: string;
  /** How long to wait for the plugin to answer one operation. */
  bridgeTimeoutMs: number;
  /** Seconds between pings to keep the plugin socket alive. */
  heartbeatMs: number;
  logLevel: ReturnType<typeof parseLogLevel>;
  logFile: string | null;
  /** `true` runs the in-memory adapter instead of talking to Photoshop. */
  useMockAdapter: boolean;
  /** Auto-load the §29 demo document into the mock adapter. */
  mockDemoDocument: boolean;
}

export function loadMcpConfig(): McpServerConfig {
  const mcpPort = envInt('MCP_PORT', 3001);
  const workspaceRoot = resolve(process.cwd(), env('WORKSPACE_ROOT', './workspace'));
  const outputDir = resolve(workspaceRoot, env('PHOTOSHOP_OUTPUT_DIR', './out').replace(/^\.?\/?(workspace\/)?/, ''));

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  return {
    appEnv: env('APP_ENV', 'local'),
    mcpPort,
    pluginPort: envInt('PLUGIN_PORT', 3002),
    host: env('MCP_HOST', '127.0.0.1'),
    allowedHosts: envList('MCP_ALLOWED_HOSTS', [`127.0.0.1:${mcpPort}`, `localhost:${mcpPort}`]),
    allowedOrigins: envList('MCP_ALLOWED_ORIGINS', []),
    workspaceRoot,
    outputDir,
    bridgeTimeoutMs: envInt('PLUGIN_BRIDGE_TIMEOUT_MS', 30_000),
    heartbeatMs: envInt('PLUGIN_BRIDGE_HEARTBEAT_MS', 20_000),
    logLevel: parseLogLevel(envOptional('LOG_LEVEL'), 'info'),
    logFile: envOptional('LOG_FILE') ?? null,
    useMockAdapter: envBool('MOCK_PHOTOSHOP', false),
    mockDemoDocument: envBool('MOCK_DEMO_DOCUMENT', true),
  };
}

function envOptional(key: string): string | undefined {
  const v = env(key);
  return v === '' ? undefined : v;
}

export const PLUGIN_ROUTE = '/bridge';
