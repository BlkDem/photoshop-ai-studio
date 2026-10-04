import { describe, expect, it } from 'vitest';

import { loadPluginFile, photoshopStub, type Stub } from './harness.js';

/**
 * Brush operation behaviour tests.
 *
 * `stroke-geometry.test.ts` covers the arithmetic; this covers what the plugin
 * does with Photoshop once it has stamps. The two behaviours pinned down here
 * are the ones the previous implementation got wrong in ways no existing test
 * could see:
 *
 *  1. **A reported success must mean pixels moved.** The old code returned
 *     `success: true` from a chain of accepted fills without reading the canvas
 *     once, so a stroke onto an empty selection or under a locked layer passed
 *     verification having drawn nothing.
 *  2. **`list_brushes` must not invent names.** It returned a fixed list of
 *     eight brushes that had nothing to do with the running Photoshop.
 *
 * The fake host keeps a real pixel buffer and records the order of samples and
 * fills, so "did it actually paint" is answered by the pixels rather than by a
 * return value.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface BrushResult {
  success: boolean;
  layerId?: number;
  layerName?: string;
  brushSize?: number;
  blendMode?: string;
  methodUsed?: string;
  stampsPainted?: number;
  samplesChecked?: number;
  samplesChanged?: number;
  verified?: boolean | null;
  truncated?: boolean;
}

interface BrushModule {
  list_brushes(ctx: unknown): Promise<{
    available: boolean;
    brushes: Array<{ name: string }>;
    currentBrush: string | null;
    source: string | null;
    reason?: string;
  }>;
  stroke_path(ctx: unknown): Promise<BrushResult>;
  paint_stroke(ctx: unknown): Promise<BrushResult>;
}

interface Host {
  photoshop: Stub;
  document: Record<string, unknown>;
  pixels: Map<string, Rgb>;
  fills: unknown[];
  ellipses: Array<{ left: number; top: number; right: number; bottom: number }>;
  events: string[];
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** A host whose canvas starts white and turns black wherever a fill lands. */
function drawingHost(width = 400, height = 300): Host {
  const fills: unknown[] = [];
  const ellipses: Host['ellipses'] = [];
  const pixels = new Map<string, Rgb>();
  const events: string[] = [];
  const key = (x: number, y: number) => `${x},${y}`;

  const layer = { id: 7, name: 'Layer 1' };
  const document: Record<string, unknown> = {
    id: 1,
    name: 'draw.psd',
    width,
    height,
    resolution: 72,
    mode: 'RGB',
    layers: [layer],
    backgroundLayer: layer,
    activeLayer: layer,
    saved: true,
    zoom: 100,
    selection: {
      selectEllipse: (bounds: { left: number; top: number; right: number; bottom: number }) => {
        ellipses.push(bounds);
        return Promise.resolve();
      },
      deselect: () => {
        events.push('deselect');
        return Promise.resolve();
      },
    },
    sampleColor: (point: { x: number; y: number }) => {
      events.push('sample');
      return pixels.get(key(point.x, point.y)) ?? WHITE;
    },
    createLayer: (options?: { name?: string }) => ({ id: 99, name: options?.name ?? 'Stroke' }),
  };

  const photoshop = photoshopStub() as Record<string, unknown>;
  (photoshop.action as { batchPlay: unknown }).batchPlay = (descriptors: unknown) => {
    fills.push(descriptors);
    // Paint the last ellipse, which is what the plugin just selected. A call
    // with nothing selected is not a fill — `withForegroundColor` issues one to
    // set the foreground colour before the stroke starts.
    const box = ellipses[ellipses.length - 1];
    if (!box) return Promise.resolve([{}]);
    events.push('fill');
    for (let y = box.top; y < box.bottom; y += 1) {
      for (let x = box.left; x < box.right; x += 1) pixels.set(key(x, y), BLACK);
    }
    return Promise.resolve([{}]);
  };
  photoshop.app = { activeDocument: document, documents: [document], foregroundColor: {} };

  return { photoshop: photoshop as unknown as Stub, document, pixels, fills, ellipses, events };
}

/** A host whose fills are accepted but paint nothing — the silent-failure case. */
function silentHost(): Host {
  const host = drawingHost();
  (host.photoshop.action as { batchPlay: unknown }).batchPlay = () => Promise.resolve([{}]);
  return host;
}

function loadBrush(photoshop: Stub): BrushModule {
  return loadPluginFile('lib/ops/brush.js', undefined, photoshop) as unknown as BrushModule;
}

const baseParams = {
  documentId: 'active',
  brushSize: 20,
  color: { r: 0, g: 0, b: 0 },
  opacity: 100,
};

const runStroke = (brush: BrushModule, params: Record<string, unknown>) =>
  brush.stroke_path({
    params: {
      ...baseParams,
      ...params,
      path: [
        { type: 'move', point: { x: params.from?.[0] ?? 50, y: params.from?.[1] ?? 100 } },
        { type: 'line', point: { x: params.to?.[0] ?? 350, y: params.to?.[1] ?? 100 } },
      ],
    },
  });

describe('stroke_path', () => {
  it('draws along the path and proves pixels moved', async () => {
    const host = drawingHost();
    const result = await runStroke(loadBrush(host.photoshop), {});

    expect(result.success).toBe(true);
    expect(result.methodUsed).toBe('rasterized-stroke');
    expect(result.stampsPainted).toBeGreaterThan(0);
    expect(result.samplesChecked).toBeGreaterThan(0);
    expect(result.samplesChanged).toBeGreaterThan(0);
    expect(result.verified).toBe(true);
  });

  it('fills round discs, not rectangles', async () => {
    const host = drawingHost();
    await runStroke(loadBrush(host.photoshop), { from: [100, 150], to: [300, 150] });

    // A disc of radius 10 centred at (100,150) covers (109,141); a 20×20 axis
    // aligned rectangle would not. That corner is the whole difference between a
    // round brush and the rectangle tracing this replaced.
    expect(host.pixels.has('100,150')).toBe(true);
    expect(host.pixels.has('109,141')).toBe(true);
    expect(host.pixels.has('100,139')).toBe(false);
  });

  it('samples the canvas before the first fill, so the comparison is meaningful', async () => {
    const host = drawingHost();
    await runStroke(loadBrush(host.photoshop), { from: [50, 50], to: [200, 50] });

    const firstFill = host.events.indexOf('fill');
    expect(firstFill).toBeGreaterThan(0);
    // Every "before" read lands ahead of the first fill, and at least one lands
    // after the last — that ordering is the only reason `verified` means
    // anything.
    expect(host.events.slice(0, firstFill).every((e) => e === 'sample')).toBe(true);
    expect(host.events[host.events.length - 1]).toBe('sample');
  });

  it('fails, rather than claiming success, when nothing on the canvas changed', async () => {
    const host = silentHost();
    await expect(runStroke(loadBrush(host.photoshop), {})).rejects.toMatchObject({
      code: 'STEP_FAILED',
      recoverable: false,
    });
  });

  it('never claims it drew without evidence', async () => {
    const host = silentHost();
    // A host that cannot be sampled at all must report the stroke as unproven
    // rather than as verified — an unreadable canvas is not a passing one.
    (host.document as { sampleColor: unknown }).sampleColor = () => {
      throw new Error('sampling is unavailable');
    };
    const result = await runStroke(loadBrush(host.photoshop), {});
    expect(result.success).toBe(true);
    expect(result.verified).toBeNull();
    expect(result.samplesChecked).toBe(0);
  });

  it('composites with the blend mode it was given', async () => {
    const host = drawingHost();
    const result = await runStroke(loadBrush(host.photoshop), { blendMode: 'multiply' });
    expect(result.blendMode).toBe('multiply');

    const modes = host.fills
      .map((fill) => (fill as Array<{ _obj: string; mode?: { _value?: string } }>)[0]!)
      .filter((descriptor) => descriptor._obj === 'fill' && descriptor.mode)
      .map((descriptor) => descriptor.mode!._value);
    expect(modes).toContain('multiply');
  });

  it('paints onto the active layer by default', async () => {
    const host = drawingHost();
    const result = await runStroke(loadBrush(host.photoshop), {});
    expect(result.layerId).toBe(7);
    expect(result.layerName).toBe('Layer 1');
  });

  it('creates a named layer when asked', async () => {
    const host = drawingHost();
    const result = await runStroke(loadBrush(host.photoshop), { newLayer: true, layerName: 'Ink' });
    expect(result.layerId).toBe(99);
    expect(result.layerName).toBe('Ink');
  });

  it('refuses a path with no usable points instead of silently succeeding', async () => {
    const host = drawingHost();
    await expect(
      loadBrush(host.photoshop).stroke_path({ params: { ...baseParams, path: [] } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', recoverable: false });
  });

  it('clips a stroke that runs off the canvas rather than being rejected', async () => {
    const host = drawingHost(200, 100);
    const result = await runStroke(loadBrush(host.photoshop), { from: [20, 50], to: [400, 50] });

    expect(result.success).toBe(true);
    for (const box of host.ellipses) {
      expect(box.right).toBeLessThanOrEqual(200);
      expect(box.bottom).toBeLessThanOrEqual(100);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
    }
  });

  it('narrows the stroke at both ends when pressure is simulated', async () => {
    const host = drawingHost();
    await runStroke(loadBrush(host.photoshop), {
      brushSize: 40,
      simulatePressure: true,
      from: [30, 150],
      to: [370, 150],
    });

    const heights = host.ellipses.map((box) => box.bottom - box.top);
    const middle = Math.floor(heights.length / 2)!;
    expect(Math.min(...heights)).toBeLessThan(heights[middle]!);
    expect(heights[heights.length - 1]).toBeLessThan(heights[middle]!);
  });

  it('clears the selection even when a fill fails', async () => {
    const host = drawingHost();
    let calls = 0;
    (host.photoshop.action as { batchPlay: unknown }).batchPlay = (descriptors: unknown) => {
      // Let `withForegroundColor` through, then fail the first real fill.
      if (host.ellipses.length === 0) return Promise.resolve([{}]);
      calls += 1;
      void descriptors;
      return Promise.reject(new Error('fill failed'));
    };

    await expect(runStroke(loadBrush(host.photoshop), {})).rejects.toMatchObject({ code: 'STEP_FAILED' });

    // A leaked selection outlives the call and silently applies to every later
    // operation in the session, so it has to be cleared on the failure path too.
    expect(calls).toBeGreaterThan(0);
    expect(host.events.filter((e) => e === 'deselect').length).toBeGreaterThan(0);
    expect(host.ellipses.length).toBeGreaterThan(0);
  });

  it('follows a curve through its control points', async () => {
    const host = drawingHost();
    await loadBrush(host.photoshop).stroke_path({
      params: {
        ...baseParams,
        path: [
          { type: 'move', point: { x: 20, y: 20 } },
          { type: 'curve', cp1: { x: 120, y: 260 }, cp2: { x: 280, y: 260 }, point: { x: 380, y: 20 } },
        ],
      },
    });

    // Ink must reach the lower half, which only happens if the curve bulges.
    const lowest = Math.max(...host.pixels.keys().map((k) => Number(k.split(',')[1])));
    expect(lowest).toBeGreaterThan(60);
  });
});

describe('paint_stroke', () => {
  const points = [
    { x: 40, y: 40 },
    { x: 200, y: 90 },
    { x: 360, y: 40 },
  ];

  it('draws through the points it is given', async () => {
    const host = drawingHost();
    const result = await loadBrush(host.photoshop).paint_stroke({ params: { ...baseParams, points } });

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.stampsPainted).toBeGreaterThan(2);
  });

  it('applies smoothing rather than ignoring it', async () => {
    const jaggy = [
      { x: 20, y: 150 },
      { x: 90, y: 60 },
      { x: 160, y: 150 },
      { x: 230, y: 60 },
      { x: 300, y: 150 },
    ];
    const raw = drawingHost();
    const smoothed = drawingHost();

    await loadBrush(raw.photoshop).paint_stroke({ params: { ...baseParams, points: jaggy, smoothing: 0 } });
    await loadBrush(smoothed.photoshop).paint_stroke({ params: { ...baseParams, points: jaggy, smoothing: 60 } });

    // Smoothing cuts the spikes inward, so it has to change where the ink lands.
    // Comparing stamp *counts* would only measure how the pass count was chosen:
    // a shorter, smoother path legitimately needs fewer stamps than the jaggy one.
    const deepest = (host: ReturnType<typeof drawingHost>): number =>
      Math.min(...host.ellipses.map((box) => box.top));

    expect(deepest(smoothed)).toBeGreaterThan(deepest(raw));
  });

  it('leaves a round dot for a single point, the way a click does', async () => {
    const host = drawingHost();
    const result = await loadBrush(host.photoshop).paint_stroke({
      params: { ...baseParams, points: [{ x: 120, y: 120 }] },
    });

    expect(result.success).toBe(true);
    expect(result.stampsPainted).toBe(1);
    expect(host.pixels.has('120,120')).toBe(true);
  });

  it('fails rather than claiming success when nothing changed', async () => {
    const host = silentHost();
    await expect(
      loadBrush(host.photoshop).paint_stroke({ params: { ...baseParams, points } }),
    ).rejects.toMatchObject({ code: 'STEP_FAILED' });
  });
});

describe('list_brushes', () => {
  it('reports that no brush collection exists rather than inventing names', async () => {
    const result = await loadBrush(photoshopStub()).list_brushes({});

    expect(result.available).toBe(false);
    expect(result.brushes).toEqual([]);
    expect(result.source).toBe('unavailable');
    expect(result.reason).toMatch(/no brush collection/i);
  });

  it('reads real brush names when the host has a collection', async () => {
    const photoshop = photoshopStub() as Record<string, unknown>;
    (photoshop.app as Record<string, unknown>).brushes = [{ name: 'Soft Round 21', size: 21 }];

    const result = await loadBrush(photoshop as unknown as Stub).list_brushes({});
    expect(result.available).toBe(true);
    expect(result.brushes.map((b) => b.name)).toEqual(['Soft Round 21']);
    expect(result.source).toBe('app.brushes');
  });
});

/**
 * A host that honours the alpha in a fill descriptor.
 *
 * `drawingHost` paints every covered pixel solid, which is the right stub for
 * geometry and exactly the wrong one for opacity: it would make a stroke asked
 * at 20% and one asked at 100% indistinguishable. This one reads
 * `opacity._value` and blends, which is what Photoshop does with it.
 */
function alphaHost(width = 400, height = 300) {
  const pixels = new Map<string, Rgb>();
  const key = (x: number, y: number) => `${x},${y}`;
  const ellipses: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  let rgb = WHITE;

  const layer = { id: 7, name: 'Layer 1' };
  const document: Record<string, unknown> = {
    id: 1,
    name: 'alpha.psd',
    width,
    height,
    resolution: 72,
    mode: 'RGB',
    layers: [layer],
    backgroundLayer: layer,
    activeLayer: layer,
    activeLayers: [layer],
    saved: true,
    zoom: 100,
    selection: {
      selectEllipse: (bounds: { left: number; top: number; right: number; bottom: number }) => {
        ellipses.push(bounds);
        return Promise.resolve();
      },
      deselect: () => Promise.resolve(),
    },
    sampleColor: (p: { x: number; y: number }) => pixels.get(key(p.x, p.y)) ?? WHITE,
    createLayer: () => ({ id: 99, name: 'Stroke' }),
  };

  const photoshop = photoshopStub() as Record<string, unknown>;
  (photoshop.action as { batchPlay: unknown }).batchPlay = (descriptors: unknown) => {
    for (const descriptor of descriptors as Array<Record<string, unknown>>) {
      const spec = descriptor as { _obj?: string; to?: { _obj?: string; red?: number; green?: number; blue?: number }; opacity?: { _value?: number } };
      if (spec._obj === 'set' && spec.to?._obj === 'RGBColor') {
        rgb = { r: spec.to.red ?? 0, g: spec.to.green ?? 0, b: spec.to.blue ?? 0 };
        continue;
      }
      const percent = spec.opacity?._value;
      const a = typeof percent === 'number' ? percent / 100 : 1;
      const box = ellipses[ellipses.length - 1];
      if (!box) continue;
      for (let y = box.top; y < box.bottom; y += 1) {
        for (let x = box.left; x < box.right; x += 1) {
          const under = pixels.get(key(x, y)) ?? WHITE;
          pixels.set(key(x, y), {
            r: Math.round(under.r * (1 - a) + rgb.r * a),
            g: Math.round(under.g * (1 - a) + rgb.g * a),
            b: Math.round(under.b * (1 - a) + rgb.b * a),
          });
        }
      }
    }
    return Promise.resolve([{}]);
  };
  photoshop.app = { activeDocument: document, documents: [document], foregroundColor: {} };
  return { photoshop, pixels, darkness: (x: number, y: number) => {
    const c = pixels.get(key(x, y)) ?? WHITE;
    return 100 - ((c.r + c.g + c.b) / 3 / 255) * 100;
  } };
}

describe('stroke opacity', () => {
  const line = [{ x: 20, y: 150 }, { x: 380, y: 150 }];

  it('lands on the opacity asked for rather than five times denser', async () => {
    // The discs overlap five deep, so handing each of them the requested alpha
    // composited to 76.5% for a stroke asked at 25% — measured on Photoshop
    // 26.11, and reproducible here because the host blends exactly as it does.
    for (const opacity of [25, 50, 75]) {
      const host = alphaHost();
      const brush = loadBrush(host.photoshop);
      await brush.paint_stroke({ params: { ...baseParams, brushSize: 40, opacity, color: BLACK, points: line } });
      expect(Math.abs(host.darkness(200, 150) - opacity)).toBeLessThan(3);
    }
  });

  it('leaves a full-opacity stroke full and a faint one faint', async () => {
    const full = alphaHost();
    await loadBrush(full.photoshop).paint_stroke({ params: { ...baseParams, brushSize: 40, opacity: 100, color: BLACK, points: line } });

    const faint = alphaHost();
    await loadBrush(faint.photoshop).paint_stroke({ params: { ...baseParams, brushSize: 40, opacity: 15, color: BLACK, points: line } });

    expect(full.darkness(200, 150)).toBeGreaterThan(99);
    expect(faint.darkness(200, 150)).toBeLessThan(20);
    expect(faint.darkness(200, 150)).toBeGreaterThan(10);
  });

  it('divides the alpha by the overlap the geometry actually produced', () => {
    // Pure check on the conversion, so a change in stamp spacing cannot quietly
    // change what `opacity` means.
    const alpha = (opacity: number, radius: number, stamps: number) =>
      loadBrush(photoshopStub() as never).strokeAlpha(opacity, radius, stamps) as number;

    expect(alpha(100, 60, 5)).toBe(100);
    expect(alpha(0, 60, 5)).toBe(0);

    // Stated as the property rather than a constant: `spacing` is 0.4 of the
    // radius, so five discs stack on a centreline pixel, and the per-disc alpha
    // has to be the one whose five-fold composite is the requested 25%.
    const fiveDeep = alpha(25, 60, 40) / 100;
    expect(1 - Math.pow(1 - fiveDeep, 5)).toBeCloseTo(0.25, 6);

    // A stroke with no overlap must not be dimmed by a divisor borrowed from a
    // long one: a single disc asked at 25% is 25%, not a fifth of it.
    expect(alpha(25, 60, 1)).toBeCloseTo(25, 6);
    // Fewer discs means less to divide by, so the per-disc alpha is *higher*.
    expect(alpha(25, 60, 2)).toBeLessThan(alpha(25, 60, 1));
    expect(alpha(25, 60, 40)).toBeLessThan(alpha(25, 60, 2));
  });
});
