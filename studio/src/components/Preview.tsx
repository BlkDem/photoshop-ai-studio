import { useEffect, useRef, useState } from 'react';

import type { DocumentSnapshot } from '@photoshop-ai-studio/shared';

export interface PreviewProps {
  snapshot: DocumentSnapshot | null;
  /** Preview PNG from the MCP layer, base64-encoded. */
  image: { base64: string; mimeType: string } | null;
  loading: boolean;
}

/**
 * Centre pane: what the document currently looks like.
 *
 * The preview is a real render when the plugin can provide one; otherwise this is
 * an honest schematic — a to-scale layer plot — so the pane is never blank and
 * never implies more fidelity than it has.
 */
export function Preview({ snapshot, image, loading }: PreviewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.max(240, entry.contentRect.width - 32));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!snapshot) {
    return (
      <section className="preview preview--empty">
        <div className="empty">
          <h3>No document</h3>
          <p>
            Open a document in Photoshop. The AI Studio plugin connects to the MCP server on its own — press{' '}
            <strong>Connect</strong> in the panel if it does not.
          </p>
        </div>
      </section>
    );
  }

  const { width: canvasWidth, height: canvasHeight } = snapshot.document;
  const ratio = canvasWidth > 0 ? canvasHeight / canvasWidth : 0.75;
  const boxWidth = Math.min(width, canvasWidth);
  const boxHeight = boxWidth * ratio;

  return (
    <section className="preview" ref={containerRef}>
      <div className="preview__stage">
        <div className="preview__frame" style={{ width: boxWidth, height: boxHeight }}>
          {image ? (
            <img
              className="preview__image"
              src={`data:${image.mimeType};base64,${image.base64}`}
              alt={`Rendered preview of ${snapshot.document.name}`}
            />
          ) : (
            <Schematic snapshot={snapshot} width={canvasWidth} height={canvasHeight} />
          )}
        </div>
        {loading ? <div className="preview__loading">rendering…</div> : null}
      </div>

      <footer className="preview__caption">
        <span>
          {snapshot.document.name} · {Math.round(canvasWidth)}×{Math.round(canvasHeight)} ·{' '}
          {snapshot.document.resolution} ppi · {snapshot.document.colorMode}
        </span>
        <span className="preview__dirty">{snapshot.document.saved === false ? 'unsaved changes' : 'saved'}</span>
      </footer>
    </section>
  );
}

function Schematic({
  snapshot,
  width,
  height,
}: {
  snapshot: DocumentSnapshot;
  width: number;
  height: number;
}): React.JSX.Element {
  const layers = [...snapshot.layers].reverse();
  return (
    <div className="schematic" aria-label="Layer bounds schematic">
      {layers.map((layer) => {
        if (layer.width <= 0 || layer.height <= 0) return null;
        const left = (layer.x / width) * 100;
        const top = (layer.y / height) * 100;
        const w = (layer.width / width) * 100;
        const h = (layer.height / height) * 100;
        return (
          <div
            key={layer.id}
            className={`schematic__layer schematic__layer--${layer.type} ${layer.visible ? '' : 'schematic__layer--hidden'}`}
            style={{
              left: `${clampPct(left)}%`,
              top: `${clampPct(top)}%`,
              width: `${Math.min(100 - clampPct(left), clampPct(w))}%`,
              height: `${Math.min(100 - clampPct(top), clampPct(h))}%`,
              opacity: Math.max(0.15, layer.opacity / 100),
            }}
            title={`${layer.name} — ${Math.round(layer.width)}×${Math.round(layer.height)} at (${Math.round(layer.x)}, ${Math.round(layer.y)})`}
          >
            <span>{layer.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
