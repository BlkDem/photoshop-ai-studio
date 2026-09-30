import * as z from 'zod/v4';

import type { DocumentSnapshot } from './snapshot.js';
import { LayerSelectorSchema } from './layer.js';

/**
 * State diffing (§18):  before-snapshot → operation → after-snapshot → diff.
 *
 * The diff is what the Studio shows the user, and it is also the evidence the
 * VerificationEngine uses, so both live in `shared` and are unit-tested once.
 */

export const PropertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type PropertyValue = z.infer<typeof PropertyValueSchema>;

export const PropertyChangeSchema = z.object({
  property: z.string(),
  before: PropertyValueSchema,
  after: PropertyValueSchema,
});
export type PropertyChange = z.infer<typeof PropertyChangeSchema>;

export const DiffStatusSchema = z.enum(['added', 'removed', 'changed', 'unchanged']);
export type DiffStatus = z.infer<typeof DiffStatusSchema>;

export const LayerDiffSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: DiffStatusSchema,
  changes: z.array(PropertyChangeSchema),
});
export type LayerDiff = z.infer<typeof LayerDiffSchema>;

export const DocumentDiffSchema = z.object({
  beforeCapturedAt: z.string(),
  afterCapturedAt: z.string(),
  documentChanges: z.array(PropertyChangeSchema),
  layers: z.array(LayerDiffSchema),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
  }),
  hasChanges: z.boolean(),
});
export type DocumentDiff = z.infer<typeof DocumentDiffSchema>;

/** Layer properties tracked by the diff. Geometry is included: moves are the whole point. */
const TRACKED_LAYER_PROPERTIES = [
  'name',
  'type',
  'visible',
  'opacity',
  'x',
  'y',
  'width',
  'height',
  'parentId',
  'blendMode',
  'isLocked',
] as const;

const TRACKED_DOCUMENT_PROPERTIES = [
  'name',
  'width',
  'height',
  'resolution',
  'colorMode',
  'layerCount',
  'path',
  'saved',
] as const;

export const NO_CHANGES: DocumentDiff = {
  beforeCapturedAt: '',
  afterCapturedAt: '',
  documentChanges: [],
  layers: [],
  summary: { added: 0, removed: 0, changed: 0 },
  hasChanges: false,
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return false;
}

function changeOf(
  property: string,
  before: unknown,
  after: unknown,
): PropertyChange | null {
  const b = (before ?? null) as PropertyValue;
  const a = (after ?? null) as PropertyValue;
  return sameValue(b, a) ? null : { property, before: b, after: a };
}

export function diffSnapshots(before: DocumentSnapshot, after: DocumentSnapshot): DocumentDiff {
  const documentChanges: PropertyChange[] = [];
  for (const prop of TRACKED_DOCUMENT_PROPERTIES) {
    const change = changeOf(prop, before.document[prop], after.document[prop]);
    if (change) documentChanges.push(change);
  }

  const beforeById = new Map(before.layers.map((l) => [l.id, l]));
  const afterById = new Map(after.layers.map((l) => [l.id, l]));

  const layerDiffs: LayerDiff[] = [];

  for (const layer of after.layers) {
    const prev = beforeById.get(layer.id);
    if (!prev) {
      layerDiffs.push({ id: layer.id, name: layer.name, status: 'added', changes: [] });
      continue;
    }
    const changes: PropertyChange[] = [];
    for (const prop of TRACKED_LAYER_PROPERTIES) {
      const change = changeOf(prop, prev[prop], layer[prop]);
      if (change) changes.push(change);
    }
    if (changes.length > 0) {
      layerDiffs.push({ id: layer.id, name: layer.name, status: 'changed', changes });
    }
  }

  for (const layer of before.layers) {
    if (!afterById.has(layer.id)) {
      layerDiffs.push({ id: layer.id, name: layer.name, status: 'removed', changes: [] });
    }
  }

  const summary = {
    added: layerDiffs.filter((d) => d.status === 'added').length,
    removed: layerDiffs.filter((d) => d.status === 'removed').length,
    changed: layerDiffs.filter((d) => d.status === 'changed').length,
  };

  return {
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    documentChanges,
    layers: layerDiffs,
    summary,
    hasChanges: documentChanges.length > 0 || layerDiffs.length > 0,
  };
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<DiffStatus, string> = {
  added: '+',
  removed: '-',
  changed: '~',
  unchanged: '=',
};

function fmt(value: PropertyValue): string {
  return value === null ? '—' : String(value);
}

/** Renders the §18 "DOCUMENT DIFF" block for the Studio UI and for log output. */
export function formatDiff(diff: DocumentDiff): string {
  if (!diff.hasChanges) return 'DOCUMENT DIFF\n\n(no changes)';
  const lines: string[] = ['DOCUMENT DIFF', ''];

  if (diff.documentChanges.length > 0) {
    lines.push('~ Canvas');
    for (const change of diff.documentChanges) {
      lines.push(`  ${change.property}: ${fmt(change.before)} → ${fmt(change.after)}`);
    }
    lines.push('');
  }

  for (const layer of diff.layers) {
    if (layer.status === 'added') {
      lines.push(`+ Layer "${layer.name}"`);
      continue;
    }
    if (layer.status === 'removed') {
      lines.push(`- Layer "${layer.name}"`);
      continue;
    }
    lines.push(`~ ${layer.name}`);
    for (const change of layer.changes) {
      lines.push(`  ${change.property}: ${fmt(change.before)} → ${fmt(change.after)}`);
    }
  }

  const { added, removed, changed } = diff.summary;
  lines.push('');
  lines.push(`${added} added · ${changed} changed · ${removed} removed`);
  return lines.join('\n');
}

export { STATUS_GLYPH };

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/**
 * Declarative expectations attached to plan steps and evaluated by the
 * VerificationEngine against a fresh snapshot (§17).
 *
 * The orchestrator derives these mechanically from `(tool, params)` whenever the
 * planner does not supply its own, which is what makes verification real rather
 * than decorative: a model that forgets to prove its work still gets checked.
 *
 * Expectations are data, not code, so an LLM can emit them and the engine can
 * evaluate them without trusting the model's own claims.
 */
export const ExpectationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('layer_exists'),
    layer: LayerSelectorSchema,
    where: z.enum(['document', 'parent']).default('document'),
  }),
  z.object({
    kind: z.literal('layer_absent'),
    layer: LayerSelectorSchema,
  }),
  z.object({
    // "layer X now lives inside the group named Y". Needed because a plan often
    // addresses the group by name, in which case the new `parentId` is only
    // knowable after the group was created.
    kind: z.literal('layer_parent_named'),
    layer: LayerSelectorSchema,
    groupName: z.string().min(1),
  }),
  z.object({
    kind: z.literal('layer_property'),
    layer: LayerSelectorSchema,
    property: z.enum([
      'name', 'visible', 'opacity', 'x', 'y', 'width', 'height', 'parentId', 'type', 'blendMode', 'isLocked',
      // Added with the DOM-backed tools, so a tool that quietly did nothing
      // cannot pass verification. `fillOpacity` is distinct from `opacity`, and
      // `withinCanvas` catches a transform that threw the layer out of the frame.
      'fillOpacity',
      'withinCanvas',
    ]),
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    tolerance: z.number().nonnegative().default(0),
  }),
  z.object({
    kind: z.literal('document_property'),
    property: z.enum([
      'name', 'width', 'height', 'resolution', 'colorMode', 'layerCount', 'path', 'saved',
      // Derived from the selection in the snapshot, so `set_selection` has
      // something mechanical to be checked against.
      'selectionWidth', 'selectionHeight',
    ]),
    equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    tolerance: z.number().nonnegative().default(0),
  }),
  z.object({
    kind: z.literal('layer_count'),
    equals: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('file_exists'),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('text_property'),
    layer: LayerSelectorSchema,
    property: z.enum([
      'text', 'font', 'fontSize', 'color',
      // The style patch writes these; without them a `set_text_style` step was
      // verified against nothing at all.
      'tracking', 'horizontalScale', 'verticalScale', 'fauxBold', 'fauxItalic', 'underline', 'strikeThrough', 'leading',
      // The text box width, which is what `paragraphWidth` produces.
      'width',
    ]),
    equals: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())]),
    tolerance: z.number().nonnegative().default(0),
  }),
  z.object({
    kind: z.literal('custom'),
    description: z.string().min(1).describe('Free-form check reviewed by the vision model.'),
  }),
]);

export type Expectation = z.infer<typeof ExpectationSchema>;

export const VerificationCheckSchema = z.object({
  id: z.string(),
  stepId: z.string().nullable(),
  label: z.string(),
  status: z.enum(['passed', 'failed', 'skipped', 'unknown']),
  expected: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  actual: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  detail: z.string().optional(),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const VerificationResultSchema = z.object({
  passed: z.boolean(),
  checks: z.array(VerificationCheckSchema),
  failedCount: z.number().int().nonnegative(),
  /** Set when a check failed and the AI can propose a repair step. */
  repairHint: z.string().nullable(),
  /** True when the verdict came from the LLM rather than deterministic checks. */
  modelAssisted: z.boolean().default(false),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const SKIPPED_VERIFICATION: VerificationResult = {
  passed: true,
  checks: [],
  failedCount: 0,
  repairHint: null,
  modelAssisted: false,
};
