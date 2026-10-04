import { describe, expect, it } from 'vitest';

import { loadPurePluginFile } from '../../photoshop-plugin/test/harness.js';
import {
  colorAt as mockColorAt,
  linearBands as mockLinearBands,
  normalizeStops as mockNormalizeStops,
  radialBands as mockRadialBands,
  gradientVerificationPoints as mockVerificationPoints,
} from '../src/adapter/gradient-geometry.js';

/**
 * The mock and the plugin both resolve a gradient into bands, and they have to
 * agree exactly — the mock is where a plan is rehearsed, so a disagreement here
 * is a gradient that looks one way in rehearsal and another in Photoshop.
 *
 * They cannot share code (the plugin is build-free CommonJS for a UXP host, and
 * `shared` is not allowed to import it), so both files are loaded and run
 * through the same cases here.
 */

interface Stop {
  position: number;
  color: { r: number; g: number; b: number };
  opacity?: number;
}
interface Band {
  bounds: { left: number; top: number; right: number; bottom: number };
  color: { r: number; g: number; b: number };
  t: number;
}

const plugin = loadPurePluginFile<{
  normalizeStops(stops: Stop[]): Array<{ position: number; color: { r: number; g: number; b: number } }>;
  colorAt(stops: ReturnType<typeof plugin.normalizeStops>, t: number): { r: number; g: number; b: number };
  linearBands(options: Record<string, unknown>): { bands: Band[]; truncated: boolean };
  radialBands(options: Record<string, unknown>): { bands: Band[]; truncated: boolean };
  verificationPoints(options: Record<string, unknown>, limit?: number): Array<{ x: number; y: number }>;
}>('lib/ops/gradient-geometry.js');

const BLACK_TO_WHITE: Stop[] = [
  { position: 0, color: { r: 0, g: 0, b: 0 } },
  { position: 100, color: { r: 255, g: 255, b: 255 } },
];

const SKY: Stop[] = [
  { position: 0, color: { r: 12, g: 28, b: 64 } },
  { position: 55, color: { r: 74, g: 128, b: 198 } },
  { position: 100, color: { r: 198, g: 224, b: 250 } },
];

const DIRECTIONS = ['topToBottom', 'bottomToTop', 'leftToRight', 'rightToLeft'];

describe('the mock and the plugin resolve a gradient identically', () => {
  it('normalizes the same stops', () => {
    const messy: Stop[] = [
      { position: 180, color: { r: 999, g: -20, b: 128 } },
      { position: -40, color: { r: 0, g: 0, b: 0 } },
    ];
    expect(mockNormalizeStops(messy)).toEqual(plugin.normalizeStops(messy));
  });

  it('interpolates at the same points', () => {
    const mockStops = mockNormalizeStops(SKY);
    const pluginStops = plugin.normalizeStops(SKY);
    for (const t of [0, 0.1, 0.25, 0.5, 0.55, 0.75, 0.9, 1]) {
      expect(mockColorAt(mockStops, t)).toEqual(plugin.colorAt(pluginStops, t));
    }
  });

  it('lays down identical linear bands in every direction', () => {
    for (const direction of DIRECTIONS) {
      for (const reverse of [false, true]) {
        const options = { stops: SKY, width: 1200, height: 800, bands: 16, direction, reverse };
        const mock = mockLinearBands(options);
        const theirs = plugin.linearBands(options);

        expect(theirs.bands).toHaveLength(mock.bands.length);
        expect(theirs.truncated).toBe(mock.truncated);
        for (let i = 0; i < mock.bands.length; i += 1) {
          expect(theirs.bands[i]!.bounds).toEqual(mock.bands[i]!.bounds);
          expect(theirs.bands[i]!.color).toEqual(mock.bands[i]!.color);
        }
      }
    }
  });

  it('lays down identical radial bands, centred and off-centre', () => {
    for (const options of [
      { stops: SKY, width: 1200, height: 800, bands: 12 },
      { stops: BLACK_TO_WHITE, width: 800, height: 600, bands: 7, center: { x: 200, y: 150 }, radius: 320 },
      { stops: SKY, width: 800, height: 600, bands: 5, reverse: true },
    ]) {
      const mock = mockRadialBands(options);
      const theirs = plugin.radialBands(options);
      expect(theirs.bands).toHaveLength(mock.bands.length);
      for (let i = 0; i < mock.bands.length; i += 1) {
        expect(theirs.bands[i]!.bounds).toEqual(mock.bands[i]!.bounds);
        expect(theirs.bands[i]!.color).toEqual(mock.bands[i]!.color);
      }
    }
  });

  it('caps the band count the same way', () => {
    expect(mockLinearBands({ stops: SKY, width: 100, height: 100, bands: 5000 }).bands)
      .toHaveLength(plugin.linearBands({ stops: SKY, width: 100, height: 100, bands: 5000 }).bands.length);
    expect(plugin.linearBands({ stops: SKY, width: 100, height: 100, bands: 5000 }).truncated).toBe(true);
  });

  it('samples the same points to verify', () => {
    for (const options of [
      { type: 'linear', direction: 'topToBottom', width: 1200, height: 800 },
      { type: 'linear', direction: 'leftToRight', width: 1200, height: 800 },
      { type: 'radial', width: 800, height: 600 },
    ]) {
      expect(mockVerificationPoints(options, 12)).toEqual(plugin.verificationPoints(options, 12));
    }
  });
});