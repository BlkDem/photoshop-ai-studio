import { describe, expect, it } from 'vitest';

import { loadPluginFile, photoshopStub } from './harness.js';

type Rgb = { r: number; g: number; b: number };
type Stub = Record<string, unknown>;

interface Host {
  photoshop: Stub;
  pixels: Map<string, Rgb>;
  rectangles: Array<{ left: number; top: number; right: number; bottom: number }>;
  ellipses: Array<{ left: number; top: number; right: number; bottom: number }>;
  fills: number;
  events: string[];
  foregroundAt: number[];
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/**
 * A host whose canvas starts white and takes the foreground colour wherever a
 * fill lands.
 *
 * Unlike the brush host, this one honours the colour a fill is given, because a
 * gradient is *only* its colours: a stub that painted everything black would let
 * a ramp assembled from the wrong stops pass every check.
 */
function gradientHost(width = 400, height = 300): Host {
  const pixels = new Map<string, Rgb>();
  const rectangles: Host['rectangles'] = [];
  const ellipses: Host['ellipses'] = [];
  const events: string[] = [];
  const foregroundAt: number[] = [];
  const key = (x: number, y: number) => `${x},${y}`;

  let foreground: Rgb = WHITE;
  const layer = { id: 7, name: 'Layer 1' };
  let fills = 0;

  const paint = (box: { left: number; top: number; right: number; bottom: number }) => {
    fills += 1;
    events.push('fill');
    for (let y = box.top; y < box.bottom; y += 1) {
      for (let x = box.left; x < box.right; x += 1) pixels.set(key(x, y), { ...foreground });
    }
  };

  const document: Record<string, unknown> = {
    id: 1,
    name: 'ramp.psd',
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
      selectRectangle: (bounds: Host['rectangles'][number]) => {
        rectangles.push(bounds);
        return Promise.resolve();
      },
      selectEllipse: (bounds: Host['ellipses'][number]) => {
        ellipses.push(bounds);
        return Promise.resolve();
      },
      deselect: () => {
        events.push('deselect');
        return Promise.resolve();
      },
    },
    sampleColor: (point: { x: number; y: number }) => pixels.get(key(point.x, point.y)) ?? WHITE,
    // 0×0 on purpose: this host cannot create a usable pixel layer, which is what
    // the plugin has to notice rather than report a gradient that filled nothing.
    createLayer: (options?: { name?: string }) => ({ id: 99, name: options?.name ?? 'Gradient', bounds: { left: 0, top: 0, right: 0, bottom: 0 } }),
  };

  // Built on the shared stub so `constants.LayerKind` and the rest of the host
  // surface `ps.js` reads are present; only the document and the fill are ours.
  const photoshop = photoshopStub() as Record<string, unknown>;
  (photoshop.action as { batchPlay: unknown }).batchPlay = (descriptors: unknown) => {
    const list = descriptors as Array<Record<string, unknown>>;
    for (const descriptor of list) {
      if (descriptor._obj === 'set') {
        // `withForegroundColor` builds `{_obj:'RGBColor', red, green, blue}` —
        // Photoshop's channel names, not the short ones the rest of this project
        // uses, because this is the one value that crosses into its vocabulary.
        const to = descriptor.to as { _obj?: string; red: number; green: number; blue: number };
        if (to && to._obj === 'RGBColor') {
          foreground = { r: to.red, g: to.green, b: to.blue };
          foregroundAt.push(to.red);
          continue;
        }
      }
      const box = rectangles[rectangles.length - 1] ?? ellipses[ellipses.length - 1];
      if (!box) continue;
      paint(box);
    }
    return Promise.resolve([{}]);
  };
  photoshop.app = { activeDocument: document, documents: [document], foregroundColor: {} };

  return { photoshop, pixels, rectangles, ellipses, fills, events, foregroundAt };
}

interface GradientModule {
  paint_gradient(ctx: { op: string; params: Record<string, unknown> }): Promise<Record<string, unknown>>;
}

function loadGradient(photoshop: Stub): GradientModule {
  return loadPluginFile('lib/ops/gradient.js', undefined, photoshop) as unknown as GradientModule;
}

const NIGHT_TO_DAWN = [
  { position: 0, color: { r: 8, g: 16, b: 40 } },
  { position: 100, color: { r: 250, g: 214, b: 160 } },
];

const run = (gradient: GradientModule, params: Record<string, unknown>) =>
  gradient.paint_gradient({ op: 'paint_gradient', params: { documentId: 'active', ...params } });

describe('paint_gradient', () => {
  it('reports the rasterized method and a canvas that changed', async () => {
    const host = gradientHost();
    const result = await run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 8 });

    expect(result.success).toBe(true);
    expect(result.methodUsed).toBe('rasterized-gradient');
    expect(result.bandsPainted).toBe(8);
    expect(result.samplesChecked).toBeGreaterThan(0);
    expect(result.samplesChanged).toBeGreaterThan(0);
    expect(result.verified).toBe(true);
  });

  it('paints the ramp dark at the top and light at the bottom', async () => {
    const host = gradientHost();
    await run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 8, direction: 'topToBottom' });

    const top = host.pixels.get('200,10');
    const bottom = host.pixels.get('200,290');
    expect(top).toBeDefined();
    expect(bottom).toBeDefined();
    // Sky darkening into dawn, not the other way round.
    expect(top!.r).toBeLessThan(bottom!.r);
    expect(top!.b).toBeLessThan(bottom!.b);
  });

  it('fills rectangles for a linear ramp and ellipses for a radial one', async () => {
    const linear = gradientHost();
    await run(loadGradient(linear.photoshop), { stops: NIGHT_TO_DAWN, bands: 4 });
    expect(linear.rectangles).toHaveLength(4);
    expect(linear.ellipses).toHaveLength(0);

    const radial = gradientHost();
    await run(loadGradient(radial.photoshop), { stops: NIGHT_TO_DAWN, bands: 4, type: 'radial' });
    expect(radial.ellipses).toHaveLength(4);
    expect(radial.rectangles).toHaveLength(0);
  });

  it('always clears the selection it replaced', async () => {
    const host = gradientHost();
    await run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 4 });
    expect(host.events.filter((e) => e === 'deselect')).toHaveLength(1);
  });

  it('clears the selection even when a band fails', async () => {
    // Leaving it behind would hand every later tool a marching-ants band
    // nobody asked for.
    const host = gradientHost();
    const document = (host.photoshop.app as { activeDocument: Record<string, unknown> }).activeDocument;
    let calls = 0;
    (document.selection as { selectRectangle: unknown }).selectRectangle = () => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('Photoshop said no')) : Promise.resolve();
    };

    await expect(run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 4 })).rejects.toThrow();
    expect(host.events.filter((e) => e === 'deselect')).toHaveLength(1);
  });

  it('refuses to paint on a layer this host cannot give any pixels to', async () => {
    const host = gradientHost();
    await expect(run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 4, newLayer: true })).rejects.toThrow(
      /0×0/,
    );
  });

  it('fails rather than claiming success when nothing on the canvas moved', async () => {
    // The gradient is the same colour the canvas already is.
    const host = gradientHost();
    const same = [
      { position: 0, color: WHITE },
      { position: 100, color: WHITE },
    ];
    await expect(run(loadGradient(host.photoshop), { stops: same, bands: 4 })).rejects.toThrow(/no sampled pixel/);
  });

  it('reports a blur it could not apply instead of implying a smooth finish', async () => {
    // The stub has no `applyGaussianBlur`, so the ramp lands with its seams. The
    // fill still counts as done — the pixels are there — but `smoothed` has to
    // be false, because a `true` here would be the one claim nobody checked.
    const host = gradientHost();
    const result = await run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 4, smoothRadius: 8 });
    expect(result.success).toBe(true);
    expect(result.smoothed).toBe(false);
    // The reason has to travel back: the commonest cause is a locked Background
    // layer, which the caller cannot see from where it is standing.
    expect(String(result.smoothError)).toMatch(/applyFilter|not a function|Could not transform/);
  });

  it('says nothing about smoothing when none was asked for', async () => {
    const host = gradientHost();
    const result = await run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 4 });
    expect(result.smoothed).toBe(false);
    expect(result.smoothError).toBeUndefined();
  });

  it('applies the blur when the host can, and says so', async () => {
    // The inverse case: a host that does have the filter must be believed, or
    // `smoothed` would be permanently false and callers would stop trusting it.
    const host = gradientHost();
    const layer = (host.photoshop.app as { activeDocument: { layers: unknown[] } }).activeDocument.layers[0] as {
      applyGaussianBlur: (radius: number) => Promise<void>;
    };
    let blurred = 0;
    layer.applyGaussianBlur = async (radius: number) => {
      blurred = radius;
    };

    const result = await run(loadGradient(host.photoshop), { stops: NIGHT_TO_DAWN, bands: 4, smoothRadius: 6 });
    expect(result.smoothed).toBe(true);
    expect(blurred).toBe(6);
  });
});