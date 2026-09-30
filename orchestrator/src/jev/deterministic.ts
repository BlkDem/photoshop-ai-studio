import { OPERATIONS, type DocumentSnapshot, type LayerInfo } from '@photoshop-ai-studio/shared';
import type { PlanDraft } from '../gateway/types.js';
import type { JevDecision, JevInput, JevMode, JevRouter } from './types.js';

/**
 * The built-in deterministic JEV engine.
 *
 * A small, deliberately strict grammar of the instructions a designer types
 * constantly. Each rule returns a confidence; below the configured threshold the
 * router defers to the model. Rules must resolve their target layer against the
 * live document state — if the layer does not exist, or the name is ambiguous,
 * the rule abstains instead of guessing.
 */
export class DeterministicJevRouter implements JevRouter {
  readonly mode: JevMode = 'deterministic';
  readonly runtimeUrl = null;

  constructor(private readonly minConfidence: number) {}

  async route(input: JevInput): Promise<JevDecision> {
    const text = input.text.trim();
    if (text.length === 0 || text.length > 120) {
      return { kind: 'llm', reason: 'request is empty or too long for the fast path' };
    }
    // Multi-clause instructions ("…and also make it square") are a planner job.
    if (/\b(and then|and also|after that|afterwards|, then)\b/i.test(text)) {
      return { kind: 'llm', reason: 'compound instruction' };
    }

    for (const rule of RULES) {
      const decision = rule(text, input.state);
      if (!decision) continue;
      if (decision.confidence < this.minConfidence) {
        return { kind: 'llm', reason: `best rule "${decision.rule}" scored ${decision.confidence.toFixed(2)}` };
      }
      return decision;
    }

    return { kind: 'llm', reason: 'no fast-path rule matched' };
  }
}

// ---------------------------------------------------------------------------
// rules — highest confidence first
// ---------------------------------------------------------------------------

interface RuleResult {
  kind: 'fast';
  confidence: number;
  rule: string;
  draft: PlanDraft;
}

type Rule = (text: string, state: DocumentSnapshot | null) => RuleResult | null;

const single = (tool: string, params: Record<string, unknown>, goal: string, intent: string, confidence: number): RuleResult => ({
  kind: 'fast',
  confidence,
  rule: tool,
  draft: { goal, steps: [{ tool, params, intent }] },
});

const RULES: Rule[] = [
  // "rename Logo to Company Logo"
  (text, state) => {
    const m = text.match(/^\s*(?:please\s+)?rename\s+(?:the\s+)?(?:layer\s+)?["']?([\w][\w \-.·]*)["']?\s+to\s+["']?([^"']+?)["']?\s*$/i);
    if (!m) return null;
    const from = m[1]!.trim();
    const to = m[2]!.trim();
    if (!state) return null;
    const target = uniqueLayer(state, from);
    if (!target) return null;
    return single(
      OPERATIONS.rename_layer.tool,
      { layerId: target.id, name: to },
      `Rename "${from}" to "${to}"`,
      `Rename layer ${target.id}`,
      0.97,
    );
  },

  // "set opacity to 70%", "set the title opacity to 70%", "make Logo 70% opacity"
  (text, state) => {
    const named =
      text.match(/\b(?:set\s+)?(?:the\s+)?([\w][\w \-.·]*?)\s+opacity\s+(?:to\s+)?(\d{1,3})\s*%?$/i) ??
      text.match(/^\s*(?:set\s+)?opacity\s+(?:of\s+)?(?:the\s+)?["']?([\w][\w \-.·]*)["']?\s+to\s+(\d{1,3})\s*%?$/i);
    // The brief's example, "set opacity to 70%", names no layer. It is only
    // unambiguous when the document has exactly one layer to act on; otherwise
    // guessing would edit the wrong thing, so the rule abstains.
    const bare = /^\s*(?:please\s+)?(?:set\s+)?(?:the\s+)?opacity\s+(?:to\s+)?(\d{1,3})\s*%?$/i.exec(text);

    if (!named && !bare) return null;
    if (!state) return null;

    // The "named" pattern also matches the bare phrasing (it reads `set` as the
    // layer name), so fall back to the untargeted form when no layer resolves.
    let target = named ? uniqueLayer(state, named[1]!.trim()) : null;
    let value = named ? named[2] : undefined;
    if (!target && bare) {
      target = onlyLayer(state);
      value = bare[1];
    }
    if (!target || value === undefined) return null;

    const opacity = clampOpacity(Number(value));
    return single(
      OPERATIONS.set_layer_opacity.tool,
      { layerId: target.id, opacity },
      `Set "${target.name}" opacity to ${opacity}%`,
      `Change layer ${target.id} opacity`,
      named ? 0.95 : 0.88,
    );
  },

  // "hide Background", "show Background"
  (text, state) => {
    const m = text.match(/^\s*(?:please\s+)?(hide|show|unhide)\s+(?:the\s+)?(?:layer\s+)?["']?([\w][\w \-.·]*)["']?\s*$/i);
    if (!m || !state) return null;
    const target = uniqueLayer(state, m[2]!.trim());
    if (!target) return null;
    const visible = m[1]!.toLowerCase() !== 'hide';
    return single(
      OPERATIONS.set_layer_visibility.tool,
      { layerId: target.id, visible },
      `${visible ? 'Show' : 'Hide'} "${target.name}"`,
      `Toggle visibility of layer ${target.id}`,
      0.96,
    );
  },

  // "create group Header", "add a group called Header"
  (text) => {
    const m = text.match(/^\s*(?:create|add|make)\s+(?:a\s+)?(?:new\s+)?group\s+(?:named\s+|called\s+)?["']?([\w][\w -]*)["']?\s*$/i);
    if (!m) return null;
    const name = m[1]!.trim();
    return single(
      OPERATIONS.create_group.tool,
      { name },
      `Create group "${name}"`,
      `New empty layer group`,
      0.94,
    );
  },

  // "export png", "export as png", "save as psd"
  (text, state) => {
    const m = text.match(/^\s*(?:please\s+)?(?:export|save)(?:\s+(?:it|the\s+document))?\s+(?:as\s+)?(png|jpe?g|psd)\s*$/i);
    if (!m) return null;
    const format = m[1]!.toLowerCase();
    const base = state ? stripExtension(state.document.name) : 'document';
    const ext = format === 'jpeg' ? 'jpg' : format;
    const path = `out/${base}.${ext}`;
    const tool =
      ext === 'png' ? OPERATIONS.export_png.tool : ext === 'jpg' ? OPERATIONS.export_jpg.tool : OPERATIONS.save_psd.tool;
    // Writes into the workspace output directory; still confirmation-gated by the
    // safety layer because the tool is marked destructive.
    return single(tool, { path }, `Export as ${ext.toUpperCase()}`, `Write ${path}`, 0.92);
  },

  // "resize canvas to 1080x1080"
  (text) => {
    const m = text.match(/^\s*(?:resize|set)\s+(?:the\s+)?canvas\s+(?:to\s+)?(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i);
    if (!m) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return single(
      OPERATIONS.resize_canvas.tool,
      { width, height, anchor: 'center' },
      `Resize canvas to ${width}×${height}`,
      'Change canvas geometry',
      0.95,
    );
  },

  // "delete layer Background" — destructive, so a slightly lower score.
  (text, state) => {
    const m = text.match(/^\s*(?:delete|remove)\s+(?:the\s+)?(?:layer\s+)?["']?([\w][\w \-.·]*)["']?\s*$/i);
    if (!m || !state) return null;
    const target = uniqueLayer(state, m[1]!.trim());
    if (!target) return null;
    return single(
      OPERATIONS.delete_layer.tool,
      { layerId: target.id },
      `Delete layer "${target.name}"`,
      `Delete layer ${target.id}`,
      0.9,
    );
  },
];

// ---------------------------------------------------------------------------

/**
 * Resolves a name to exactly one layer.
 *
 * Abstains on a miss *and* on ambiguity: "rename the title" with two layers
 * called "Title" must go to the model, which can ask the user.
 */
function uniqueLayer(state: DocumentSnapshot, name: string): LayerInfo | null {
  const needle = name.trim().toLowerCase();
  if (needle.length === 0) return null;
  const exact = state.layers.filter((l) => l.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const partial = state.layers.filter((l) => l.name.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0]! : null;
}

/** The single layer of a single-layer document, or `null`. */
function onlyLayer(state: DocumentSnapshot): LayerInfo | null {
  return state.layers.length === 1 ? state.layers[0]! : null;
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
