import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  BRIDGE_PROTOCOL_VERSION,
  UNKNOWN_CONNECTION,
  StudioException,
  decodeMessage,
  encodeRequest,
  type AdapterConnection,
  type BridgeRequest,
  type PluginHelloPayload,
} from '@photoshop-ai-studio/shared';
import type { Logger } from '@photoshop-ai-studio/shared/node';
import { PLUGIN_ROUTE } from '../config.js';

/**
 * MCP Server ↔ UXP Plugin bridge.
 *
 * Responsibilities:
 *  - accept the plugin's outbound WebSocket (UXP cannot listen — ADR-001)
 *  - correlate `op` requests with `op.result` replies
 *  - **serialise** operations: Photoshop mutations must run inside one modal
 *    scope, so two overlapping ops would corrupt document state
 *  - time out cleanly and surface `NOT_CONNECTED` instead of hanging
 */
export interface PluginBridgeOptions {
  port: number;
  host: string;
  timeoutMs: number;
  heartbeatMs: number;
  logger: Logger;
}

export interface BridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type Pending = {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
};

export type PluginLogEvent = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
};

export interface PluginBridgeEvents {
  connect: [connection: AdapterConnection];
  disconnect: [connection: AdapterConnection];
  log: [entry: PluginLogEvent];
}

export class PluginBridge {
  /** Narrow, typed event bus — the plugin's lifecycle is a closed set of events. */
  private readonly emitter = new EventEmitter();
  private readonly logger: Logger;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private hello: PluginHelloPayload | null = null;
  private connectedAt: string | null = null;
  private lastLatencyMs: number | null = null;
  private lastError: string | null = null;

  private readonly pending = new Map<string, Pending>();
  /** Tail of the serialisation chain. Every op links onto it. */
  private queue: Promise<unknown> = Promise.resolve();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly options: PluginBridgeOptions) {
    this.logger = options.logger.child({});
  }

  on<K extends keyof PluginBridgeEvents>(event: K, listener: (...args: PluginBridgeEvents[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  private emit<K extends keyof PluginBridgeEvents>(event: K, ...args: PluginBridgeEvents[K]): void {
    this.emitter.emit(event, ...args);
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.wss) return;

    // Bound without a host on purpose, so Node listens on `::` with IPv4-mapped
    // addresses in and the socket answers on both families.
    //
    // This matters because `localhost` resolves to `::1` before `127.0.0.1` on some
    // hosts, and the plugin has to dial `localhost` — UXP's manifest parser
    // discards IP-literal hosts before permission matching (ADR-001), so `localhost`
    // is the only address the plugin may use. Dual-stack means that name cannot
    // resolve to a family nothing is listening on.
    const bindHost = this.options.host === '0.0.0.0' || this.options.host === '::' ? undefined : this.options.host;
    this.wss = new WebSocketServer({ port: this.options.port, host: bindHost, path: PLUGIN_ROUTE });
    this.wss.on('listening', () => {
      this.logger.info(
        'bridge.connect',
        `UXP bridge listening on ws://${this.options.host}:${this.options.port}${PLUGIN_ROUTE} (dual-stack)`,
      );
    });
    this.wss.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error({ event: 'bridge.connect', message: 'WebSocket server error', data: { error: err.message } });
    });
    this.wss.on('connection', (socket) => this.accept(socket));
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new StudioException('TIMEOUT', `Bridge shut down while "${entry.op}" was in flight`));
    }
    this.pending.clear();
    this.socket?.close(1001, 'server shutting down');
    this.socket = null;
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }

  private accept(socket: WebSocket): void {
    // Only one Photoshop session may be attached at a time; a new one wins
    // because the old plugin belongs to a stale Photoshop process.
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this.logger.warn('bridge.connect', 'Replacing an existing plugin connection');
      this.socket.close(1000, 'replaced by a newer plugin');
    }

    this.socket = socket;
    this.hello = null;
    this.lastError = null;
    this.logger.info('bridge.connect', 'Plugin socket opened, waiting for hello');

    socket.on('message', (raw) => this.onMessage(raw.toString()));
    socket.on('close', (code, reason) => this.onClose(code, reason.toString()));
    socket.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error({ event: 'bridge.disconnect', message: 'Plugin socket error', data: { error: err.message } });
    });
  }

  private onClose(code: number, reason: string): void {
    this.socket = null;
    this.hello = null;
    this.connectedAt = null;
    const connection = this.getConnection();
    this.logger.warn({ event: 'bridge.disconnect', message: `Plugin disconnected (${code}) ${reason}`.trim(), data: { code, reason } });
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new StudioException('NOT_CONNECTED', `Photoshop disconnected during "${entry.op}"`));
      this.pending.delete(id);
    }
    this.emit('disconnect', connection);
  }

  private onMessage(raw: string): void {
    const decoded = decodeMessage(raw);
    if (!decoded.ok) {
      this.logger.warn({ event: 'bridge.disconnect', message: 'Dropped malformed frame', data: { reason: decoded.reason } });
      return;
    }
    const message = decoded.message;

    switch (message.type) {
      case 'hello': {
        this.hello = message.payload;
        this.connectedAt = new Date().toISOString();
        this.logger.info({
          event: 'photoshop.request',
          message: `Connected to ${message.payload.hostApp} ${message.payload.hostVersion} (UXP ${message.payload.uxpVersion})`,
          data: {
            pluginId: message.payload.pluginId,
            pluginVersion: message.payload.pluginVersion,
            // Logged because it is the only way to tell the running plugin from the
            // code on disk. Photoshop caches a loaded plugin, so reinstalling a build
            // does not change the one in memory, and nothing else says so: a fix that
            // "did not work" is otherwise indistinguishable from a fix that was never
            // loaded. Compare this with `scripts/check-plugin-build.mjs`.
            buildId: message.payload.buildId,
            workspaceRoot: message.payload.config?.workspaceRoot,
            outputDir: message.payload.config?.outputDir,
            configError: message.payload.config?.error,
          },
        });
        if (message.payload.buildId) {
          this.logger.info({
            event: 'photoshop.request',
            message: `plugin build ${message.payload.buildId}`,
            data: { buildId: message.payload.buildId },
          });
        }
        if (!message.payload.config?.workspaceRoot) {
          // The single most common cross-OS failure: paths arrive workspace-relative
          // and the plugin cannot resolve them without a root.
          this.logger.warn(
            'the plugin reported no workspaceRoot; every filesystem operation will fail. Set it in photoshop-plugin/config.json',
          );
        }
        this.emit('connect', this.getConnection());
        return;
      }
      case 'op.result': {
        const entry = this.pending.get(message.id);
        if (!entry) {
          this.logger.warn({ event: 'photoshop.response', message: `Result for unknown request ${message.id}` });
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        this.lastLatencyMs = Date.now() - entry.startedAt;
        if (message.result.success) entry.resolve(message.result.data);
        else {
          entry.reject(
            new StudioException(message.result.error.code, message.result.error.message, {
              recoverable: message.result.error.recoverable,
              details: message.result.error.details,
              photoshopCode: message.result.error.photoshopCode,
            }),
          );
        }
        return;
      }
      case 'log': {
        const { level, message: text, data } = message.payload;
        const forwarded = { level, message: text, data };
        this.emit('log', forwarded);
        this.logger.log(level, { event: 'photoshop.response', message: text, data });
        return;
      }
      case 'state.changed': {
        this.logger.info({
          event: 'photoshop.response',
          message: `Document state changed in Photoshop (${message.reason})`,
          data: { documentId: message.documentId },
        });
        return;
      }
      case 'pong': {
        this.lastLatencyMs = Date.now() - (this.lastPingAt ?? Date.now());
        return;
      }
      default:
        return;
    }
  }

  private lastPingAt: number | null = null;

  // --- operations ----------------------------------------------------------

  /**
   * Sends one operation to Photoshop and waits for its result.
   *
   * Operations are queued, never concurrent: `executeAsModal` is exclusive and
   * a second overlapping mutation would either throw `number == 9` or silently
   * corrupt the layer stack.
   */
  request<K extends string>(op: K, params: unknown, options: BridgeRequestOptions = {}): Promise<unknown> {
    const run = this.queue.then(
      () => this.dispatch(op, params, options),
      () => this.dispatch(op, params, options),
    );
    // Keep the chain alive regardless of individual failures.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private dispatch(op: string, params: unknown, options: BridgeRequestOptions): Promise<unknown> {
    if (!this.isConnected()) {
      return Promise.reject(
        new StudioException('NOT_CONNECTED', `Cannot run "${op}": the Photoshop AI Studio plugin is not connected`, {
          details: { expected: `ws://127.0.0.1:${this.options.port}${PLUGIN_ROUTE}` },
        }),
      );
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      return Promise.reject(new StudioException('NOT_CONNECTED', `Bridge socket is not open for "${op}"`));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new StudioException('CANCELLED', `"${op}" cancelled before dispatch`));
    }

    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const frame: BridgeRequest = { v: BRIDGE_PROTOCOL_VERSION, type: 'op', id, op, params } as BridgeRequest;

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.lastError = `"${op}" timed out after ${timeoutMs}ms`;
        rejectPromise(new StudioException('TIMEOUT', `Photoshop did not answer "${op}" within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        op,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        startedAt: Date.now(),
      });

      options.signal?.addEventListener(
        'abort',
        () => {
          const entry = this.pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          try {
            socket.send(encodeRequest({ v: BRIDGE_PROTOCOL_VERSION, type: 'cancel', id, reason: 'client aborted' }));
          } catch {
            /* best effort */
          }
          rejectPromise(new StudioException('CANCELLED', `"${op}" aborted by the client`));
        },
        { once: true },
      );

      try {
        socket.send(encodeRequest(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(new StudioException('NOT_CONNECTED', `Failed to send "${op}": ${(err as Error).message}`));
      }
    });
  }

  // --- state ---------------------------------------------------------------

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN && this.hello !== null;
  }

  getConnection(): AdapterConnection {
    if (!this.isConnected() || !this.hello) {
      return { ...UNKNOWN_CONNECTION, lastError: this.lastError };
    }
    return {
      connected: true,
      pluginId: this.hello.pluginId,
      pluginVersion: this.hello.pluginVersion,
      uxpVersion: this.hello.uxpVersion,
      hostApp: this.hello.hostApp,
      hostVersion: this.hello.hostVersion,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      lastLatencyMs: this.lastLatencyMs,
    };
  }

  getHello(): PluginHelloPayload | null {
    return this.hello;
  }

  private startHeartbeat(): void {
    if (this.options.heartbeatMs <= 0 || this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (!this.isConnected()) return;
      this.lastPingAt = Date.now();
      const socket = this.socket;
      if (!socket) return;
      try {
        socket.send(encodeRequest({ v: BRIDGE_PROTOCOL_VERSION, type: 'ping', id: `ping-${this.lastPingAt}` }));
      } catch {
        /* the close handler will clean up */
      }
    }, this.options.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
