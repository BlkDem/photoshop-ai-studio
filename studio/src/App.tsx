import { useCallback, useEffect, useState } from 'react';

import { useStudio } from './state/useStudio.js';
import { Header } from './components/Header.js';
import { ProjectPanel } from './components/ProjectPanel.js';
import { Preview } from './components/Preview.js';
import { Chat } from './components/Chat.js';
import { BottomPanel } from './components/BottomPanel.js';
import { ModelsPanel } from './components/ModelsPanel.js';
import './styles/app.css';

/**
 * Studio shell — the layout from the brief (§19).
 *
 *   ┌───────────────────────────────────────────────────┐
 *   │ header: title · connection · model · JEV          │
 *   ├────────┬──────────────────────────┬───────────────┤
 *   │ rail   │ preview                  │ chat          │
 *   ├────────┴──────────────────────────┴───────────────┤
 *   │ PLAN │ DIFF │ HISTORY │ LOG                       │
 *   └───────────────────────────────────────────────────┘
 */
export function App(): React.JSX.Element {
  const studio = useStudio();
  const [preview, setPreview] = useState<{ base64: string; mimeType: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);

  const loadPreview = useCallback(async () => {
    // The preview render is a Photoshop round trip, so it is fetched explicitly
    // rather than on every state refresh.
    setPreviewLoading(true);
    try {
      const response = await fetch('/api/preview', { headers: { accept: 'application/json' } });
      if (response.ok) {
        const body = (await response.json()) as { preview: { base64: string; mimeType: string } | null };
        setPreview(body.preview);
      }
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const snapshot = studio.snapshot;

  useEffect(() => {
    if (!snapshot) {
      setPreview(null);
      return;
    }
    void loadPreview();
  }, [snapshot, loadPreview]);

  const canvas = snapshot ? `${Math.round(snapshot.document.width)}×${Math.round(snapshot.document.height)}` : null;

  return (
    <div className="app">
      <Header
        connection={studio.state?.connection ?? null}
        streamConnected={studio.connected}
        documentName={snapshot?.document.name ?? null}
        canvas={canvas}
        model={studio.state?.model ?? null}
        jev={studio.state?.jev ?? null}
        onReload={() => {
          void studio.reload();
          void loadPreview();
        }}
        onOpenModels={() => setModelsOpen(true)}
      />

      {!studio.connected ? (
        <div className="banner banner--error">
          The orchestrator is not reachable on <code>/api</code>. Start it with <code>npm run dev:orchestrator</code>.
          {studio.error ? <span className="banner__detail">{studio.error}</span> : null}
        </div>
      ) : null}

      {studio.state && !studio.state.connection.connected && !studio.state.tools.length ? null : null}

      <div className="app__main">
        <ProjectPanel
          snapshot={snapshot}
          tools={studio.tools}
          history={studio.history}
          onSelectRun={(runId) => void studio.selectRun(runId)}
          selectedRunId={studio.activeRunId}
        />

        <Preview snapshot={snapshot} image={preview} loading={previewLoading} />

        <Chat
          messages={studio.messages}
          run={studio.activeRun}
          busy={studio.busy}
          onSend={(text) => void studio.send(text)}
          onApprove={(decisions) => void studio.approve(decisions)}
          onCancel={() => void studio.cancel()}
        />
      </div>

      <BottomPanel
        tab={studio.tab}
        onTab={studio.setTab}
        plan={studio.activeRun?.plan ?? null}
        run={studio.activeRun}
        verification={studio.verification}
        diff={studio.diff}
        history={studio.history}
        logs={studio.logs}
        onSelectRun={(runId) => void studio.selectRun(runId)}
        selectedRunId={studio.activeRunId}
      />

      {modelsOpen ? <ModelsPanel onClose={() => setModelsOpen(false)} /> : null}
    </div>
  );
}
