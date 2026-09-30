import * as z from 'zod/v4';

/**
 * Structured logging (§25).
 *
 * Every hop in the pipeline — AI request, plan, tool call, Photoshop request /
 * response, verification, error, timing — emits one of these. The Studio's LOG
 * tab is a straight projection of this stream, and the same records are written
 * to disk as JSONL.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LogLevelSchema = z.enum(LOG_LEVELS);

export const LOG_LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export const LOG_SOURCES = ['studio', 'orchestrator', 'mcp', 'photoshop'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export const LogSourceSchema = z.enum(LOG_SOURCES);

export const LOG_EVENTS = [
  'ai.request',
  'ai.plan',
  'ai.plan_rejected',
  'ai.repair',
  'jev.route',
  'mcp.call',
  'mcp.result',
  'photoshop.request',
  'photoshop.response',
  'snapshot',
  'diff',
  'verification',
  'safety.confirmation',
  'run.start',
  'run.end',
  'bridge.connect',
  'bridge.disconnect',
  'connection',
  'error',
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];
export const LogEventSchema = z.enum(LOG_EVENTS);

export const LogEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  level: LogLevelSchema,
  source: LogSourceSchema,
  event: z.string(),
  message: z.string(),
  /** Structured payload. Must be JSON-serialisable. */
  data: z.unknown().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  tool: z.string().optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export interface LogInput {
  level?: LogLevel;
  source: LogSource;
  event: string;
  message: string;
  data?: unknown;
  durationMs?: number;
  sessionId?: string;
  runId?: string;
  stepId?: string;
  tool?: string;
}
