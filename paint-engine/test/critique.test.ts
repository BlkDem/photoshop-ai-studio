/**
 * Critic tests.
 *
 * Every case builds the image it wants rather than describing one, so each
 * assertion pins a number the test itself chose. That matters more here than
 * elsewhere: a critic that reads a plan instead of a picture would pass tests
 * written from plans, and these are written from pixels.
 */

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../src/critique/png.js';
import { measure } from '../src/critique/metrics.js';
import { critique, formatCritique, DEFAULT_THRESHOLDS } from '../src/critique/critic.js';
import type { PaintingPlan } from '../src/types.js';
import type { RgbImage } from '../src/critique/png.js';

const PLAN: PaintingPlan = {
  title: 'seascape',
  canvas: { width: 200, height: 100 },
  style: {
    medium: 'oil',
    brushCharacter: 'oil',
    contrast: 'high',
    atmosphere: 'stormy',
    texture: 'moderate',
    edgeCharacter: 'soft',
    colorTemperature: 'cool',
    detailLevel: 0.6,
  },
  composition: {
    framework: 'ruleOfThirds',
    horizon: 0.6,
    focalPoint: { x: 0.5, y: 0.3 },
    regions: {},
  },
  palette: {
    shadows: ['#000000'],
    midtones: ['#808080'],
    highlights: ['#ffffff'],
    accents: ['#ff0000'],
    base: ['#808080'],
  },
  layers: ['Sky', 'Water'],
  stages: [],
  seed: 1,
  maxIterations: 1,
};

/** Paints an image from a per-pixel function. */
function paint(width: number, height: number, fn: (x: number, y: number) => [number, number, number]): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return { width, height, rgb };
}

/** Encodes a solid or two-tone image as a PNG, for the decoder tests. */
function encodePng(image: RgbImage): Uint8Array {
  const raw = Buffer.alloc((image.width * 3 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const at = y * (image.width * 3 + 1);
    raw[at] = 0;
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 3;
      raw[at + 1 + x * 3] = image.rgb[i]!;
      raw[at + 1 + x * 3 + 1] = image.rgb[i + 1]!;
      raw[at + 1 + x * 3 + 2] = image.rgb[i + 2]!;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), body])), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

describe('decodePng', () => {
  it('round-trips an image', () => {
    const source = paint(7, 5, (x, y) => [x * 30, y * 50, (x + y) * 20]);
    const decoded = decodePng(encodePng(source));
    expect(decoded).not.toBeNull();
    expect([...decoded!.rgb]).toEqual([...source.rgb]);
  });

  it('declines something that is not a PNG rather than guessing', () => {
    expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('declines a truncated file instead of reading past the end', () => {
    // Cut into the compressed image data rather than off the end: a file missing
    // only its IEND chunk is still a perfectly good picture, and a test that
    // expects it to fail would be asserting that the decoder is needlessly strict.
    const png = encodePng(paint(40, 40, () => [1, 2, 3]));
    expect(decodePng(png.subarray(0, Math.floor(png.length / 2)))).toBeNull();
  });
});

describe('measure', () => {
  it('reports the value range of a two-tone image', () => {
    const m = measure(paint(50, 50, (_x, y) => (y < 25 ? [0, 0, 0] : [255, 255, 255])));
    expect(m.valueRange[0]).toBeCloseTo(0, 2);
    expect(m.valueRange[1]).toBeCloseTo(1, 2);
  });

  it('finds a horizon when the two halves differ', () => {
    const m = measure(paint(50, 100, (_x, y) => (y < 60 ? [240, 240, 240] : [20, 20, 20])), { horizon: 0.6 });
    expect(m.horizonDelta).toBeGreaterThan(0.5);
  });

  it('reports no horizon when the two halves match', () => {
    const m = measure(paint(50, 100, (_x, y) => (y < 60 ? [128, 128, 128] : [128, 128, 128])), { horizon: 0.6 });
    expect(m.horizonDelta).toBeLessThan(0.01);
  });

  it("measures coverage against the median of the image, not against white", () => {
    // A picture that is entirely dark is fully covered by any test against white,
    // and reports near-zero coverage against its own median.
    const dark = measure(paint(40, 40, () => [20, 20, 20]));
    expect(dark.coverage).toBeLessThan(0.01);

    const marked = measure(paint(40, 40, (x) => (x < 20 ? [20, 20, 20] : [230, 230, 230])));
    expect(marked.coverage).toBeGreaterThan(0.4);
  });

  it('sees saturation when there is colour and none when there is not', () => {
    const grey = measure(paint(20, 20, () => [128, 128, 128]));
    expect(grey.saturation).toBeLessThan(0.001);
    const blue = measure(paint(20, 20, () => [40, 80, 200]));
    expect(blue.saturation).toBeGreaterThan(0.5);
  });

  it('finds local variation at the focal point when it exists', () => {
    const focused = paint(100, 100, (x, y) =>
      x > 40 && x < 60 && y > 40 && y < 60 ? (x % 2 === 0 ? [250, 250, 250] : [10, 10, 10]) : [128, 128, 128],
    );
    const m = measure(focused, { focalPoint: { x: 0.5, y: 0.5 } });
    expect(m.focalEmphasis).toBeGreaterThan(DEFAULT_THRESHOLDS.minFocalEmphasis)
  });
});

describe('critique', () => {
  const ids = (c: ReturnType<typeof critique>) => c.findings.map((f) => f.id);

  it('finds nothing wrong with a picture that has range, coverage and a horizon', () => {
    const good = paint(100, 100, (x, y) => {
      if (y < 60) return x > 45 && x < 55 ? [250, 250, 250] : [200, 210, 225];
      return x % 7 < 3 ? [30, 40, 70] : [20, 30, 55];
    });
    const c = critique(PLAN, good);
    expect(ids(c)).not.toContain('horizon');
    expect(ids(c)).not.toContain('value-range');
    expect(c.structureScore).toBeGreaterThan(80);
  });

  it('names the invisible horizon, with the number that proved it', () => {
    const flat = paint(100, 100, () => [128, 128, 128]);
    const c = critique(PLAN, flat);
    const horizon = c.findings.find((f) => f.id === 'horizon');
    expect(horizon).toBeDefined();
    expect(horizon!.measured).toContain('across the horizon');
  });

  it('names a value range with no room in it', () => {
    const fog = paint(100, 100, (_x, y) => [100 + (y > 60 ? 3 : 0), 100 + (y > 60 ? 3 : 0), 100 + (y > 60 ? 3 : 0)]);
    const c = critique(PLAN, fog);
    expect(ids(c)).toContain('value-range');
    expect(c.findings.find((f) => f.id === 'value-range')!.severity).toBe('fault');
  });

  it('says a grey picture is grey without calling it a fault', () => {
    // A tuple in both halves. An array of one element destructures to
    // (value, undefined, undefined), which Uint8Array coerces to (value, 0, 0) —
    // so the "grey" image was half red, and the critic was right to object.
    const shade = (x: number) => (x % 5 === 0 ? 25 : 20);
    const grey = paint(100, 100, (x, y) =>
      y < 60 ? [200, 200, 200] : [shade(x), shade(x), shade(x)],
    );
    const c = critique(PLAN, grey);
    const s = c.findings.find((f) => f.id === 'saturation');
    expect(s?.severity).toBe('note');
  });

  it('warns when the canvas is mostly untouched ground', () => {
    // One small mark on an empty field. A two-tone image would not do: it covers
    // every pixel and reports full coverage while saying nothing about whether
    // anything was painted.
    const mostlyGround = paint(100, 100, (x, y) => (x < 8 && y < 8 ? [0, 0, 0] : [250, 250, 250]));
    const c = critique(PLAN, mostlyGround);
    expect(ids(c)).toContain('coverage');
    expect(c.metrics.coverage).toBeLessThan(DEFAULT_THRESHOLDS.minCoverage);
  });

  it('is repeatable: the same picture always scores the same', () => {
    const image = paint(60, 60, (x, y) => [x * 4, y * 4, 100]);
    expect(critique(PLAN, image).structureScore).toBe(critique(PLAN, image).structureScore);
  });

  it('reports the metrics even when it has nothing to say', () => {
    const good = paint(100, 100, (x, y) => (y < 60 ? [210, 215, 230] : [30, 40, 70]));
    const c = critique(PLAN, good);
    expect(c.metrics.width).toBe(100);
  });

  it('formats a report that fits on a screen', () => {
    const c = critique(PLAN, paint(100, 100, () => [128, 128, 128]), { label: 'fog' });
    const text = formatCritique(c, 'fog');
    expect(text).toContain('fog');
    expect(text).toContain('horizon');
    expect(text.split('\n').length).toBeLessThan(30);
  });
});