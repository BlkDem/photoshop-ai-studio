import { describe, expect, it } from 'vitest';

import { loadPluginFile, loadPurePluginFile, photoshopStub, type Stub } from './harness.js';

/**
 * Synthesized-tip tests.
 *
 * Photoshop's brush engine cannot be reached on this host from either UXP or
 * ExtendScript, so a soft edge has to be *geometry*: concentric discs filled
 * largest-first. These tests pin down the three things that decide whether that
 * works, and one thing that decides whether it can be trusted.
 *
 *  1. **The flat path is untouched.** A caller who asks for no tip must get
 *     exactly the stroke they got before tips existed — one disc per stamp, one
 *     fill per disc. Otherwise adding a feature silently changes every existing
 *     painting.
 *  2. **Order is largest-first.** Painting the dense core first and the wash last
 *     lets the wash win, and every mark comes out flat and grey. This is asserted
 *     by reading the actual ellipse sequence, not by trusting the code order.
 *  3. **The rim is genuinely fainter.** A ring stack at uniform alpha is a
 *     slightly larger disc, not a soft brush.
 *  4. **The result never claims a real brush.** `methodUsed` and
 *     `tipIsSynthesized` exist so a caller cannot mistake this for one.
 */

interface FillShape {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Host {
  photoshop: Stub;
  ellipses: FillShape[];
  /** Opacity percentage of each fill, in call order. */
  alphas: number[];
  pixels: Map<string, { r: number; g: number; b: number }>;
}

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

/**
 * A host that composites each fill at its declared opacity rather than painting
 * it solid. That is deliberate: a test that painted every fill opaquely could not
 * tell a soft edge from a hard one, which is the only thing under test here.
 */
function alphaHost(width = 400, height = 300): Host {
  const ellipses: FillShape[] = [];
  const alphas: number[] = [];
  const pixels = new Map<string, { r: number; g: number; b: number }>();

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
      selectEllipse: (bounds: FillShape) => {
        ellipses.push(bounds);
        return Promise.resolve();
      },
      deselect: () => Promise.resolve(),
    },
    // Must read the real buffer: the plugin samples before and after the stroke
    // and refuses a stroke whose pixels did not move. A constant here would make
    // every test below fail as "nothing changed".
    sampleColor: (point: { x: number; y: number }) => pixels.get(`${point.x},${point.y}`) ?? WHITE,
    createLayer: (options?: { name?: string }) => ({ id: 99, name: options?.name ?? 'Stroke' }),
  };

  const photoshop = photoshopStub() as Record<string, unknown>;
  (photoshop.action as { batchPlay: unknown }).batchPlay = (descriptors: unknown) => {
    const descriptor = Array.isArray(descriptors) ? descriptors[0] : descriptors;
    const box = ellipses[ellipses.length - 1];
    // `withForegroundColor` issues a fill before the stroke starts, with nothing
    // selected. That is not a stroke fill and must not be counted as one.
    if (!box) return Promise.resolve([{}]);

    const opacityField = (descriptor as { opacity?: { _value?: number } } | undefined)?.opacity;
    const alpha = typeof opacityField?._value === 'number' ? opacityField._value : 100;
    alphas.push(alpha);

    const strength = alpha / 100;
    for (let y = box.top; y < box.bottom; y += 1) {
      for (let x = box.left; x < box.right; x += 1) {
        const key = `${x},${y}`;
        const existing = pixels.get(key) ?? WHITE;
        pixels.set(key, {
          r: Math.round(existing.r + (BLACK.r - existing.r) * strength),
          g: Math.round(existing.g + (BLACK.g - existing.g) * strength),
          b: Math.round(existing.b + (BLACK.b - existing.b) * strength),
        });
      }
    }
    return Promise.resolve([{}]);
  };
  photoshop.app = { activeDocument: document, documents: [document], foregroundColor: {} };

  return { photoshop: photoshop as unknown as Stub, ellipses, alphas, pixels };
}

interface BrushModule {
  stroke_path(ctx: unknown): Promise<Record<string, unknown>>;
}

interface Geometry {
  MIN_FILL_ALPHA: number;
  tipRings(radius: number, tip: unknown): Array<{ radius: number; weight: number }>;
  stampSpacing(radius: number): number;
  stampSpacingAt(radius: number, fraction: number | undefined): number;
  overlapDivisor(radius: number, spacing: number, steps: number): number;
  ringFillAlpha(opacity: number, radius: number, spacing: number, steps: number, weight: number): number;
}

const loadBrush = (photoshop: Stub): BrushModule =>
  loadPluginFile('lib/ops/brush.js', undefined, photoshop) as unknown as BrushModule;
const loadGeometry = (): Geometry => loadPurePluginFile('lib/ops/stroke-geometry.js') as unknown as Geometry;

const SOFT_TIP = { core: 0.3, steps: 4, outerAlpha: 0.15 };

/** One short horizontal stroke, so stamp counts stay easy to reason about. */
function stroke(
  brush: BrushModule,
  extra: Record<string, unknown>,
  from: [number, number] = [200, 150],
  to: [number, number] = [240, 150],
): Promise<Record<string, unknown>> {
  return brush.stroke_path({
    params: {
      documentId: 'active',
      brushSize: 20,
      color: { r: 0, g: 0, b: 0 },
      opacity: 100,
      ...extra,
      path: [
        { type: 'move', point: { x: from[0], y: from[1] } },
        { type: 'line', point: { x: to[0], y: to[1] } },
      ],
    },
  });
}

describe('tipRings', () => {
  it('returns a single full-alpha disc for a flat tip', () => {
    expect(loadGeometry().tipRings(50, null)).toEqual([{ radius: 50, weight: 1 }]);
    expect(loadGeometry().tipRings(50, { core: 1, steps: 1, outerAlpha: 1 })).toEqual([
      { radius: 50, weight: 1 },
    ]);
  });

  it('orders rings largest first', () => {
    const rings = loadGeometry().tipRings(50, SOFT_TIP);
    expect(rings).toHaveLength(4);
    for (let i = 1; i < rings.length; i += 1) {
      expect(rings[i]?.radius).toBeLessThan(rings[i - 1]?.radius ?? 0);
    }
  });

  it('makes the innermost ring opaque and the outermost faint', () => {
    const rings = loadGeometry().tipRings(50, SOFT_TIP);
    expect(rings[rings.length - 1]?.weight).toBe(1);
    expect(rings[0]?.weight).toBeCloseTo(0.15, 6);
  });

  it('gives a soft tip a smaller opaque core than a hard one', () => {
    const rings = loadGeometry().tipRings(50, SOFT_TIP);
    const coreRadius = rings[rings.length - 1]?.radius ?? 0;
    expect(coreRadius).toBeLessThan(50);
  });

  it('clamps a nonsensical steps value rather than looping forever', () => {
    expect(loadGeometry().tipRings(50, { core: 0.5, steps: 999, outerAlpha: 0.2 }).length).toBeLessThanOrEqual(8);
    expect(loadGeometry().tipRings(50, { core: 0.5, steps: 0, outerAlpha: 0.2 }).length).toBe(1);
  });
});

describe('spacing', () => {
  it('keeps the historical rule when no fraction is given', () => {
    const geometry = loadGeometry();
    expect(geometry.stampSpacingAt(50, undefined)).toBe(geometry.stampSpacing(50));
  });

  it('honours an explicit fraction', () => {
    expect(loadGeometry().stampSpacingAt(50, 0.2)).toBeCloseTo(10, 6);
  });

  it('never separates discs, even at the coarsest setting', () => {
    // Discs one radius apart still overlap out to 2r, so the mark stays solid.
    expect(loadGeometry().stampSpacingAt(50, 1)).toBeLessThanOrEqual(50);
  });
});

describe('overlap compensation', () => {
  it('lightens each fill when rings stack on the same pixel', () => {
    const geometry = loadGeometry();
    const flat = geometry.ringFillAlpha(0.5, 50, 0.4, 1, 1);
    const stacked = geometry.ringFillAlpha(0.5, 50, 0.4, 4, 1);
    expect(stacked).toBeLessThan(flat);
    expect(stacked).toBeGreaterThan(0);
  });

  it('lands the stroke at the requested opacity rather than undershooting', () => {
    const geometry = loadGeometry();
    const divisor = geometry.overlapDivisor(50, 0.4, 4);
    const perFill = geometry.ringFillAlpha(0.6, 50, 0.4, 4, 1);
    expect(1 - Math.pow(1 - perFill, divisor)).toBeCloseTo(0.6, 6);
  });

  it('returns 0 for a zero-opacity stroke and 1 for a full one', () => {
    const geometry = loadGeometry();
    expect(geometry.ringFillAlpha(0, 50, 0.4, 4, 1)).toBe(0);
    expect(geometry.ringFillAlpha(1, 50, 0.4, 4, 1)).toBe(1);
  });
});

describe('a stroke with no tip is unchanged', () => {
  it('fills exactly one disc per stamp', async () => {
    const host = alphaHost();
    const result = await stroke(loadBrush(host.photoshop), {});

    expect(result.methodUsed).toBe('rasterized-stroke');
    expect(result.tipIsSynthesized).toBeNull();
    expect(host.alphas.length).toBe(host.ellipses.length);
    expect(Number(result.stampsPainted)).toBe(host.ellipses.length);
  });

  it('fills every disc at one alpha', async () => {
    const host = alphaHost();
    await stroke(loadBrush(host.photoshop), {});
    expect(new Set(host.alphas.map((a) => Math.round(a * 100)))).toHaveLength(1);
  });

  it('treats an explicit single-step tip as flat', async () => {
    const host = alphaHost();
    const result = await stroke(loadBrush(host.photoshop), {
      tip: { core: 1, steps: 1, outerAlpha: 1 },
    });
    expect(host.ellipses.length).toBe(Number(result.stampsPainted));
  });
});

describe('a stroke with a tip', () => {
  it('fills several rings per stamp', async () => {
    const host = alphaHost();
    const result = await stroke(loadBrush(host.photoshop), { tip: SOFT_TIP });
    // `stampsPainted` counts fills, so a ring stack multiplies it by `steps`.
    expect(Number(result.stampsPainted) % SOFT_TIP.steps).toBe(0);
    expect(host.ellipses.length).toBe(Number(result.stampsPainted));
  });

  it('fills each ring largest first, so the core lands last', async () => {
    const host = alphaHost();
    await stroke(loadBrush(host.photoshop), { tip: SOFT_TIP });

    // Checked *within* each stamp: the sequence restarts at the widest disc for
    // every stamp, so comparing across stamps would only prove the path repeated.
    const rings = SOFT_TIP.steps;
    for (let stamp = 0; stamp * rings < host.ellipses.length; stamp += 1) {
      const widths = host.ellipses.slice(stamp * rings, stamp * rings + rings).map((e) => e.right - e.left);
      for (let i = 1; i < widths.length; i += 1) {
        expect(widths[i]).toBeLessThanOrEqual(widths[i - 1] ?? 0);
      }
    }
  });

  it('fades the rim: outer rings are filled at a lower alpha', async () => {
    const host = alphaHost();
    // A full-opacity stroke hides the falloff by definition, so this has to be
    // translucent for there to be anything to see.
    await stroke(loadBrush(host.photoshop), { tip: SOFT_TIP, opacity: 60 });

    const rings = SOFT_TIP.steps;
    const outer = host.alphas[0] ?? 0;
    const inner = host.alphas[rings - 1] ?? 0;
    expect(outer).toBeLessThan(inner);
    expect(inner).toBeGreaterThan(0);
  });

  it('produces a genuinely soft edge rather than a slightly larger disc', async () => {
    const host = alphaHost();
    await stroke(loadBrush(host.photoshop), { tip: SOFT_TIP, opacity: 70 }, [200, 150], [200, 150]);

    // Sample outward from the centre of a dab. A hard 20px disc is fully opaque
    // to the rim and empty past it; a soft tip must fade across the last few
    // pixels rather than stopping dead.
    const centre = host.pixels.get('200,150')?.r ?? 255;
    const nearRim = host.pixels.get('208,150')?.r ?? 255;
    expect(centre).toBeLessThan(nearRim);
  });

  it('reports the tip and insists it was synthesized', async () => {
    const host = alphaHost();
    const result = await stroke(loadBrush(host.photoshop), { tip: SOFT_TIP });

    expect(result.methodUsed).toBe('rasterized-stroke-synthesized-tip');
    expect(result.tipIsSynthesized).toBe(true);
    expect(result.tip).toEqual(SOFT_TIP);
  });

  it('still proves pixels moved', async () => {
    const host = alphaHost();
    const result = await stroke(loadBrush(host.photoshop), { tip: SOFT_TIP });
    expect(result.samplesChecked).toBeGreaterThan(0);
    expect(result.verified).toBe(true);
  });
});

describe('the spacing dial', () => {
  it('produces more discs when denser', async () => {
    const dense = alphaHost();
    await stroke(loadBrush(dense.photoshop), { spacing: 0.2 });
    const coarse = alphaHost();
    await stroke(loadBrush(coarse.photoshop), { spacing: 0.9 });

    expect(dense.ellipses.length).toBeGreaterThan(coarse.ellipses.length);
  });

  it('still lands a continuous mark at the coarsest setting', async () => {
    const host = alphaHost();
    await stroke(loadBrush(host.photoshop), { spacing: 1 }, [100, 150], [300, 150]);

    // Walk the centreline between the two endpoints: no gap, or the stroke is a
    // dotted line. The ends themselves are excluded because a mark legitimately
    // tapers where it starts and stops.
    let gap = false;
    for (let x = 112; x <= 288; x += 1) {
      if ((host.pixels.get(`${x},150`)?.r ?? 255) > 250) gap = true;
    }
    expect(gap).toBe(false);
  });
});
describe('the per-fill alpha floor', () => {
  it('never asks Photoshop for a fill too faint to deposit', () => {
    // Denser spacing drives the compensation down: at `spacing: 0.12` on a 90px
    // brush the core ring worked out at 2.4%, which Photoshop declined to lay
    // down — so the stroke completed all 688 fills and painted nothing. Stroke
    // verification caught it, but the engine should not request an invisible fill.
    const geometry = loadGeometry();
    for (const spacing of [0.4, 0.28, 0.2, 0.12, 0.08]) {
      const alpha = geometry.ringFillAlpha(0.8, 45, spacing, 4, 1);
      expect(alpha, `spacing ${spacing}`).toBeGreaterThanOrEqual(geometry.MIN_FILL_ALPHA);
    }
  });

  it('floors the base alpha, not the product, so the rim still fades', () => {
    // Flooring the product clamps the faint rim to the core's alpha and the soft
    // edge collapses into a flat disc — which defeats the purpose of a tip.
    const geometry = loadGeometry();
    const core = geometry.ringFillAlpha(0.8, 45, 0.12, 4, 1);
    const rim = geometry.ringFillAlpha(0.8, 45, 0.12, 4, 0.15);
    expect(core).toBeGreaterThan(rim);
    expect(rim).toBeGreaterThan(0);
  });

  it('leaves a zero-opacity stroke at zero', () => {
    expect(loadGeometry().ringFillAlpha(0, 45, 0.12, 4, 1)).toBe(0);
  });
});
