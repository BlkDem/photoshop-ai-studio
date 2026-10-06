/**
 * Renders a Painting Plan through the engine and the in-memory Photoshop, and
 * writes a PNG.
 *
 * This is the fastest honest check that the pipeline works: plan -> recipes ->
 * semantic strokes -> pixel batches -> image. No Photoshop, no MCP, no network.
 *
 *   npx tsx scripts/render-plan-preview.ts [out.png]
 */

import { writeFileSync } from 'node:fs';
import { PaintEngine, critiquePng, formatCritique, direct } from '../paint-engine/src/index.js';
import { MockPhotoshopAdapter } from '../mcp-server/src/adapter/mock-adapter.js';
import { Workspace } from '../mcp-server/src/workspace.js';
import type { PaintingPlan, PaintTarget } from '../paint-engine/src/index.js';
import type { PixelStroke } from '../paint-engine/src/index.js';
import type { PhotoshopAdapter } from '../shared/src/photoshop/adapter.js';

/**
 * Drives a `PhotoshopAdapter` from the engine.
 *
 * The engine hands over a whole layer's strokes in one `paint()` call and the
 * adapter now has a `paint_strokes` operation for exactly that, so the shim is a
 * direct translation and holds no policy of its own. The layer loop stays here
 * because the engine calls back per layer and must not know that layers are
 * created over a wire.
 *
 * Failures are collected and reported rather than thrown: a preview that dies on
 * one bad mark shows nothing at all, and the marks that did paint are still worth
 * looking at.
 */
class AdapterPaintTarget implements PaintTarget {
  /** Strokes Photoshop refused, with the layer they belonged to. */
  readonly failures: Array<{ layer: string; reason: string }> = [];

  constructor(private readonly adapter: PhotoshopAdapter) {}

  private get currentLayer(): string {
    return this.layerName;
  }

  private layerName = '';

  async ensureLayer(layer: string): Promise<void> {
    this.layerName = layer;
    const document = await this.adapter.getDocument({ documentId: 'active' });
    const existing = document.layers?.find((l) => l.name === layer);
    if (existing) {
      // `visible` is a positional argument, not part of the selector. Passing it
      // inside the selector sets `layer.visible = undefined`, which the preview
      // then reads as hidden — the layer's strokes vanish with no error anywhere.
      await this.adapter.setLayerVisibility({ documentId: 'active', layerId: existing.id }, true);
      return;
    }
    await this.adapter.createLayer({
      documentId: 'active',
      name: layer,
      kind: 'pixel',
      x: 0,
      y: 0,
      width: document.width,
      height: document.height,
      visible: true,
    });
  }

  async paint(strokes: PixelStroke[]): Promise<void> {
    if (strokes.length === 0) return;

    const result = await this.adapter.paintStrokes({
      documentId: 'active',
      strokes: strokes.map((stroke) => ({
        points: stroke.points,
        brushSize: stroke.size,
        color: stroke.color,
        opacity: Math.round(stroke.opacity * 100),
        spacing: stroke.spacing,
        // Forwarded, not defaulted: a shim that drops the tip would silently turn
        // every soft brush into a flat disc and the preview would lie about what
        // Photoshop is being asked to do.
        tip: { core: stroke.tip.core, steps: stroke.tip.steps, outerAlpha: stroke.tip.outerAlpha },
        ...(stroke.blendMode ? { blendMode: stroke.blendMode as never } : {}),
      })),
    });

    for (const failure of result.failures ?? []) {
      this.failures.push({ layer: this.currentLayer, reason: failure.reason });
    }
  }
}

const CANVAS = { width: 960, height: 540 };

/**
 * The spec's demo scene, as a plan.
 *
 * Deliberately hand-written rather than generated: this is the fixture that has
 * to keep working as the engine changes, so it should not move every time the
 * Art Director does.
 */
const PLAN: PaintingPlan = {
  title: 'Moonlit ocean',
  canvas: CANVAS,
  style: {
    medium: 'oil',
    brushCharacter: 'layered oil',
    contrast: 'high',
    atmosphere: 'romantic marine',
    texture: 'moderate',
    edgeCharacter: 'soft',
    colorTemperature: 'cool',
    detailLevel: 0.7,
  },
  composition: {
    framework: 'ruleOfThirds',
    horizon: 0.58,
    focalPoint: { x: 0.68, y: 0.42 },
    regions: {},
    negativeSpace: 0.3,
  },
  palette: {
    shadows: ['#0b1c2a', '#12293c'],
    midtones: ['#1d4a63', '#2f6d84'],
    highlights: ['#8fb6bd', '#e8dcb4'],
    accents: ['#c9713c'],
    base: ['#143a52'],
  },
  layers: ['Highlights', 'Foam', 'Waves', 'Clouds', 'Sky'],
  stages: [
    {
      id: 'sky',
      layer: 'Sky',
      purpose: 'Night sky wash',
      brush: 'soft_blend',
      depth: 'background',
      palette: ['#0b1c2a'],
      density: 1,
      detail: 0.15,
      progress: 0.08,
      strokes: [
        { primitive: 'glaze', region: { x: 0, y: 0, width: 1, height: 0.66 }, colorRole: 'shadows' },
        { primitive: 'glaze', region: { x: 0, y: 0.1, width: 1, height: 0.48 }, colorRole: 'midtones' },
      ],
    },
    {
      id: 'clouds',
      layer: 'Clouds',
      purpose: 'Cloud masses',
      brush: 'soft_blend',
      depth: 'background',
      palette: ['#12293c'],
      density: 1,
      detail: 0.3,
      progress: 0.2,
      strokes: [
        { primitive: 'cloud', region: { x: 0, y: 0.02, width: 0.55, height: 0.3 }, colorRole: 'shadows' },
        { primitive: 'cloud', region: { x: 0.35, y: 0.06, width: 0.65, height: 0.32 }, colorRole: 'shadows' },
        { primitive: 'cloud', region: { x: 0.5, y: 0.2, width: 0.4, height: 0.2 }, colorRole: 'midtones' },
      ],
    },
    {
      id: 'waves',
      layer: 'Waves',
      purpose: 'Ocean and wave masses',
      brush: 'oil_large',
      depth: 'midground',
      palette: ['#143a52'],
      density: 1,
      detail: 0.35,
      progress: 0.45,
      strokes: [
        { primitive: 'glaze', region: { x: 0, y: 0.55, width: 1, height: 0.45 }, colorRole: 'shadows' },
        { primitive: 'wave', region: { x: 0, y: 0.56, width: 1, height: 0.12 }, colorRole: 'midtones', frequency: 4, amplitude: 0.05, energy: 0.8 },
        { primitive: 'wave', region: { x: 0, y: 0.62, width: 1, height: 0.14 }, colorRole: 'midtones', frequency: 5, amplitude: 0.06, energy: 0.85 },
        { primitive: 'wave', region: { x: 0, y: 0.72, width: 1, height: 0.16 }, colorRole: 'shadows', frequency: 3, amplitude: 0.07, energy: 0.9 },
        { primitive: 'wave', region: { x: 0.1, y: 0.8, width: 0.8, height: 0.2 }, colorRole: 'shadows', frequency: 2, amplitude: 0.09, energy: 1 },
      ],
    },
    {
      id: 'foam',
      layer: 'Foam',
      purpose: 'Foam and breaking crests',
      brush: 'oil_small',
      depth: 'foreground',
      palette: ['#8fb6bd'],
      density: 1,
      detail: 0.6,
      progress: 0.8,
      strokes: [
        { primitive: 'cloud', region: { x: 0.15, y: 0.8, width: 0.5, height: 0.16 }, colorRole: 'highlights' },
        { primitive: 'cloud', region: { x: 0.55, y: 0.86, width: 0.45, height: 0.14 }, colorRole: 'highlights' },
        { primitive: 'scatteredDabs', region: { x: 0.1, y: 0.75, width: 0.85, height: 0.25 }, count: 60, jitter: 0.6, colorRole: 'highlights' },
      ],
    },
    {
      id: 'highlights',
      layer: 'Highlights',
      purpose: 'Warm light on the crests',
      brush: 'oil_detail',
      depth: 'foreground',
      palette: ['#e8dcb4'],
      density: 1,
      detail: 0.95,
      progress: 0.95,
      strokes: [
        { primitive: 'highlight', region: { x: 0.6, y: 0.55, width: 0.25, height: 0.18 }, colorRole: 'accents' },
        { primitive: 'highlight', region: { x: 0.3, y: 0.76, width: 0.3, height: 0.14 }, colorRole: 'highlights' },
        { primitive: 'scatteredDabs', region: { x: 0.55, y: 0.5, width: 0.35, height: 0.3 }, count: 40, jitter: 0.5, colorRole: 'accents' },
      ],
    },
  ],
  seed: 20261005,
  maxIterations: 3,
};

/**
 * `--request "<text>"` directs the scene from a request instead of using the
 * hand-written fixture.
 *
 * Two paths through one script on purpose: the fixture is what pins the engine's
 * behaviour, and the request path is what proves the Art Director agrees with it.
 * A generated plan that only works when nothing about it is random is a fixture
 * wearing a costume.
 */
function planFromArgv(argv: string[]): { plan: PaintingPlan; assumptions: string[] } {
  const flag = argv.indexOf('--request');
  if (flag === -1) return { plan: PLAN, assumptions: [] };
  const request = argv[flag + 1] ?? '';
  const { plan, assumptions } = direct(request, {
    canvas: { width: CANVAS.width, height: CANVAS.height },
    seed: PLAN.seed,
  });
  return { plan, assumptions };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const out = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--request')
    ?? 'workspace/painting-engine-preview.png';
  const { plan: requested, assumptions } = planFromArgv(argv);
  const engine = new PaintEngine();
  const estimate = engine.estimate(requested);

  const workspace = new Workspace('workspace');
  const adapter = new MockPhotoshopAdapter({ workspace, demoDocument: false });

  await adapter.createDocument({
    name: 'moonlit-ocean',
    width: requested.canvas.width,
    height: requested.canvas.height,
    resolution: 72,
    colorMode: 'RGB',
    background: 'white',
  });

  const phases: string[] = [];
  const progressEngine = new PaintEngine({
    onProgress: (p) => {
      if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
    },
  });
  const report = await progressEngine.paintPlan(requested, new AdapterPaintTarget(adapter));

  const doc = await adapter.getDocument({ documentId: 'active' });

  const preview = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });
  const png = Buffer.from(preview.base64, 'base64');
  writeFileSync(out, png);

  // Judge the output rather than describe it. Everything that went wrong while
  // building the Art Director — the invisible horizon, the missing value range, the
  // picture that was mostly ground — was measurable, and being told "score 12/100,
  // horizon delta 0.004" is a faster loop than looking at a picture and guessing.
  const judged = critiquePng(requested, png);
  console.log(judged.critique ? formatCritique(judged.critique, 'preview') : `unreadable: ${judged.unreadable}`);

  console.log(
    JSON.stringify(
      {
        out,
        request: assumptions.length > 0 ? requested.title : null,
        assumptions,
        critique: judged.critique ? { structure: judged.critique.structureScore, findings: judged.critique.findings.map((f) => f.id) } : null,
        estimated: { layers: estimate.layers, strokes: estimate.strokes, fills: estimate.fills },
        painted: { layers: report.layers, strokes: report.strokes, batches: report.batches, fills: report.fills },
        degraded: report.degraded,
        truncated: report.truncated,
        tipIsSynthesized: report.tipIsSynthesized,
        phases,
        layersInDoc: (doc.layers ?? []).map((l) => `#${l.id} ${l.name} vis=${l.visible} ${l.width}x${l.height}`),
        bytes: png.length,
      },
      null,
      2,
    ),
  );
}

void main();