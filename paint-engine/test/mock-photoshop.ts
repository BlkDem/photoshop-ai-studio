/**
 * An in-memory Photoshop, for testing the paint engine end to end.
 *
 * The real adapter's contract is "put these pixel strokes on that layer", and
 * almost everything interesting about the engine — batching, ordering, layer
 * creation, progress accounting, cost budgeting — is testable against that
 * contract without a real Photoshop anywhere. This mock records what it was
 * asked to do so a test can assert on it.
 *
 * It is deliberately *not* a pixel rasterizer. `mcp-server` already has one
 * (`mock-adapter.ts`) that composites real discs into a PNG; duplicating that
 * here would test the same code twice and keep the two copies in disagreement.
 */

import type { PaintTarget } from '../src/paint-engine.js';
import type { PixelStroke } from '../src/renderer/coordinates.js';

export interface MockLayer {
  name: string;
  /** One entry per batch painted onto this layer. */
  batches: PixelStroke[][];
  strokes: PixelStroke[];
}

export class MockPhotoshop implements PaintTarget {
  readonly layers: MockLayer[] = [];
  readonly calls: { kind: 'ensureLayer' | 'paint'; layer: string; strokes: number }[] = [];

  constructor(private readonly failOn?: string) {}

  async ensureLayer(layer: string): Promise<void> {
    this.calls.push({ kind: 'ensureLayer', layer, strokes: 0 });
    const existing = this.layers.find((l) => l.name === layer);
    if (!existing) this.layers.push({ name: layer, batches: [], strokes: [] });
  }

  async paint(strokes: PixelStroke[]): Promise<void> {
    this.calls.push({ kind: 'paint', layer: '', strokes: strokes.length });
    if (this.failOn && strokes.some((s) => s.purpose.includes(this.failOn))) {
      throw new Error(`mock refused a stroke whose purpose mentions "${this.failOn}"`);
    }
    const layer = this.layers[this.layers.length - 1];
    if (!layer) throw new Error('paint called before any layer existed');
    layer.batches.push(strokes);
    layer.strokes.push(...strokes);
  }

  /** Layer names in creation order, which is bottom-first. */
  layerNames(): string[] {
    return this.layers.map((l) => l.name);
  }

  totalStrokes(): number {
    return this.layers.reduce((sum, l) => sum + l.strokes.length, 0);
  }

  /** Every distinct brush diameter seen, useful for asserting depth scaling. */
  brushSizes(): number[] {
    return [...new Set(this.layers.flatMap((l) => l.strokes.map((s) => s.size)))].sort((a, b) => a - b);
  }
}