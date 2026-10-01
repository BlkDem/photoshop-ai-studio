import type { AdapterConnection, ModelRoles } from '@photoshop-ai-studio/shared';

export interface HeaderProps {
  connection: AdapterConnection | null;
  streamConnected: boolean;
  documentName: string | null;
  canvas: string | null;
  model: ModelRoles | null;
  jev: { mode: string; runtimeUrl: string | null } | null;
  onReload: () => void;
  onOpenModels: () => void;
}

/**
 * Top bar. The connection dot reports the state of the *whole* pipeline, which
 * is two hops: the browser's event stream, and the MCP server's link to the UXP
 * plugin inside Photoshop.
 */
export function Header({
  connection,
  streamConnected,
  documentName,
  canvas,
  model,
  jev,
  onReload,
  onOpenModels,
}: HeaderProps): React.JSX.Element {
  const photoshopConnected = connection?.connected === true;
  const label = !streamConnected
    ? 'Orchestrator offline'
    : photoshopConnected
      ? 'Connected'
      : 'Photoshop not connected';

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__logo" aria-hidden="true" />
        <h1>Photoshop AI Studio</h1>
        <span className={`dot ${dotClass(streamConnected, photoshopConnected)}`} role="status" aria-live="polite">
          {label}
        </span>
      </div>

      <div className="app-header__meta">
        {documentName ? (
          <span className="meta">
            <strong>{documentName}</strong>
            {canvas ? <span className="meta__dim">{canvas}</span> : null}
          </span>
        ) : (
          <span className="meta meta__dim">no document</span>
        )}

        {model ? (
          <button type="button" className="meta meta__dim meta--button" title="Add, remove and route models" onClick={onOpenModels}>
            {model.planner.provider}/{model.planner.model}
          </button>
        ) : null}

        {jev ? <span className="meta meta__dim">JEV: {jev.mode}</span> : null}

        {connection?.hostVersion ? (
          <span className="meta meta__dim" title="Photoshop / UXP versions reported by the plugin">
            PS {connection.hostVersion} · UXP {connection.uxpVersion}
          </span>
        ) : null}

        {connection?.lastLatencyMs != null ? (
          <span className="meta meta__dim">{connection.lastLatencyMs} ms</span>
        ) : null}

        <button type="button" className="btn btn--ghost" onClick={onReload} title="Re-read the document state">
          Refresh
        </button>
      </div>
    </header>
  );
}

function dotClass(stream: boolean, photoshop: boolean): string {
  if (!stream) return 'dot--error';
  return photoshop ? 'dot--ok' : 'dot--warn';
}
