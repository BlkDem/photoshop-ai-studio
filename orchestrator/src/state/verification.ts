import { existsSync } from 'node:fs';

import {
  StudioException,
  findLayer,
  toStudioError,
  type DocumentSnapshot,
  type Expectation,
  type LayerSelector,
  type RgbColor,
  type StudioError,
  type TextLayerInfo,
  type VerificationCheck,
  type VerificationResult,
} from '@photoshop-ai-studio/shared';

/**
 * VerificationEngine (§17).
 *
 * The contract: after a plan runs, take a **fresh** snapshot and check the
 * declared expectations against it. `{ success: true }` from Photoshop is
 * explicitly not evidence — a `batchPlay` can report success while the layer
 * ended up somewhere else, and only re-reading the document tells the truth.
 *
 * Deterministic checks are authoritative. The vision model may add commentary
 * (§ `modelAssisted`), but it can never overturn a failed state check, because
 * the model does not see the document any more precisely than we do.
 */
export interface TextReader {
  (selector: LayerSelector): Promise<TextLayerInfo | null>;
}

export interface VerifyInput {
  expectations: readonly { stepId: string; expectations: readonly Expectation[] }[];
  snapshot: DocumentSnapshot;
  readText: TextReader;
  /** Paths that Photoshop actually wrote during this run, used by `file_exists`. */
  producedFiles?: readonly string[];
}

export async function verifyState(input: VerifyInput): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  const failures: VerificationCheck[] = [];
  const textCache = new Map<string, TextLayerInfo | null>();

  const readTextCached = async (selector: LayerSelector): Promise<TextLayerInfo | null> => {
    const key = selector.layerId !== undefined ? `id:${selector.layerId}` : `name:${selector.layerName}`;
    if (textCache.has(key)) return textCache.get(key)!;
    const value = await input.readText(selector);
    textCache.set(key, value);
    return value;
  };

  let index = 0;
  for (const { stepId, expectations } of input.expectations) {
    for (const expectation of expectations) {
      index += 1;
      const check = await evaluate(expectation, stepId, input, readTextCached, index);
      checks.push(check);
      if (check.status === 'failed') failures.push(check);
    }
  }

  return {
    passed: failures.length === 0,
    checks,
    failedCount: failures.length,
    repairHint: failures.length > 0 ? buildRepairHint(failures) : null,
    modelAssisted: false,
  };
}

async function evaluate(
  expectation: Expectation,
  stepId: string,
  input: VerifyInput,
  readText: TextReader,
  index: number,
): Promise<VerificationCheck> {
  const id = `check-${index}`;
  const snapshot = input.snapshot;

  try {
    switch (expectation.kind) {
      case 'layer_exists': {
        const layer = findLayer(snapshot.layers, expectation.layer);
        return {
          id,
          stepId,
          label: `layer ${describeSelector(expectation.layer)} exists`,
          status: layer ? 'passed' : 'failed',
          expected: expectation.where,
          actual: layer ? layer.name : null,
          ...(layer ? {} : { detail: `No layer matches ${describeSelector(expectation.layer)} in "${snapshot.document.name}"` }),
        };
      }

      case 'layer_parent_named': {
        const layer = findLayer(snapshot.layers, expectation.layer);
        if (!layer) {
          return {
            id,
            stepId,
            label: `"${describeSelector(expectation.layer)}" is inside "${expectation.groupName}"`,
            status: 'failed',
            expected: expectation.groupName,
            actual: null,
            detail: `Layer ${describeSelector(expectation.layer)} does not exist`,
          };
        }
        const parent = layer.parentId !== null ? findLayer(snapshot.layers, { layerId: layer.parentId }) : null;
        const ok = parent?.name === expectation.groupName;
        return {
          id,
          stepId,
          label: `"${layer.name}" is inside "${expectation.groupName}"`,
          status: ok ? 'passed' : 'failed',
          expected: expectation.groupName,
          actual: parent ? parent.name : null,
          ...(ok ? {} : { detail: parent ? `"${layer.name}" is inside "${parent.name}", not "${expectation.groupName}"` : `"${layer.name}" is still at the document root` }),
        };
      }

      case 'layer_absent': {
        const layer = findLayer(snapshot.layers, expectation.layer);
        return {
          id,
          stepId,
          label: `layer ${describeSelector(expectation.layer)} is gone`,
          status: layer ? 'failed' : 'passed',
          expected: 'absent',
          actual: layer ? layer.name : null,
          ...(layer ? { detail: `Layer "${layer.name}" still exists` } : {}),
        };
      }

      case 'layer_property': {
        const layer = findLayer(snapshot.layers, expectation.layer);
        if (!layer) {
          return {
            id,
            stepId,
            label: `${expectation.property} of ${describeSelector(expectation.layer)}`,
            status: 'failed',
            expected: toComparable(expectation.equals),
            actual: null,
            detail: `Layer ${describeSelector(expectation.layer)} does not exist, so ${expectation.property} cannot be ${format(expectation.equals)}`,
          };
        }
        const actual = readProperty(layer as unknown as Record<string, unknown>, expectation.property);
        const ok = matches(actual, expectation.equals, expectation.tolerance);
        return {
          id,
          stepId,
          label: `${expectation.property} of "${layer.name}"`,
          status: ok ? 'passed' : 'failed',
          expected: toComparable(expectation.equals),
          actual: toComparable(actual),
          ...(ok ? {} : { detail: `Expected ${format(expectation.equals)}, Photoshop reports ${format(actual)}` }),
        };
      }

      case 'document_property': {
        const actual = readProperty(snapshot.document as unknown as Record<string, unknown>, expectation.property);
        const ok = matches(actual, expectation.equals, expectation.tolerance);
        return {
          id,
          stepId,
          label: `document ${expectation.property}`,
          status: ok ? 'passed' : 'failed',
          expected: toComparable(expectation.equals),
          actual: toComparable(actual),
          ...(ok ? {} : { detail: `Expected ${format(expectation.equals)}, document reports ${format(actual)}` }),
        };
      }

      case 'layer_count': {
        const actual = snapshot.layers.length;
        const ok = actual === expectation.equals;
        return {
          id,
          stepId,
          label: 'layer count',
          status: ok ? 'passed' : 'failed',
          expected: toComparable(expectation.equals),
          actual,
          ...(ok ? {} : { detail: `Expected ${expectation.equals} layers, found ${actual}` }),
        };
      }

      case 'text_property': {
        const layer = findLayer(snapshot.layers, expectation.layer);
        if (!layer) {
          return {
            id,
            stepId,
            label: `${expectation.property} of ${describeSelector(expectation.layer)}`,
            status: 'failed',
            expected: toComparable(expectation.equals),
            actual: null,
            detail: `Layer ${describeSelector(expectation.layer)} does not exist`,
          };
        }
        const text = await readText(expectation.layer);
        if (!text) {
          return {
            id,
            stepId,
            label: `${expectation.property} of "${layer.name}"`,
            status: 'failed',
            expected: toComparable(expectation.equals),
            actual: null,
            detail: `"${layer.name}" is a ${layer.type} layer and has no text content`,
          };
        }
        const actual = readProperty(text as unknown as Record<string, unknown>, expectation.property);
        const ok = matches(actual, expectation.equals, expectation.tolerance);
        return {
          id,
          stepId,
          label: `${expectation.property} of "${text.name}"`,
          status: ok ? 'passed' : 'failed',
          expected: toComparable(expectation.equals),
          actual: toComparable(actual),
          ...(ok ? {} : { detail: `Expected ${format(expectation.equals)}, found ${format(actual)}` }),
        };
      }

      case 'file_exists': {
        // The plan usually carries the *workspace-relative* path the user asked
        // for, while the tool reports the absolute one it wrote. Accept either,
        // matching on basename when needed.
        const produced = (input.producedFiles ?? []).some(
          (p) => p === expectation.path || p.endsWith(`/${expectation.path}`) || basename(p) === basename(expectation.path),
        );
        const ok = produced || existsSync(expectation.path);
        return {
          id,
          stepId,
          label: `file ${expectation.path}`,
          status: ok ? 'passed' : 'failed',
          expected: 'exists',
          actual: ok ? 'exists' : 'missing',
          ...(ok ? {} : { detail: `No file at ${expectation.path}` }),
        };
      }

      case 'custom':
        return {
          id,
          stepId,
          label: expectation.description,
          status: 'skipped',
          expected: 'model review',
          actual: null,
          detail: 'Deferred to the vision model',
        };
    }
  } catch (err) {
    const error: StudioError = toStudioError(err);
    return {
      id,
      stepId,
      label: `check failed: ${error.code}`,
      status: 'failed',
      expected: null,
      actual: null,
      detail: error.message,
    };
  }
}

// ---------------------------------------------------------------------------

function readProperty(source: Record<string, unknown>, property: string): ExpectationValue {
  const value = source[property];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (isRgb(value)) return { r: value.r, g: value.g, b: value.b };
  return value as ExpectationValue;
}

/** The value domain an expectation may compare against. */
type ExpectationValue = string | number | boolean | null | { r: number; g: number; b: number };

function toComparable(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (isRgb(value)) return `${value.r},${value.g},${value.b}`;
  return JSON.stringify(value);
}

function isRgb(value: unknown): value is RgbColor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RgbColor).r === 'number' &&
    typeof (value as RgbColor).g === 'number' &&
    typeof (value as RgbColor).b === 'number'
  );
}

function matches(actual: ExpectationValue, expected: unknown, tolerance: number): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(actual - expected) <= tolerance;
  if (typeof expected === 'number') return false;
  if (typeof expected === 'boolean') return actual === expected;

  const comparable = toComparable(actual);
  if (typeof expected === 'object') {
    // `{r,g,b}` compared against `"{r},{g},{b}"`, which is how colours are rendered.
    if (isRgb(expected)) return comparable === `${expected.r},${expected.g},${expected.b}`;
    return comparable === JSON.stringify(expected);
  }
  return String(comparable) === String(expected);
}

function format(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (isRgb(value)) return `#${[value.r, value.g, value.b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function describeSelector(selector: LayerSelector): string {
  if (selector.layerId !== undefined) return `#${selector.layerId}`;
  return `"${selector.layerName ?? '?'}"`;
}

/** Turns failed checks into a prompt fragment the repair planner can act on. */
function buildRepairHint(failures: readonly VerificationCheck[]): string {
  const lines = failures.slice(0, 6).map((c) => `- ${c.stepId ?? '?'}: ${c.label} — ${c.detail ?? `expected ${format(c.expected)}, got ${format(c.actual)}`}`);
  return `Verification failed:\n${lines.join('\n')}\nProduce a plan that fixes these, without repeating steps that already succeeded.`;
}

/** Wraps the engine so a run can never crash on an unexpected snapshot shape. */
export function safeVerify(input: VerifyInput): Promise<VerificationResult> {
  return verifyState(input).catch((err: unknown) => {
    const error: StudioError = toStudioError(err);
    return {
      passed: false,
      checks: [],
      failedCount: 1,
      repairHint: `Verification could not run: ${error.message}`,
      modelAssisted: false,
    } satisfies VerificationResult;
  });
}

export { StudioException };
