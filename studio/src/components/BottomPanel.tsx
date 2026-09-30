import { useState } from 'react';

import { formatDiff, type DocumentDiff, type HistoryRecord, type LogEntry, type Plan, type Run, type VerificationResult } from '@photoshop-ai-studio/shared';
import type { BottomTab } from '../state/useStudio.js';
import { Empty, statusGlyph } from './ProjectPanel.js';

export interface BottomPanelProps {
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
  plan: Plan | null;
  run: Run | null;
  verification: VerificationResult | null;
  diff: DocumentDiff | null;
  history: HistoryRecord[];
  logs: LogEntry[];
  onSelectRun: (runId: string) => void;
  selectedRunId: string | null;
}

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'plan', label: 'PLAN' },
  { id: 'diff', label: 'DIFF' },
  { id: 'history', label: 'HISTORY' },
  { id: 'log', label: 'LOG' },
];

export function BottomPanel(props: BottomPanelProps): React.JSX.Element {
  const counts: Partial<Record<BottomTab, number>> = {
    diff: props.diff ? props.diff.layers.length + props.diff.documentChanges.length : 0,
    history: props.history.length,
    log: props.logs.length,
    plan: props.plan?.steps.length ?? 0,
  };

  return (
    <section className="bottom">
      <nav className="bottom__tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={props.tab === tab.id}
            className={`bottom__tab ${props.tab === tab.id ? 'bottom__tab--active' : ''}`}
            onClick={() => props.onTab(tab.id)}
          >
            {tab.label}
            {counts[tab.id] ? <span className="pill pill--muted">{counts[tab.id]}</span> : null}
          </button>
        ))}
        <span className="bottom__spacer" />
        {props.run ? (
          <span className={`status status--${props.run.status}`}>
            {props.run.status}
            {props.run.durationMs != null ? ` · ${props.run.durationMs} ms` : ''}
            {props.run.repairAttempts > 0 ? ` · ${props.run.repairAttempts} repair` : ''}
          </span>
        ) : null}
      </nav>

      <div className="bottom__body">
        {props.tab === 'plan' ? <PlanTab plan={props.plan} run={props.run} verification={props.verification} /> : null}
        {props.tab === 'diff' ? <DiffTab diff={props.diff} /> : null}
        {props.tab === 'history' ? (
          <HistoryTab history={props.history} onSelectRun={props.onSelectRun} selectedRunId={props.selectedRunId} />
        ) : null}
        {props.tab === 'log' ? <LogTab logs={props.logs} /> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function PlanTab({
  plan,
  run,
  verification,
}: {
  plan: Plan | null;
  run: Run | null;
  verification: VerificationResult | null;
}): React.JSX.Element {
  if (!plan) {
    return <Empty title="No plan yet" body="Send a request in the chat — the plan appears here before anything runs." />;
  }

  const steps = run?.executedSteps ?? [];
  const byId = new Map(steps.map((step) => [step.stepId, step]));

  return (
    <div className="plan">
      <header className="plan__head">
        <div>
          <h3>{plan.goal}</h3>
          {plan.summary ? <p>{plan.summary}</p> : null}
        </div>
        <span className="plan__model">
          {plan.model.provider}/{plan.model.model} · {plan.route}
        </span>
      </header>

      <ol className="plan__steps">
        {plan.steps.map((step, index) => {
          const executed = byId.get(step.id);
          const state = executed?.status ?? (run ? 'pending' : 'idle');
          return (
            <li key={step.id} className={`planstep planstep--${state}`}>
              <span className="planstep__marker" aria-hidden="true">
                {markerFor(state, index)}
              </span>
              <div className="planstep__body">
                <div className="planstep__head">
                  <code>{step.tool.replace('photoshop.', '')}</code>
                  {step.destructive ? <span className="chip chip--danger">destructive</span> : null}
                  {executed?.durationMs != null ? <span className="planstep__time">{executed.durationMs} ms</span> : null}
                </div>
                {step.intent ? <p className="planstep__intent">{step.intent}</p> : null}
                <details className="planstep__params">
                  <summary>params</summary>
                  <pre>{JSON.stringify(step.params, null, 2)}</pre>
                  {step.expect.length > 0 ? (
                    <>
                      <p className="planstep__expectLabel">verifies</p>
                      <ul>
                        {step.expect.map((expectation, i) => (
                          <li key={i}>
                            <code>{expectation.kind}</code> {describeExpectation(expectation)}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </details>
                {executed?.error ? <p className="planstep__error">{executed.error.code}: {executed.error.message}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>

      {verification ? <VerificationSummary verification={verification} /> : null}

      {plan.notes.length > 0 ? (
        <ul className="plan__notes">
          {plan.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function markerFor(state: string, index: number): string {
  switch (state) {
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'rejected':
      return '⊘';
    case 'running':
      return '▸';
    case 'pending':
      return String(index + 1);
    default:
      return '·';
  }
}

function describeExpectation(expectation: { kind: string; [key: string]: unknown }): string {
  const layer = expectation.layer as { layerId?: number; layerName?: string } | undefined;
  const target = layer?.layerId !== undefined ? `#${layer.layerId}` : (layer?.layerName ?? '');
  switch (expectation.kind) {
    case 'layer_exists':
      return `${target} exists`;
    case 'layer_absent':
      return `${target} is gone`;
    case 'layer_property':
      return `${target}.${String(expectation.property)} = ${JSON.stringify(expectation.equals)}`;
    case 'document_property':
      return `document.${String(expectation.property)} = ${JSON.stringify(expectation.equals)}`;
    case 'text_property':
      return `${target}.${String(expectation.property)} = ${JSON.stringify(expectation.equals)}`;
    case 'layer_count':
      return `${String(expectation.equals)} layers`;
    case 'file_exists':
      return `${String(expectation.path)} exists`;
    default:
      return String(expectation.description ?? '');
  }
}

export function VerificationSummary({ verification }: { verification: VerificationResult }): React.JSX.Element {
  const failed = verification.checks.filter((check) => check.status === 'failed');
  const passed = verification.checks.filter((check) => check.status === 'passed');

  return (
    <section className={`verify ${verification.passed ? 'verify--ok' : 'verify--fail'}`}>
      <header>
        <strong>{verification.passed ? '✓ Verified' : `✗ ${verification.failedCount} check(s) failed`}</strong>
        {verification.modelAssisted ? <span className="chip chip--muted">model reviewed</span> : null}
      </header>

      {verification.checks.length === 0 ? (
        <p className="verify__note">
          This plan performed no checkable operations, so verification had nothing to prove. Nothing was silently
          assumed.
        </p>
      ) : (
        <ul className="verify__list">
          {passed.map((check) => (
            <li key={check.id} className="verify__item verify__item--ok">
              <span className="verify__label">{check.label}</span>
              <span className="verify__values">
                expected {String(check.expected)} · actual {String(check.actual)}
              </span>
            </li>
          ))}
          {failed.map((check) => (
            <li key={check.id} className="verify__item verify__item--bad">
              <span className="verify__label">{check.label}</span>
              <span className="verify__values">{check.detail ?? `expected ${String(check.expected)}, got ${String(check.actual)}`}</span>
            </li>
          ))}
        </ul>
      )}

      {verification.repairHint ? <p className="verify__hint">{verification.repairHint}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function DiffTab({ diff }: { diff: DocumentDiff | null }): React.JSX.Element {
  if (!diff) {
    return <Empty title="No diff yet" body="The before/after document diff appears here once a plan has run." />;
  }
  if (!diff.hasChanges) {
    return (
      <div className="empty">
        <h3>No changes</h3>
        <p>The plan executed but the document state is identical to the snapshot taken before it.</p>
      </div>
    );
  }

  return (
    <div className="diff">
      <div className="diff__summary">
        <span className="diff__count diff__count--add">+{diff.summary.added} added</span>
        <span className="diff__count diff__count--chg">~{diff.summary.changed} changed</span>
        <span className="diff__count diff__count--del">−{diff.summary.removed} removed</span>
      </div>

      {diff.documentChanges.length > 0 ? (
        <section className="diff__section">
          <h4>Canvas</h4>
          <ul>
            {diff.documentChanges.map((change) => (
              <li key={change.property}>
                <span className="diff__prop">{change.property}</span>
                <span className="diff__before">{String(change.before ?? '—')}</span>
                <span className="diff__arrow">→</span>
                <span className="diff__after">{String(change.after ?? '—')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="diff__section">
        <h4>Layers</h4>
        {diff.layers.length === 0 ? (
          <p className="diff__none">No layer changed.</p>
        ) : (
          <ul>
            {diff.layers.map((layer) => (
              <li key={`${layer.status}-${layer.id}`} className={`diff__layer diff__layer--${layer.status}`}>
                <span className="diff__glyph">
                  {layer.status === 'added' ? '+' : layer.status === 'removed' ? '−' : '~'}
                </span>
                <span className="diff__name">{layer.name}</span>
                <span className="diff__changes">
                  {layer.changes
                    .map((change) => `${change.property}: ${String(change.before ?? '—')} → ${String(change.after ?? '—')}`)
                    .join(', ') || (layer.status === 'changed' ? 'reordered' : '')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="diff__raw">
        <summary>raw</summary>
        <pre>{formatDiff(diff)}</pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

function HistoryTab({
  history,
  onSelectRun,
  selectedRunId,
}: {
  history: HistoryRecord[];
  onSelectRun: (runId: string) => void;
  selectedRunId: string | null;
}): React.JSX.Element {
  if (history.length === 0) {
    return <Empty title="No history" body="Every AI operation is recorded here: request, plan, tools, result, verification, duration." />;
  }
  return (
    <table className="history">
      <thead>
        <tr>
          <th>Time</th>
          <th>Status</th>
          <th>Request</th>
          <th>Tools</th>
          <th>Verify</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {history.map((record) => (
          <tr
            key={record.id}
            className={record.runId === selectedRunId ? 'history__row history__row--active' : 'history__row'}
            onClick={() => onSelectRun(record.runId)}
          >
            <td className="history__time">{new Date(record.createdAt).toLocaleTimeString()}</td>
            <td>
              <span className={`run__status run__status--${record.status}`}>{statusGlyph(record.status)}</span>{' '}
              {record.status}
            </td>
            <td className="history__request">{record.goal}</td>
            <td className="history__tools">
              {record.toolsExecuted.length > 0 ? record.toolsExecuted.map((tool) => tool.replace('photoshop.', '')).join(', ') : '—'}
              {record.repairAttempts > 0 ? <span className="pill pill--muted">{record.repairAttempts} repair</span> : null}
            </td>
            <td>
              {record.verification ? (
                record.verification.passed ? (
                  <span className="verify-badge verify-badge--ok">{record.verification.checks.length} ✓</span>
                ) : (
                  <span className="verify-badge verify-badge--bad">{record.verification.failedCount} ✗</span>
                )
              ) : (
                '—'
              )}
            </td>
            <td>{record.durationMs != null ? `${record.durationMs} ms` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------

function LogTab({ logs }: { logs: LogEntry[] }): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [minLevel, setMinLevel] = useState<'trace' | 'debug' | 'info' | 'warn' | 'error'>('info');
  const rank = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 } as const;

  const visible = logs.filter((entry) => {
    if (rank[entry.level] < rank[minLevel]) return false;
    if (filter === '') return true;
    const needle = filter.toLowerCase();
    return (
      entry.event.toLowerCase().includes(needle) ||
      entry.message.toLowerCase().includes(needle) ||
      (entry.tool ?? '').toLowerCase().includes(needle) ||
      (entry.source ?? '').includes(needle)
    );
  });

  return (
    <div className="log">
      <div className="log__controls">
        <input
          type="search"
          placeholder="filter (tool, event, message)…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <select value={minLevel} onChange={(event) => setMinLevel(event.target.value as typeof minLevel)}>
          <option value="trace">trace</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
 <option value="error">error</option>
        </select>
        <span className="log__count">
          {visible.length} / {logs.length}
        </span>
      </div>

      <div className="log__list">
        {visible.length === 0 ? (
          <p className="log__empty">Nothing logged at this level yet.</p>
        ) : (
          visible.map((entry) => (
            <div key={entry.id} className={`log__row log__row--${entry.level}`}>
              <span className="log__time">{new Date(entry.ts).toLocaleTimeString()}</span>
              <span className="log__level">{entry.level}</span>
              <span className="log__source">{entry.source}</span>
              <span className="log__event">{entry.event}</span>
              <span className="log__message">
                {entry.message}
                {entry.durationMs !== undefined ? <span className="log__duration"> {entry.durationMs} ms</span> : null}
                {entry.data !== undefined ? <code className="log__data">{compact(entry.data)}</code> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function compact(value: unknown): string {
  const text = typeof value === 'string' ? value : safeJson(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}
