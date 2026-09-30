import { useMemo, useState } from 'react';

import { buildLayerTree, type DocumentSnapshot, type HistoryRecord, type ToolMeta } from '@photoshop-ai-studio/shared';
import type { BottomTab } from '../state/useStudio.js';

export interface ProjectPanelProps {
  snapshot: DocumentSnapshot | null;
  tools: ToolMeta[];
  history: HistoryRecord[];
  onSelectRun: (runId: string) => void;
  selectedRunId: string | null;
}

/**
 * Left rail: what the AI can see and what it has done.
 *
 * The layer tree is rendered from the same normalised snapshot the planner gets,
 * so what the designer sees here is exactly what the model reasoned about.
 */
export function ProjectPanel({
  snapshot,
  tools,
  history,
  onSelectRun,
  selectedRunId,
}: ProjectPanelProps): React.JSX.Element {
  const [section, setSection] = useState<'layers' | 'assets' | 'workflows' | 'tools'>('layers');
  const tree = useMemo(() => (snapshot ? buildLayerTree(snapshot.layers) : []), [snapshot]);

  const destructiveCount = tools.filter((t) => t.destructive).length;

  return (
    <aside className="rail">
      <nav className="rail__tabs" role="tablist">
        {(['layers', 'assets', 'workflows', 'tools'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={`rail__tab ${section === id ? 'rail__tab--active' : ''}`}
            onClick={() => setSection(id)}
          >
            {id === 'layers' ? 'Layers' : id === 'assets' ? 'Assets' : id === 'workflows' ? 'Workflows' : 'Tools'}
            {id === 'layers' && snapshot ? <span className="pill">{snapshot.layers.length}</span> : null}
            {id === 'workflows' && history.length > 0 ? <span className="pill">{history.length}</span> : null}
            {id === 'tools' ? <span className="pill">{tools.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className="rail__body">
        {section === 'layers' ? (
          snapshot && tree.length > 0 ? (
            <ul className="layers">
              {tree.map((node) => (
                <LayerRow key={node.id} node={node} />
              ))}
            </ul>
          ) : (
            <Empty
              title="No layers"
              body={
                snapshot
                  ? 'This document has no layers yet.'
                  : 'Open a document in Photoshop — the plugin connects automatically.'
              }
            />
          )
        ) : null}

        {section === 'assets' ? (
          <Empty
            title="Assets"
            body={
              <span>
                Files under the configured workspace (<code>WORKSPACE_ROOT</code>) are reachable through{' '}
                <code>photoshop.place_image</code>. Nothing else on disk is exposed.
              </span>
            }
          />
        ) : null}

        {section === 'workflows' ? (
          history.length === 0 ? (
            <Empty title="No runs yet" body="Every AI operation is recorded here with its plan, tools and verification." />
          ) : (
            <ul className="runs">
              {history.slice(0, 40).map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    className={`run ${record.runId === selectedRunId ? 'run--active' : ''}`}
                    onClick={() => onSelectRun(record.runId)}
                  >
                    <span className={`run__status run__status--${record.status}`}>{statusGlyph(record.status)}</span>
                    <span className="run__text">
                      <span className="run__goal">{record.goal}</span>
                      <span className="run__meta">
                        {new Date(record.createdAt).toLocaleTimeString()} · {record.toolsExecuted.length} tool(s)
                        {record.repairAttempts > 0 ? ` · ${record.repairAttempts} repair` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {section === 'tools' ? (
          <div className="tools">
            <p className="tools__summary">
              {tools.length} MCP tools exposed · {destructiveCount} destructive
            </p>
            <ul className="tools__list">
              {tools.map((tool) => (
                <li key={tool.tool} className={tool.destructive ? 'tool tool--destructive' : 'tool'}>
                  <code>{tool.tool.replace('photoshop.', '')}</code>
                  <span className="tool__title">{tool.title}</span>
                  {tool.requiresConfirmation ? <span className="chip chip--warn">confirm</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

interface LayerRowProps {
  node: ReturnType<typeof buildLayerTree>[number];
}

function LayerRow({ node }: LayerRowProps): React.JSX.Element {
  return (
    <>
      <li className={`layer ${node.visible ? '' : 'layer--hidden'}`} style={{ paddingLeft: `${8 + node.depth * 14}px` }}>
        <span className={`layer__icon layer__icon--${node.type}`} aria-hidden="true" />
        <span className="layer__name" title={node.name}>
          {node.name}
        </span>
        {node.opacity < 100 ? <span className="layer__opacity">{Math.round(node.opacity)}%</span> : null}
        <span className="layer__size">
          {Math.round(node.width)}×{Math.round(node.height)}
        </span>
      </li>
      {node.childLayers.length > 0
        ? node.childLayers.map((child) => <LayerRow key={child.id} node={child} />)
        : null}
    </>
  );
}

export function Empty({ title, body }: { title: string; body: React.ReactNode }): React.JSX.Element {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

export function statusGlyph(status: HistoryRecord['status']): string {
  switch (status) {
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'cancelled':
      return '⊘';
    default:
      return '◐';
  }
}

export type { BottomTab };
