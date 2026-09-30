import { OPERATIONS, opForTool } from '@photoshop-ai-studio/shared';
import type { DocumentSnapshot, LayerInfo, PhotoshopOpName } from '@photoshop-ai-studio/shared';
import {
  type AnalyzeRequest,
  type AnalyzeResponse,
  type ModelGateway,
  type ModelRole,
  type ModelVerification,
  type PlanDraft,
  type PlanRequest,
  type VerifyRequest,
} from './types.js';

/**
 * Deterministic planner gateway (`provider=mock`).
 *
 * Two jobs:
 *
 *  1. **Offline development and tests.** `AI_PLANNER_PROVIDER=mock` runs the
 *     entire pipeline — chat → plan → approval → execution → diff → verification
 *     → repair — with no API key and no network. This is what the §29 demo looks
 *     like on a machine without a provider configured.
 *  2. **A real, if narrow, planner.** The matchers below encode actual layout
 *     arithmetic (proportional re-composition for a target canvas) rather than
 *     canned answers, so what it emits is a legitimate plan that the rest of the
 *     system treats exactly like an LLM plan.
 *
 * Anything it cannot express returns an empty plan with a note — it never
 * guesses. A real provider replaces it wholesale; nothing else changes.
 */
export class DeterministicGateway implements ModelGateway {
  readonly provider = 'mock';

  constructor(
    readonly role: ModelRole,
    readonly model: string,
  ) {}

  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    return { text: describeIntent(request) };
  }

  async plan(request: PlanRequest): Promise<PlanDraft> {
    const text = request.userRequest.trim();

    if (request.repairHint) {
      const repair = matchRepair(request.repairHint, request.state);
      if (repair) return repair;
      return {
        goal: text,
        steps: [],
        notes: [
          'The deterministic planner cannot synthesise a repair for this failure.',
          'Set AI_PLANNER_PROVIDER to a real model for the repair loop to be useful.',
        ],
      };
    }

    const matcher =
      matchResizeVariant(text, request.state) ??
      matchCenterLayers(text, request.state) ??
      matchGroupLayers(text, request.state) ??
      matchSingleOperation(text, request.state);

    if (matcher) return matcher;

    return {
      goal: text,
      steps: [],
      notes: [
        `The deterministic planner (provider=mock) does not understand this request.`,
        `Set AI_PLANNER_PROVIDER=openai / anthropic / openai-compatible and provide a key to use a real model.`,
      ],
    };
  }

  async verify(request: VerifyRequest): Promise<ModelVerification> {
    if (!request.deterministic.passed) {
      return { passed: false, reason: `${request.deterministic.failedCount} deterministic check(s) failed.` };
    }
    if (!request.deterministic.summary) {
      return { passed: true, reason: 'No deterministic checks were defined for this plan; state was left unchanged.' };
    }
    return { passed: true, reason: 'All deterministic state checks passed.' };
  }
}

// ---------------------------------------------------------------------------
// matchers
// ---------------------------------------------------------------------------

type Matcher = (text: string, state: DocumentSnapshot | null) => PlanDraft | null;

const DEFAULT_SQUARE = 1080;

/** "Make a square version", "resize canvas to 1080×1080", "create a 1200x628 variant". */
const matchResizeVariant: Matcher = (text, state) => {
  const wantsVariant = /\b(square|version|variant|copy|duplicate|resize|adapt|make it)\b/i.test(text);
  const dims = parseDimensions(text);
  const isSquare = /\bsquare\b/i.test(text);
  if (!wantsVariant || (!dims && !isSquare)) return null;
  if (!state) return { goal: text, steps: [], notes: ['No document is open in Photoshop.'] };

  const target = dims ?? { width: DEFAULT_SQUARE, height: DEFAULT_SQUARE };
  const doc = state.document;
  const scale = Math.min(target.width / doc.width, target.height / doc.height);
  const offsetX = (doc.width - target.width) / 2;
  const offsetY = (doc.height - target.height) / 2;

  const steps: PlanDraft['steps'] = [];
  const variant = `${stripExtension(doc.name)}-${target.width}x${target.height}`;

  steps.push({
    tool: OPERATIONS.duplicate_document.tool,
    params: { name: variant },
    intent: `Work on a copy so the original ${doc.name} is untouched`,
  });
  // Duplicating assigns fresh layer ids, so every selector below must be a name.
  const selectorFor = (layer: LayerInfo): Record<string, unknown> => ({ layerName: layer.name });
  steps.push({
    tool: OPERATIONS.resize_canvas.tool,
    params: { width: target.width, height: target.height, anchor: 'center' },
    intent: `Canvas becomes ${target.width}×${target.height}`,
  });

  // Re-compose: scale and reposition every visible content layer around the new
  // canvas centre. Groups are containers — resizing them is meaningless.
  const movable = state.layers.filter((l) => l.type !== 'group');
  const MAX_LAYERS = 12;
  let handled = 0;
  for (const layer of movable) {
    if (handled >= MAX_LAYERS) break;
    const selector = selectorFor(layer);
    const newX = round(offsetX + (layer.x - offsetX) * scale);
    const newY = round(offsetY + (layer.y - offsetY) * scale);

    if (layer.type === 'text') {
      // Scaling a text box does not scale the glyphs, so drive the point size.
      steps.push({
        tool: OPERATIONS.set_text_font_size.tool,
        params: { ...selector, fontSize: round(Math.max(1, currentFontSize(layer) * scale), 1) },
        intent: `Scale "${layer.name}" type to match the new canvas`,
      });
      steps.push({
        tool: OPERATIONS.move_layer.tool,
        params: { ...selector, x: newX, y: newY },
        intent: `Reposition "${layer.name}"`,
      });
    } else {
      steps.push({
        tool: OPERATIONS.resize_layer.tool,
        params: { ...selector, scale: round(scale, 4), anchor: 'topLeft', resample: 'bicubic' },
        intent: `Scale "${layer.name}" by ${round(scale * 100, 1)}%`,
      });
      steps.push({
        tool: OPERATIONS.move_layer.tool,
        params: { ...selector, x: newX, y: newY },
        intent: `Reposition "${layer.name}"`,
      });
    }
    handled += 1;
  }

  steps.push({
    tool: OPERATIONS.export_png.tool,
    params: { path: `out/${variant}.png` },
    intent: 'Export a preview of the new version',
  });

  const notes = [`Scaled content by ${round(scale * 100, 1)}% and re-centred it in the new canvas.`];
  if (movable.length > MAX_LAYERS) {
    notes.push(`Only the first ${MAX_LAYERS} layers were repositioned; ${movable.length - MAX_LAYERS} were left untouched.`);
  }

  return { goal: `${isSquare && !dims ? 'Square' : `${target.width}×${target.height}`} version of ${doc.name}`, steps, notes };
};

/** "Centre the logo", "center Title and Subtitle". */
const matchCenterLayers: Matcher = (text, state) => {
  if (!/\bcent(?:er|re)\b/i.test(text)) return null;
  if (!state) return { goal: text, steps: [], notes: ['No document is open in Photoshop.'] };

  const targets = matchNamedLayers(text, state);
  if (targets.length === 0) return null;
  const doc = state.document;
  return {
    goal: `Centre ${targets.map((l) => `"${l.name}"`).join(', ')}`,
    steps: targets.map((layer) => ({
      tool: OPERATIONS.move_layer.tool,
      params: {
        layerId: layer.id,
        x: round((doc.width - layer.width) / 2),
        y: round((doc.height - layer.height) / 2),
      },
      intent: `Centre "${layer.name}" on the canvas`,
    })),
  };
};

/** "Group the logo and title into Header", "create group Header with Logo". */
const matchGroupLayers: Matcher = (text, state) => {
  const groupMatch = text.match(/\b(?:group|collect|combine)\b.*?\b(?:into|as)\s+["']?([\w][\w -]*)["']?/i);
  const createMatch = text.match(/\b(?:create|add|make)\s+(?:an?\s+)?(?:new\s+)?group\s+(?:named\s+|called\s+)?["']?([\w][\w -]*)["']?/i);
  const rawName = groupMatch?.[1] ?? createMatch?.[1];
  // "into a Header" / "as The Header" — the article is grammar, not a name.
  const groupName = rawName?.replace(/^\s*(?:an?|the)\s+/i, '').trim();
  if (!groupName) return null;
  if (!state) return { goal: text, steps: [], notes: ['No document is open in Photoshop.'] };

  const members = matchNamedLayers(text.replace(groupName, ' '), state).filter((l) => l.type !== 'group');
  const steps: PlanDraft['steps'] = [
    {
      tool: OPERATIONS.create_group.tool,
      params: members.length > 0 ? { name: groupName.trim(), layer: { layerId: members[0]!.id } } : { name: groupName.trim() },
      intent: `Create group "${groupName.trim()}"`,
    },
  ];
  for (const member of members.slice(1)) {
    steps.push({
      tool: OPERATIONS.move_layer_to_group.tool,
      params: { layer: { layerId: member.id }, group: { layerName: groupName.trim() } },
      intent: `Move "${member.name}" into "${groupName.trim()}"`,
    });
  }
  if (members.length === 0) steps.push({ ...steps[0]!, intent: `Create empty group "${groupName.trim()}"` });

  return { goal: `Group ${members.map((l) => `"${l.name}"`).join(', ') || 'nothing'} as "${groupName.trim()}"`, steps };
};

/** Single-operation commands: rename, opacity, hide/show, export, delete. */
const matchSingleOperation: Matcher = (text, state) => {
  const one = (tool: string, params: Record<string, unknown>, goal: string, intent?: string): PlanDraft => ({
    goal,
    steps: [{ tool, params, ...(intent ? { intent } : {}) }],
  });

  const rename = text.match(/\b(?:rename|re-?name)\s+["']?([\w][\w -]*)["']?\s+(?:to|as|into)\s+["']?([^"']+?)["']?\s*$/i);
  if (rename) {
    return one(OPERATIONS.rename_layer.tool, { layerName: rename[1]!.trim(), name: rename[2]!.trim() }, `Rename "${rename[1]!.trim()}" to "${rename[2]!.trim()}"`);
  }

  const opacity = text.match(/\b(?:set\s+)?opacity\b[^\d-]{0,40}?(\d{1,3})\s*%?/i);
  if (opacity && state) {
    const value = clamp(Number(opacity[1]), 0, 100);
    const target = resolveTargetLayer(text, state);
    if (target) {
      return one(OPERATIONS.set_layer_opacity.tool, { layerId: target.id, opacity: value }, `Set "${target.name}" opacity to ${value}%`);
    }
  }

  const visibility = text.match(/\b(hide|show|unhide)\s+(?:the\s+)?["']?([\w][\w -]*)["']?\s*$/i);
  if (visibility && state) {
    const target = matchNamedLayers(visibility[2]!, state)[0];
    if (target) {
      const visible = visibility[1]!.toLowerCase() !== 'hide';
      return one(
        OPERATIONS.set_layer_visibility.tool,
        { layerId: target.id, visible },
        `${visible ? 'Show' : 'Hide'} "${target.name}"`,
      );
    }
  }

  const exportMatch = text.match(/\b(?:export|save)\b[^\w]{0,10}\b(png|jpe?g|psd)\b/i);
  if (exportMatch) {
    const format = exportMatch[1]!.toLowerCase();
    const tool =
      format === 'png'
        ? OPERATIONS.export_png.tool
        : format === 'jpg' || format === 'jpeg'
          ? OPERATIONS.export_jpg.tool
          : OPERATIONS.save_psd.tool;
    const base = state ? stripExtension(state.document.name) : 'document';
    const name = `${base}.${format === 'jpeg' ? 'jpg' : format}`;
    return one(tool, { path: `out/${name}` }, `Export as ${format.toUpperCase()}`, `Write to out/${name}`);
  }

  const deleteMatch = text.match(/\b(?:delete|remove)\s+(?:the\s+)?(?:layer\s+)?["']?([\w][\w -]*)["']?\s*$/i);
  if (deleteMatch && state) {
    const target = matchNamedLayers(deleteMatch[1]!, state)[0];
    if (target) {
      return one(OPERATIONS.delete_layer.tool, { layerId: target.id }, `Delete layer "${target.name}"`);
    }
  }

  void one;
  return null;
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Targeted repair.
 *
 * The verification engine writes failures as
 *   `- step-9: x of "Title" — Expected 251, Photoshop reports 120`
 * so the repair can be derived mechanically: look the layer up **by name in the
 * current state** (ids shift after a duplicate, which is the most common cause of
 * these failures in the first place) and re-issue the operation with the expected
 * value. Deliberately narrow — it repairs what it can prove, and abstains
 * otherwise.
 */
function matchRepair(hint: string, state: DocumentSnapshot | null): PlanDraft | null {
  if (!state) return null;
  const line = /^\s*-\s*\S+:\s*(x|y|width|height|opacity|visible|name|fontSize)\s+of\s+"([^"]+)"\s+—\s+Expected\s+([^,]+),/gm;

  // Group by layer before emitting steps: several failed checks usually describe
  // one layer, and `move_layer` takes both coordinates at once. Emitting one step
  // per failed property would replay a *stale* copy of the other coordinate and
  // undo the previous fix.
  interface Fixes {
    layer: LayerInfo;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    opacity?: number;
    visible?: boolean;
    fontSize?: number;
    name?: string;
  }
  const byLayer = new Map<number, Fixes>();

  for (const match of hint.matchAll(line)) {
    const property = match[1]!;
    const name = match[2]!.trim();
    const expected = match[3]!.trim();
    const layer = state.layers.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!layer) continue;
    const numeric = Number(expected);
    const fixes = byLayer.get(layer.id) ?? { layer };
    switch (property) {
      case 'x':
        fixes.x = numeric;
        break;
      case 'y':
        fixes.y = numeric;
        break;
      case 'width':
        fixes.width = numeric;
        break;
      case 'height':
        fixes.height = numeric;
        break;
      case 'opacity':
        fixes.opacity = numeric;
        break;
      case 'visible':
        fixes.visible = expected.toLowerCase() === 'true';
        break;
      case 'fontSize':
        fixes.fontSize = numeric;
        break;
      case 'name':
        fixes.name = expected;
        break;
      default:
        break;
    }
    byLayer.set(layer.id, fixes);
  }

  const steps: PlanDraft['steps'] = [];
  for (const fixes of byLayer.values()) {
    const layer = fixes.layer;
    const selector = { layerName: layer.name };
    const current = (v: number | undefined, fallback: number): number => (typeof v === 'number' ? v : fallback);

    if (fixes.x !== undefined || fixes.y !== undefined) {
      steps.push({
        tool: OPERATIONS.move_layer.tool,
        params: {
          ...selector,
          x: current(fixes.x, Math.round(layer.x)),
          y: current(fixes.y, Math.round(layer.y)),
        },
        intent: `Repair: put "${layer.name}" back at x=${current(fixes.x, Math.round(layer.x))}, y=${current(fixes.y, Math.round(layer.y))}`,
      });
    }
    if (fixes.width !== undefined || fixes.height !== undefined) {
      steps.push({
        tool: OPERATIONS.resize_layer.tool,
        params: {
          ...selector,
          ...(fixes.width !== undefined ? { width: fixes.width } : {}),
          ...(fixes.height !== undefined ? { height: fixes.height } : {}),
          ...(fixes.width === undefined ? { scale: 1 } : {}),
          ...(fixes.height === undefined ? { scale: 1 } : {}),
        },
        intent: `Repair: "${layer.name}" geometry`,
      });
    }
    if (fixes.opacity !== undefined) {
      steps.push({
        tool: OPERATIONS.set_layer_opacity.tool,
        params: { ...selector, opacity: fixes.opacity },
        intent: `Repair: "${layer.name}" opacity`,
      });
    }
    if (fixes.visible !== undefined) {
      steps.push({
        tool: OPERATIONS.set_layer_visibility.tool,
        params: { ...selector, visible: fixes.visible },
        intent: `Repair: "${layer.name}" visibility`,
      });
    }
    if (fixes.fontSize !== undefined) {
      steps.push({
        tool: OPERATIONS.set_text_font_size.tool,
        params: { ...selector, fontSize: fixes.fontSize },
        intent: `Repair: "${layer.name}" font size`,
      });
    }
    if (fixes.name !== undefined) {
      steps.push({
        tool: OPERATIONS.rename_layer.tool,
        params: { ...selector, name: fixes.name },
        intent: `Repair: rename to "${fixes.name}"`,
      });
    }
  }

  if (steps.length === 0) return null;
  return {
    goal: 'Repair failed verification checks',
    summary: `${steps.length} corrective step(s) derived from the verification report.`,
    steps,
  };
}

function parseDimensions(text: string): { width: number; height: number } | null {
  const match = text.match(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Resolves layer names mentioned in free text.
 *
 * Two passes: the full name first ("company logo"), then the trailing token
 * ("logo") when the user wrote the short form ("center the Logo"). A candidate
 * must appear as a whole word so "logo" does not match "Logo—Monochrome".
 * Ambiguity is resolved by the caller, never here.
 */
function matchNamedLayers(text: string, state: DocumentSnapshot): LayerInfo[] {
  const lower = ` ${text.toLowerCase()} `;
  const full = state.layers.filter((l) => l.name.length >= 3 && lower.includes(l.name.toLowerCase()));
  if (full.length > 0) return full;
  return state.layers.filter((l) => {
    const lastToken = l.name.toLowerCase().trim().split(/[\s\-_]+/).pop() ?? '';
    return lastToken.length >= 3 && new RegExp(`\\b${escapeRegExp(lastToken)}\\b`).test(lower);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTargetLayer(text: string, state: DocumentSnapshot): LayerInfo | null {
  const named = matchNamedLayers(text, state);
  return named.length === 1 ? named[0]! : named.length > 1 ? named[named.length - 1]! : null;
}

/** Text layer font size is not part of `LayerInfo`; infer a sane ratio from bounds. */
function currentFontSize(layer: LayerInfo): number {
  return Math.max(1, Math.round(layer.height / 1.4));
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function describeIntent(request: AnalyzeRequest): string {
  const { userRequest, state, plan, diffText } = request;
  if (diffText) return `Done. ${firstDiffLine(diffText)}`;
  if (plan) {
    const first = plan.steps[0];
    if (!first) return 'I could not turn that into a plan with the available tools.';
    const op = opForTool(first.tool);
    const params = first.params as Record<string, unknown>;
    return oneLiner(first.tool, op, params, state);
  }
  return `I will look at ${state ? `"${state.document.name}"` : 'the current document'} and plan "${userRequest}".`;
}

function oneLiner(tool: string, op: PhotoshopOpName | null, params: Record<string, unknown>, state: DocumentSnapshot | null): string {
  const name = (v: unknown): string => (typeof v === 'string' ? `"${v}"` : String(v ?? ''));
  switch (op) {
    case 'duplicate_document':
      return `I'll duplicate ${state ? `"${state.document.name}"` : 'the document'} first so the original stays intact.`;
    case 'resize_canvas':
      return `I'll change the canvas to ${params.width}×${params.height}.`;
    case 'rename_layer':
      return `I'll rename ${name(params.layerName ?? params.layerId)} to ${name(params.name)}.`;
    case 'set_layer_opacity':
      return `I'll set ${name(params.layerName ?? params.layerId)} opacity to ${params.opacity}%.`;
    case 'set_layer_visibility':
      return `I'll ${params.visible === false ? 'hide' : 'show'} ${name(params.layerName ?? params.layerId)}.`;
    case 'delete_layer':
      return `I'll delete ${name(params.layerName ?? params.layerId)} — this needs your confirmation.`;
    case 'export_png':
    case 'export_jpg':
    case 'save_psd':
      return `I'll export to ${name(params.path)}.`;
    case 'move_layer':
      return `I'll move ${name(params.layerName ?? params.layerId)} to (${params.x ?? 'dx'}, ${params.y ?? 'dy'}).`;
    case 'create_group':
      return `I'll create the group ${name(params.name)}.`;
    default:
      return `I'll run ${tool}.`;
  }
}

function firstDiffLine(diffText: string): string {
  for (const line of diffText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === 'DOCUMENT DIFF') continue;
    return trimmed;
  }
  return 'No changes were needed.';
}

export function isDeterministic(model: string): boolean {
  return model === 'deterministic';
}

