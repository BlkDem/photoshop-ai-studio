/**
 * The brush library.
 *
 * ## These are not Photoshop brushes
 *
 * The host this engine was built against cannot reach Photoshop's brush engine
 * from either door: UXP has no script-execution or menu-command route, and
 * ExtendScript does not expose `app.brushes` at all. There is therefore no
 * `app.brushes.getByName('Soft Round 30')` anywhere in this project, and no
 * preset here corresponds to one. Each preset is a **synthesized tip**: a
 * diameter, a spacing, and a radial falloff that `rasterizeTip` draws as a
 * stack of concentric discs.
 *
 * That is a real limitation and it is stated in every result this engine
 * produces. What it buys is that soft edges, dry-broken texture and glazing are
 * all *reachable* now, because they are geometry rather than host features.
 *
 * ## Why sizes are normalized
 *
 * `size` is a fraction of the canvas's shorter side, not pixels. A plan composed
 * against 1920x1080 renders the same picture at 3840x2160, because the brush
 * scales with the canvas instead of being pinned to it.
 */

import type { BrushPreset, DepthZone } from '../types.js';

/**
 * How much each depth zone modifies a preset.
 *
 * Background marks lose contrast and gain softness; foreground marks gain
 * contrast and tighten. Applied as multipliers on opacity and tip core.
 */
export interface DepthResponse {
  opacity: number;
  /** Multiplied into the tip's core: <1 softens, >1 hardens. */
  core: number;
  /** Multiplied into the diameter, which is how aerial perspective reads. */
  size: number;
}

export const DEPTH_RESPONSE: Record<DepthZone, DepthResponse> = {
  background: { opacity: 0.62, core: 0.72, size: 0.9 },
  midground: { opacity: 0.9, core: 0.95, size: 1 },
  foreground: { opacity: 1, core: 1.08, size: 1.14 },
};

/**
 * The MVP set from the spec: six sizes/behaviours, plus the two that glazing and
 * broken texture need.
 */
export const BRUSHES: readonly BrushPreset[] = Object.freeze([
  {
    id: 'oil_large',
    label: 'Oil Large',
    size: 0.16,
    opacity: 0.55,
    flow: 0.7,
    spacing: 0.3,
    tip: { core: 0.55, steps: 3, outerAlpha: 0.35 },
    tipIsSynthesized: true,
  },
  {
    id: 'oil_medium',
    label: 'Oil Medium',
    size: 0.085,
    opacity: 0.7,
    flow: 0.75,
    spacing: 0.28,
    tip: { core: 0.6, steps: 3, outerAlpha: 0.35 },
    tipIsSynthesized: true,
  },
  {
    id: 'oil_small',
    label: 'Oil Small',
    size: 0.045,
    opacity: 0.8,
    flow: 0.8,
    spacing: 0.26,
    tip: { core: 0.68, steps: 2, outerAlpha: 0.4 },
    tipIsSynthesized: true,
  },
  {
    id: 'oil_detail',
    label: 'Oil Detail',
    size: 0.022,
    opacity: 0.9,
    flow: 0.85,
    spacing: 0.24,
    tip: { core: 0.78, steps: 2, outerAlpha: 0.45 },
    tipIsSynthesized: true,
  },
  {
    // The softest brush available. This is what a sky or a glaze is made of.
    id: 'soft_blend',
    label: 'Soft Blend',
    size: 0.2,
    opacity: 0.3,
    flow: 0.5,
    spacing: 0.45,
    tip: { core: 0.18, steps: 4, outerAlpha: 0.18 },
    tipIsSynthesized: true,
  },
  {
    id: 'hard_round',
    label: 'Hard Round',
    size: 0.03,
    opacity: 1,
    flow: 1,
    spacing: 0.18,
    tip: { core: 1, steps: 1, outerAlpha: 1 },
    tipIsSynthesized: true,
  },
  {
    // Dry brush: a small dense core with a wide, faint, broken halo. The engine
    // adds the break-up, not the host.
    id: 'dry_brush',
    label: 'Dry Brush',
    size: 0.07,
    opacity: 0.45,
    flow: 0.4,
    spacing: 0.5,
    tip: { core: 0.34, steps: 4, outerAlpha: 0.12 },
    tipIsSynthesized: true,
  },
  {
    // For skies, haze and the final unifying wash.
    id: 'glaze',
    label: 'Glaze',
    size: 0.28,
    opacity: 0.18,
    flow: 0.35,
    spacing: 0.5,
    tip: { core: 0.12, steps: 4, outerAlpha: 0.1 },
    tipIsSynthesized: true,
  },
]);

const BY_ID = new Map(BRUSHES.map((brush) => [brush.id, brush]));

/** Looks a preset up, or throws with the valid ids — a typo must not be silent. */
export function brush(id: string): BrushPreset {
  const found = BY_ID.get(id);
  if (!found) {
    throw new Error(`unknown brush "${id}"; known brushes: ${BRUSHES.map((b) => b.id).join(', ')}`);
  }
  return found;
}

export function hasBrush(id: string): boolean {
  return BY_ID.has(id);
}

export function brushIds(): string[] {
  return BRUSHES.map((b) => b.id);
}

/**
 * Picks the brush whose diameter best matches a stage's `detail`.
 *
 * `detail` 0 is broad masses, 1 is fine detail, so the target diameter runs
 * *against* detail: the nearest preset to `0.2 * (1 - detail)` is the answer.
 * Getting that correlation the wrong way round is a silent disaster — a highly
 * detailed stage would come back with the largest brush in the catalog.
 *
 * Returns the preset rather than the id so the caller does not have to re-look it
 * up; plans may still name a brush explicitly, which always wins.
 */
export function brushForDetail(detail: number): BrushPreset {
  const target = Math.max(0, Math.min(1, detail));
  const wantedSize = 0.2 * (1 - target);
  const ordered = [...BRUSHES].sort((a, b) => Math.abs(a.size - wantedSize) - Math.abs(b.size - wantedSize));
  const best = ordered[0];
  if (!best) throw new Error('brush catalog is empty');
  return best;
}

/**
 * Applies a depth zone to a preset.
 *
 * Returns a new preset rather than mutating, because the catalog is frozen and
 * shared: a stage in the foreground must not have quietly changed what the
 * background uses.
 */
export function withDepth(preset: BrushPreset, depth: DepthZone): BrushPreset {
  const response = DEPTH_RESPONSE[depth];
  return {
    ...preset,
    opacity: Math.max(0, Math.min(1, preset.opacity * response.opacity)),
    size: preset.size * response.size,
    tip: {
      core: Math.max(0.05, Math.min(1, preset.tip.core * response.core)),
      steps: preset.tip.steps,
      outerAlpha: preset.tip.outerAlpha,
    },
  };
}