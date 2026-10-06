import { mkdtempSync, rmSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockPhotoshopAdapter } from '../src/adapter/mock-adapter.js';
import { Workspace } from '../src/workspace.js';

/**
 * Mock brush behaviour.
 *
 * The mock is where a drawing plan is rehearsed before it reaches Photoshop, so
 * a stroke the mock mishandles is a plan that looks fine and then draws the
 * wrong thing. Two things are pinned here:
 *
 *  - the ink a stroke leaves is observable, via `sample_color` and the preview
 *    raster, so "it painted" can be confirmed rather than inferred from a
 *    `success: true`;
 *  - the geometry matches the plugin's, which `stroke-geometry.test.ts` checks
 *    directly against the plugin file. Only the observable consequences are
 *    asserted here.
 */
describe('mock strokes', () => {
  let workspaceDir: string;
  let workspace: Workspace;
  let adapter: MockPhotoshopAdapter;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'studio-mock-brush-'));
    workspace = new Workspace(workspaceDir, join(workspaceDir, 'out'));
    adapter = new MockPhotoshopAdapter({ workspace });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const ink = { r: 12, g: 34, b: 56 };
  const base = { documentId: 'active', brushSize: 24, color: ink, opacity: 100 };

  it('puts ink where it says it painted', async () => {
    const result = await adapter.strokePath({
      ...base,
      path: [
        { type: 'move', point: { x: 200, y: 300 } },
        { type: 'line', point: { x: 600, y: 300 } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.samplesChanged).toBeGreaterThan(0);

    // A sample on the path reports the stroke's colour; one well clear of it
    // does not.
    const onStroke = await adapter.sampleColor({ x: 400, y: 300 });
    expect(onStroke.color).toEqual(ink);

    const offStroke = await adapter.sampleColor({ x: 400, y: 900 });
    expect(offStroke.color).not.toEqual(ink);
  });

  it('does not join two marks separated by a move', async () => {
    await adapter.strokePath({
      ...base,
      path: [
        { type: 'move', point: { x: 100, y: 100 } },
        { type: 'line', point: { x: 300, y: 100 } },
        { type: 'move', point: { x: 100, y: 800 } },
        { type: 'line', point: { x: 300, y: 800 } },
      ],
    });

    // The gap between the two marks must stay clean. Bridging it is the single
    // most visible way a stroke goes wrong, and it is invisible in a preview
    // unless you know to look.
    const before = await adapter.sampleColor({ x: 200, y: 450 });
    expect(before.color).not.toEqual(ink);
  });

  it('shows the stroke in the preview', async () => {
    const path = [
      { type: 'move' as const, point: { x: 400, y: 300 } },
      { type: 'line' as const, point: { x: 800, y: 300 } },
    ];
    const before = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });
    await adapter.strokePath({ ...base, path });
    const after = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });

    // The preview is the one place a person can look and confirm ink landed, so
    // a stroke that leaves it byte-identical is a stroke nobody can debug.
    expect(after.base64.length).toBeGreaterThan(0);
    expect(after.base64).not.toBe(before.base64);
  });

  it('leaves a hidden layer out of the preview', async () => {
    const path = [
      { type: 'move' as const, point: { x: 400, y: 300 } },
      { type: 'line' as const, point: { x: 800, y: 300 } },
    ];
    await adapter.strokePath({ ...base, path, newLayer: true, layerName: 'Ink' });
    const visible = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });

    const layers = await adapter.getLayers({ documentId: 'active' });
    await adapter.setLayerVisibility({ documentId: 'active', layerName: 'Ink', visible: false });
    const hidden = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });

    expect(hidden.base64).not.toBe(visible.base64);
    expect(layers.find((l) => l.name === 'Ink')?.visible).toBe(true);
  });

  it('creates the default-named layer when asked for one without a name', async () => {
    const result = await adapter.strokePath({
      ...base,
      newLayer: true,
      path: [
        { type: 'move', point: { x: 100, y: 100 } },
        { type: 'line', point: { x: 200, y: 200 } },
      ],
    });

    // Must match `DEFAULT_STROKE_LAYER_NAME`, which the post-condition check
    // looks for by name.
    expect(result.layerName).toBe('Stroke');
    const layers = await adapter.getLayers({ documentId: 'active' });
    expect(layers.map((l) => l.name)).toContain('Stroke');
  });

  it('adds no ink for a zero-opacity stroke', async () => {
    const result = await adapter.strokePath({
      ...base,
      opacity: 0,
      path: [
        { type: 'move', point: { x: 100, y: 100 } },
        { type: 'line', point: { x: 200, y: 200 } },
      ],
    });

    // The stamps were placed, but nothing should be readable on the canvas —
    // otherwise an "invisible" layer silently occludes artwork behind it.
    expect(result.stampsPainted).toBeGreaterThan(0);
    const sampled = await adapter.sampleColor({ x: 150, y: 150 });
    expect(sampled.color).not.toEqual(ink);
  });

  it('reports no brush engine instead of inventing brush names', async () => {
    // The mock and the plugin must agree here, or a plan validated against the
    // mock will reference a brush that does not exist in Photoshop.
    const brushes = await adapter.listBrushes();
    expect(brushes.available).toBe(false);
    expect(brushes.brushes).toEqual([]);
    expect(brushes.source).toBe('unavailable');
  });

  it('leaves the document dirty, since nothing was saved', async () => {
    await adapter.strokePath({
      ...base,
      path: [
        { type: 'move', point: { x: 10, y: 10 } },
        { type: 'line', point: { x: 50, y: 50 } },
      ],
    });

    expect((await adapter.getDocumentInfo()).saved).toBe(false);
  });
});

describe('mock gradients', () => {
  let workspaceDir: string;
  let adapter: MockPhotoshopAdapter;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'studio-mock-gradient-'));
    adapter = new MockPhotoshopAdapter({ workspace: new Workspace(workspaceDir, join(workspaceDir, 'out')) });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const stops = [
    { position: 0, color: { r: 8, g: 16, b: 40 } },
    { position: 100, color: { r: 250, g: 214, b: 160 } },
  ];

  it('records the bands it resolved and proves the canvas changed', async () => {
    const result = await adapter.paintGradient({ documentId: 'active', stops, bands: 16 });

    expect(result.success).toBe(true);
    expect(result.methodUsed).toBe('rasterized-gradient');
    expect(result.bandsPainted).toBe(16);
    expect(result.verified).toBe(true);
    expect(result.samplesChanged).toBeGreaterThan(0);
  });

  it('changes the preview, so the result can be checked by eye', async () => {
    // The mock draws previews as a PNG it composes itself. A gradient that
    // painted and never appeared here would be exactly the invisible success
    // this project exists to catch, so the pixels are compared, not the length.
    // `maxWidth` carries a schema default, so a direct adapter call has to
    // supply it — without it the preview scales by NaN.
    const before = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });
    await adapter.paintGradient({ documentId: 'active', stops, bands: 8 });
    const after = await adapter.renderPreview({ documentId: 'active', maxWidth: 960 });

    expect(after.base64).not.toBe(before.base64);
    expect(after.width).toBeGreaterThan(0);
  });

  it('clamps an impossible band count rather than drawing nothing', async () => {
    // `bands` has a schema minimum, so the geometry never sees zero; it still
    // has to cope, because a ramp of one band would be a flat fill the caller
    // did not ask for.
    const result = await adapter.paintGradient({ documentId: 'active', stops, bands: 0 as never });
    expect(result.bandsPainted).toBeGreaterThanOrEqual(2);
  });

  it('never claims a blur the mock cannot apply', async () => {
    const result = await adapter.paintGradient({ documentId: 'active', stops, bands: 4, smoothRadius: 6 });
    expect(result.success).toBe(true);
    expect(result.smoothed).toBe(false);
  });
});

describe('preview ground', () => {
  let groundDir: string;

  beforeEach(() => {
    groundDir = mkdtempSync(join(tmpdir(), 'mock-ground-'));
  });

  afterEach(() => {
    rmSync(groundDir, { recursive: true, force: true });
  });

  const makeAdapter = async (background: 'white' | 'background' | 'transparent') => {
    const adapter = new MockPhotoshopAdapter({
      workspace: new Workspace(groundDir, join(groundDir, 'out')),
      demoDocument: false,
    });
    await adapter.createDocument({ name: 'ground', width: 64, height: 64, resolution: 72, colorMode: 'RGB', background });
    return adapter;
  };

  /**
   * First pixel of a solid-colour PNG.
   *
   * Decoding beats comparing file sizes: both grounds compress to about the same
   * length, so a size assertion would have passed for the wrong reason — which is
   * exactly how a hardcoded dark ground survived in the first place.
   */
  const firstPixel = (base64: string): number[] => {
    const png = Buffer.from(base64, 'base64');
    let bitDepth = 0;
    let colorType = 0;
    const idat: Buffer[] = [];
    let at = 8;
    while (at < png.length) {
      const length = png.readUInt32BE(at);
      const type = png.toString('ascii', at + 4, at + 8);
      if (type === 'IHDR') {
        bitDepth = png[at + 16]!;
        colorType = png[at + 17]!;
      }
      if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    expect(bitDepth).toBe(8);
    expect(colorType).toBe(2); // truecolour
    const channels = 3;
    const raw = inflateSync(Buffer.concat(idat));
    // Row 0 is preceded by its filter byte, which is always 0 for this encoder.
    return [...raw.subarray(1, 1 + channels)];
  };

  // These two use a transparent document because it is the only one with no
  // layers: the schematic band that stands in for a layer's artwork is composited
  // over the ground, so a document with a Background layer proves nothing about the
  // ground itself.
  it('keeps the dark ground on a document that asked for no white canvas', async () => {
    // The preview used to hardcode this dark ground for *every* document. On a
    // painting engine that is not cosmetic: a palette chosen too dark and a correct
    // one were indistinguishable in the only artefact anybody looks at, and the low
    // contrast I first blamed on the recipes was the dark ground all along.
    const adapter = await makeAdapter('transparent');
    const png = await adapter.renderPreview({ documentId: 'active', maxWidth: 64 });
    expect(firstPixel(png.base64)).toEqual([32, 34, 40]);
  });

  it('makes a white canvas white rather than charcoal', async () => {
    const adapter = await makeAdapter('white');
    const png = await adapter.renderPreview({ documentId: 'active', maxWidth: 64 });
    const [r, g, b] = firstPixel(png.base64);
    // The Background layer's schematic band composites over the ground, so the
    // pixel is a blend and not pure 255. What matters is that it is a *light*
    // grey now: before the fix this read 57,58,71 for the same request.
    expect(Math.min(r, g, b)).toBeGreaterThan(120);
  });

  it('lets the ground through the schematic band rather than behind a slate', async () => {
    const light = firstPixel((await (await makeAdapter('white')).renderPreview({ documentId: 'active', maxWidth: 64 })).base64);
    const dark = firstPixel((await (await makeAdapter('background')).renderPreview({ documentId: 'active', maxWidth: 64 })).base64);
    expect(light[0]).toBeGreaterThan(dark[0] + 60);
  });

  it('changes nothing about how strokes composite', async () => {
    const adapter = await makeAdapter('white');
    const before = await adapter.renderPreview({ documentId: 'active', maxWidth: 64 });
    await adapter.paintStroke({
      documentId: 'active',
      points: [{ x: 10, y: 10 }, { x: 50, y: 10 }],
      brushSize: 20,
      color: '#000000',
      opacity: 100,
    });
    const after = await adapter.renderPreview({ documentId: 'active', maxWidth: 64 });
    expect(after.base64).not.toBe(before.base64);
  });
});
