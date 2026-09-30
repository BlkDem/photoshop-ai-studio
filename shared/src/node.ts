import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { LOG_LEVELS, LOG_LEVEL_VALUE } from './logging.js';
import type { LogEntry, LogInput, LogLevel, LogSource } from './logging.js';

/**
 * Minimal `.env` loader and env accessors.
 *
 * Deliberately dependency-free: the project ships two long-lived Node services
 * and neither needs a dotenv library. Precedence is
 * `process.env` > `.env` file > provided fallback, so container/system
 * environments always win over the checked-out file.
 */
export function loadEnvFile(file = '.env'): Record<string, string> {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile();

export function env(key: string, fallback = ''): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return fallback;
}

export function envOptional(key: string): string | undefined {
  const value = env(key);
  return value === '' ? undefined : value;
}

export function envInt(key: string, fallback: number): number {
  const raw = env(key);
  if (raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBool(key: string, fallback = false): boolean {
  const raw = env(key).toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function envList(key: string, fallback: string[] = []): string[] {
  const raw = env(key);
  if (raw === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value && (LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  return fallback;
}

// ---------------------------------------------------------------------------
// structured logging
// ---------------------------------------------------------------------------

/** Context fields a child logger inherits. `source` is fixed per logger. */
export type LogBindings = Partial<Omit<LogInput, 'source'>>;

export interface LogSink {
  write(entry: LogEntry): void;
}

/**
 * Everything a call site may supply; `source` comes from the logger itself and
 * `event` is inherited from the logger's bindings when omitted.
 */
export type LogFields = LogBindings & { message: string; event?: string };

export interface Logger {
  trace(input: string | LogFields, message?: string): void;
  debug(input: string | LogFields, message?: string): void;
  info(input: string | LogFields, message?: string): void;
  warn(input: string | LogFields, message?: string): void;
  error(input: string | LogFields, message?: string): void;
  /** Level-dispatching call, e.g. to forward a level that came off the wire. */
  log(level: LogLevel, input: string | LogFields, message?: string): void;
  child(bindings: LogBindings): Logger;
  readonly source: LogSource;
  readonly level: LogLevel;
}

/** In-memory ring buffer + fan-out, feeding the Studio LOG tab. */
export class LogBus implements LogSink {
  private readonly ring: LogEntry[] = [];
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  private dropped = 0;

  constructor(private readonly capacity = 1000) {}

  write(entry: LogEntry): void {
    this.ring.push(entry);
    while (this.ring.length > this.capacity) {
      this.ring.shift();
      this.dropped += 1;
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* a broken subscriber must not break logging */
      }
    }
  }

  recent(limit = 200, minLevel: LogLevel = 'trace'): LogEntry[] {
    const threshold = LOG_LEVEL_VALUE[minLevel];
    return this.ring.filter((e) => LOG_LEVEL_VALUE[e.level] >= threshold).slice(-limit);
  }

  subscribe(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class FileSink implements LogSink {
  constructor(private readonly path: string) {}

  write(entry: LogEntry): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      /* logging must never throw */
    }
  }
}

class ConsoleSink implements LogSink {
  constructor(private readonly minLevel: LogLevel) {}

  write(entry: LogEntry): void {
    if (LOG_LEVEL_VALUE[entry.level] < LOG_LEVEL_VALUE[this.minLevel]) return;
    const where = entry.runId ? ` ${entry.runId}` : '';
    const step = entry.stepId ? ` ${entry.stepId}` : '';
    const tool = entry.tool ? ` ${entry.tool}` : '';
    const ms = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
    const prefix = `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}]${where}${step}${tool}`;
    const line = `${prefix} ${entry.event}: ${entry.message}${ms}`;
    if (entry.level === 'error') console.error(line, entry.data ?? '');
    else if (entry.level === 'warn') console.warn(line, entry.data ?? '');
    else console.log(line, entry.data === undefined ? '' : entry.data);
  }
}

export interface CreateLoggerOptions {
  source: LogSource;
  level?: LogLevel;
  bus?: LogBus;
  /** JSONL file to append to. Parent directory must exist. */
  file?: string;
  console?: boolean;
  bindings?: LogBindings;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const level = options.level ?? 'info';
  const sinks: LogSink[] = [];
  if (options.bus) sinks.push(options.bus);
  if (options.file) sinks.push(new FileSink(options.file));
  if (options.console !== false) sinks.push(new ConsoleSink(level));

  const make = (bindings: LogBindings, ownLevel: LogLevel): Logger => {
    const emit = (lvl: LogLevel, input: string | LogFields): void => {
      if (LOG_LEVEL_VALUE[lvl] < LOG_LEVEL_VALUE[ownLevel]) return;
      const normalized: LogFields =
        typeof input === 'string' ? { ...bindings, message: input } : { ...bindings, ...input };
      const entry: LogEntry = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        level: lvl,
        source: options.source,
        event: normalized.event ?? 'log',
        message: normalized.message,
        ...(normalized.data !== undefined ? { data: normalizeData(normalized.data) } : {}),
        ...(normalized.durationMs !== undefined ? { durationMs: normalized.durationMs } : {}),
        ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
        ...(normalized.runId ? { runId: normalized.runId } : {}),
        ...(normalized.stepId ? { stepId: normalized.stepId } : {}),
        ...(normalized.tool ? { tool: normalized.tool } : {}),
      };
      for (const sink of sinks) sink.write(entry);
    };

    return {
      source: options.source,
      level: ownLevel,
      trace: (i) => emit('trace', i),
      debug: (i) => emit('debug', i),
      info: (i) => emit('info', i),
      warn: (i) => emit('warn', i),
      error: (i) => emit('error', i),
      log: (lvl, i) => emit(lvl, i),
      child: (b) => make({ ...bindings, ...b }, ownLevel),
    };
  };

  return make(options.bindings ?? {}, level);
}

/** Strips cycles and non-serialisable values so a bad `data` cannot kill logging. */
function normalizeData(data: unknown): unknown {
  if (data === null || typeof data !== 'object') {
    return typeof data === 'bigint' ? data.toString() : data;
  }
  try {
    return JSON.parse(JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)));
  } catch {
    return '[unserialisable]';
  }
}
