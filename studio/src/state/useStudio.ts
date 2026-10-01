import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ChatMessage,
  DocumentDiff,
  DocumentSnapshot,
  HistoryRecord,
  LogEntry,
  Run,
  RunDetail,
  StudioEvent,
  StudioState,
  ToolMeta,
  VerificationResult,
} from '@photoshop-ai-studio/shared';
import { api, subscribeEvents } from '../api/client.js';

const SESSION_ID = 'studio';
const LOG_BUFFER = 800;

export type BottomTab = 'plan' | 'diff' | 'history' | 'log';

export interface StudioSlice {
  state: StudioState | null;
  tools: ToolMeta[];
  snapshot: DocumentSnapshot | null;
  messages: ChatMessage[];
  runs: Record<string, Run>;
  activeRunId: string | null;
  activeRun: Run | null;
  detail: RunDetail | null;
  verification: VerificationResult | null;
  diff: DocumentDiff | null;
  history: HistoryRecord[];
  logs: LogEntry[];
  /** True while the NDJSON event stream is open. */
  connected: boolean;
  busy: boolean;
  error: string | null;
  tab: BottomTab;
}

export interface StudioActions {
  setTab: (tab: BottomTab) => void;
  send: (text: string) => Promise<void>;
  approve: (confirmations: { stepId: string; approved: boolean }[]) => Promise<void>;
  cancel: () => Promise<void>;
  selectRun: (runId: string) => Promise<void>;
  reload: () => Promise<void>;
}

let messageSeq = 0;
const nextId = (): string => `m${Date.now()}-${messageSeq++}`;

/**
 * The single state container for the Studio.
 *
 * Live updates arrive on the NDJSON stream; REST is only used for the initial
 * load and for user commands. Keeping it in one hook means the components stay
 * presentational and the event handling lives in one reviewable block.
 */
export function useStudio(): StudioSlice & StudioActions {
  const [state, setState] = useState<StudioState | null>(null);
  const [tools, setTools] = useState<ToolMeta[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [diff, setDiff] = useState<DocumentDiff | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<BottomTab>('plan');

  const detailRef = useRef<RunDetail | null>(null);

  // --- initial load --------------------------------------------------------

  const refresh = useCallback(async () => {
    try {
      const [nextState, toolList, hist] = await Promise.all([api.state(), api.tools(), api.history(50)]);
      setState(nextState);
      setTools(toolList.tools);
      setHistory(hist.records);
      setError(null);
      setConnected(true);
    } catch (err) {
      setConnected(false);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // --- live events ---------------------------------------------------------

  // The stream outlives any single run, so the event handler must read the
  // current run without the effect depending on it. The ref lives here, in the
  // component body: calling `useRef` inside the effect below is a Rules-of-Hooks
  // violation, and React throws "Invalid hook call" and unmounts the whole app
  // rather than degrading one feature.
  const activeRunRef = useRef(activeRunId);
  useEffect(() => {
    activeRunRef.current = activeRunId;
  });

  useEffect(() => {
    // One long-lived stream for the lifetime of the tab; `handleEvent` is stable
    // because every setter it touches is a React state setter, and `activeRunId`
    // is read through a ref so a changing run does not tear the stream down.
    const handleEvent = (event: StudioEvent): void => {
    switch (event.type) {
      case 'log':
        setLogs((prev) => {
          const next = prev.length >= LOG_BUFFER ? prev.slice(prev.length - LOG_BUFFER + 1) : prev.slice();
          next.push(event.entry);
          return next;
        });
        break;

      case 'connection':
        setState((prev) => (prev ? { ...prev, connection: event.connection } : prev));
        break;

      case 'run': {
        const run = event.run;
        setRuns((prev) => ({ ...prev, [run.id]: run }));
        setActiveRunId((prev) => prev ?? run.id);
        // Reflect the plan the moment it exists so the PLAN tab fills in while
        // the user is still deciding whether to approve.
        setMessages((prev) => upsertPlanMessage(prev, run));
        if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
          void refresh();
        }
        break;
      }

      case 'verification':
        if (event.runId === activeRunRef.current) setVerification(event.verification);
        break;

      case 'diff':
        if (event.runId === activeRunRef.current) setDiff(event.diff);
        break;

      case 'history':
        setHistory((prev) => [event.record, ...prev.filter((r) => r.id !== event.record.id)]);
        break;

      case 'step':
        break;
      }
    };

    let unsubscribe: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const attach = (): void => {
      if (cancelled) return;
      unsubscribe = subscribeEvents(handleEvent, () => {
        setConnected(false);
        if (!cancelled) retry = setTimeout(attach, 3000);
      });
      setConnected(true);
    };

    attach();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      unsubscribe?.();
    };
  }, []);

  // --- actions -------------------------------------------------------------

  const actions = useMemo(
    () => ({
      setTab,

      async send(text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed || busy) return;

        const userMessage: ChatMessage = {
          id: nextId(),
          runId: null,
          role: 'user',
          kind: 'text',
          content: trimmed,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMessage]);
        setBusy(true);
        setError(null);

        try {
          const { run, message } = await api.chat({ sessionId: SESSION_ID, message: trimmed });
          setRuns((prev) => ({ ...prev, [run.id]: run }));
          setActiveRunId(run.id);
          detailRef.current = null;
          setVerification(null);
          setDiff(null);
          setTab('plan');
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              runId: run.id,
              role: 'assistant',
              kind: run.status === 'failed' ? 'error' : 'plan',
              content: message,
              plan: run.plan,
              createdAt: new Date().toISOString(),
            },
          ]);
        } catch (err) {
          setError((err as Error).message);
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              runId: null,
              role: 'assistant',
              kind: 'error',
              content: (err as Error).message,
              createdAt: new Date().toISOString(),
            },
          ]);
        } finally {
          setBusy(false);
        }
      },

      async approve(confirmations: { stepId: string; approved: boolean }[]): Promise<void> {
        if (!activeRunId || busy) return;
        setBusy(true);
        try {
          const detail = await api.approve(activeRunId, confirmations, false);
          detailRef.current = detail;
          setVerification(detail.verification);
          setDiff(detail.diff);
          setRuns((prev) => ({ ...prev, [detail.run.id]: detail.run }));
          setMessages((prev) => appendResult(prev, detail));
          setTab(detail.verification && !detail.verification.passed ? 'plan' : 'diff');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
          void refresh();
        }
      },

      async cancel(): Promise<void> {
        if (!activeRunId || busy) return;
        setBusy(true);
        try {
          const detail = await api.cancel(activeRunId);
          detailRef.current = detail;
          setRuns((prev) => ({ ...prev, [detail.run.id]: detail.run }));
          setMessages((prev) => appendResult(prev, detail));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      },

      async selectRun(runId: string): Promise<void> {
        setActiveRunId(runId);
        try {
          const detail = await api.run(runId);
          detailRef.current = detail;
          setVerification(detail.verification);
          setDiff(detail.diff);
          setMessages((prev) => upsertPlanMessage(prev, detail.run));
        } catch (err) {
          setError((err as Error).message);
        }
      },

      reload: async (): Promise<void> => {
        await refresh();
      },
    }),
    [activeRunId, busy, refresh],
  );

  const activeRun = activeRunId ? runs[activeRunId] ?? null : null;

  return {
    state,
    tools,
    snapshot: state?.snapshot ?? null,
    messages,
    runs,
    activeRunId,
    activeRun,
    detail: detailRef.current,
    verification,
    diff,
    history,
    logs,
    connected,
    busy,
    error,
    tab,
    ...actions,
  };
}

function upsertPlanMessage(messages: ChatMessage[], run: Run): ChatMessage[] {
  const existing = messages.find((m) => m.runId === run.id && m.role === 'assistant');
  if (existing) {
    return messages.map((m) => (m === existing ? { ...m, plan: run.plan } : m));
  }
  return messages;
}

function appendResult(messages: ChatMessage[], detail: RunDetail): ChatMessage[] {
  const run = detail.run;
  const summary: ChatMessage = {
    id: nextId(),
    runId: run.id,
    role: 'assistant',
    kind: 'result',
    content: describeOutcome(run, detail),
    plan: run.plan,
    verification: detail.verification,
    diff: detail.diff,
    createdAt: new Date().toISOString(),
  };
  const withoutPrevious = messages.filter((m) => !(m.runId === run.id && m.kind === 'result'));
  return [...withoutPrevious, summary];
}

function describeOutcome(run: Run, detail: RunDetail): string {
  const verification = detail.verification;
  switch (run.status) {
    case 'succeeded': {
      const checks = verification ? `${verification.checks.filter((c) => c.status === 'passed').length} check(s) verified` : 'executed';
      return `✓ Completed — ${checks}${run.repairAttempts > 0 ? ` after ${run.repairAttempts} repair attempt(s)` : ''}.`;
    }
    case 'cancelled':
      return 'Cancelled. Nothing further was executed.';
    case 'failed':
      return run.error ? `✗ ${run.error.code}: ${run.error.message}` : '✗ Failed.';
    default:
      return `Status: ${run.status}`;
  }
}
