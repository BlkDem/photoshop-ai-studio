import type {
  ChatRequest,
  HistoryRecord,
  Run,
  RunDetail,
  StudioEvent,
  StudioState,
  ToolMeta,
} from '@photoshop-ai-studio/shared';

/**
 * Studio → Orchestrator client.
 *
 * Two channels: a small REST surface for commands and a long-lived NDJSON stream
 * for live updates (log lines, run transitions, diffs, verification). No MCP
 * client, no model credentials, no Photoshop access — the browser sees exactly
 * this surface and nothing else.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError('OFFLINE', `Cannot reach the orchestrator: ${(err as Error).message}`, true);
  }

  const body = (await response.json().catch(() => null)) as
    | { error?: { code: string; message: string; recoverable: boolean } }
    | null;

  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      error?.code ?? 'INTERNAL',
      error?.message ?? `Request failed with ${response.status}`,
      error?.recoverable ?? response.status < 500,
    );
  }
  return body as T;
}

export interface ChatResponseBody {
  run: Run;
  message: string;
}

export const api = {
  state: (): Promise<StudioState> => request<StudioState>('/state'),
  tools: (): Promise<{ tools: ToolMeta[]; mcp: { connected: boolean; url: string; toolCount: number; error: string | null } }> =>
    request('/tools'),
  chat: (payload: ChatRequest): Promise<ChatResponseBody> =>
    request<ChatResponseBody>('/chat', { method: 'POST', body: JSON.stringify(payload) }),
  run: (id: string): Promise<RunDetail> => request<RunDetail>(`/runs/${encodeURIComponent(id)}`),
  runs: (limit = 20): Promise<{ runs: Run[] }> =>
    request<{ runs: Run[] }>(`/runs?limit=${limit}`),
  approve: (
    id: string,
    confirmations: { stepId: string; approved: boolean }[],
    autoApprove = false,
  ): Promise<RunDetail> =>
    request<RunDetail>(`/runs/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ confirmations, autoApprove }),
    }),
  cancel: (id: string): Promise<RunDetail> =>
    request<RunDetail>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  history: (limit = 50): Promise<{ records: HistoryRecord[] }> =>
    request<{ records: HistoryRecord[] }>(`/history?limit=${limit}`),
};

/**
 * Subscribes to the event stream.
 *
 * NDJSON over `fetch` + `ReadableStream` rather than `EventSource`: it needs no
 * framing negotiation, and the orchestrator already speaks that format. Returns
 * an unsubscribe function; the caller owns reconnect policy.
 */
export function subscribeEvents(onEvent: (event: StudioEvent) => void, onError?: (err: Error) => void): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(`${BASE}/events`, {
        signal: controller.signal,
        headers: { accept: 'application/x-ndjson' },
      });
      if (!response.ok || !response.body) throw new Error(`stream returned ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
          if (line.length === 0 || line.startsWith('{"_"')) continue;
          try {
            onEvent(JSON.parse(line) as StudioEvent);
          } catch {
            /* a partial line is not worth failing the stream over */
          }
        }
      }
      if (!controller.signal.aborted) onError?.(new Error('event stream ended'));
    } catch (err) {
      if (!controller.signal.aborted) onError?.(err as Error);
    }
  })();

  return () => controller.abort();
}

export type { ChatRequest };
