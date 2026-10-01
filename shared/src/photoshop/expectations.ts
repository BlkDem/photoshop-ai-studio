import type { Expectation } from './diff.js';
import type { LayerSelector } from './layer.js';
import { OPERATIONS, type ParamsOf, type PhotoshopOpName } from './operations.js';

/**
 * Mechanical derivation of post-conditions from a single `(tool, params)` pair.
 *
 * This is the backbone of §17: verification must not depend on the model
 * volunteering to describe its own success criteria. For every mutating tool we
 * can state, without knowing anything else, what "it worked" looks like in the
 * document — so we state it here and evaluate it against a fresh snapshot.
 *
 * Rules:
 *  - read-only tools produce no expectations (there is nothing to verify)
 *  - the planner's own `expect` entries are *merged on top*, never removed
 */
export function deriveExpectations<K extends PhotoshopOpName>(
  op: K,
  params: ParamsOf<K>,
): Expectation[] {
  const p = params as unknown as Record<string, unknown>;

  /**
   * Extracts a layer selector.
   *
   * For most layer ops the selector fields sit at the top level of `params`
   * alongside the operation's own arguments (`{layerName: 'Logo', name: 'New'}`),
   * so the whole params object must **not** be passed through as the selector —
   * only the two selector keys, or the verification engine would look for a layer
   * named after the new name and fail.
   */
  const sel = (value: unknown): LayerSelector => {
    if (typeof value !== 'object' || value === null) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.layerId === 'number' ? { layerId: record.layerId } : {}),
      ...(typeof record.layerName === 'string' ? { layerName: record.layerName } : {}),
    };
  };

  switch (op) {
    // --- layers ------------------------------------------------------------
    case 'rename_layer':
      return [{ kind: 'layer_property', layer: sel(p), property: 'name', equals: String(p.name), tolerance: 0 }];

    case 'set_layer_opacity':
      return [{ kind: 'layer_property', layer: sel(p), property: 'opacity', equals: Number(p.opacity), tolerance: 0.5 }];

    case 'set_layer_visibility':
      return [{ kind: 'layer_property', layer: sel(p), property: 'visible', equals: Boolean(p.visible), tolerance: 0 }];

    case 'move_layer': {
      const out: Expectation[] = [];
      if (typeof p.x === 'number') out.push({ kind: 'layer_property', layer: sel(p), property: 'x', equals: p.x, tolerance: 1 });
      if (typeof p.y === 'number') out.push({ kind: 'layer_property', layer: sel(p), property: 'y', equals: p.y, tolerance: 1 });
      return out;
    }

    case 'delete_layer':
      return [{ kind: 'layer_absent', layer: sel(p) }];

    // --- layer properties --------------------------------------------------
    // These have no mechanical post-condition, which until recently meant a tool
    // that did nothing at all would still verify clean: 23 of 47 operations were
    // in that position. A mutating tool with no expectation is worse than no tool,
    // because the run reports that it was checked.

    case 'set_layer_blend_mode':
      return [{ kind: 'layer_property', layer: sel(p), property: 'blendMode', equals: String(p.mode), tolerance: 0 }];

    case 'set_layer_fill_opacity':
      return [{ kind: 'layer_property', layer: sel(p), property: 'fillOpacity', equals: Number(p.opacity), tolerance: 0.6 }];

    case 'rasterize_layer':
      // The point of rasterizing is that the layer stops being live.
      return [{ kind: 'layer_property', layer: sel(p), property: 'type', equals: 'pixel', tolerance: 0 }];

    // --- text --------------------------------------------------------------
    case 'set_text_style': {
      const out: Expectation[] = [];
      const text = typeof p.fontSize === 'number' ? { fontSize: Number(p.fontSize) } : undefined;
      void text;
      if (typeof p.tracking === 'number') {
        out.push({ kind: 'text_property', layer: sel(p), property: 'tracking', equals: p.tracking, tolerance: 0.5 });
      }
      if (typeof p.horizontalScale === 'number') {
        out.push({
          kind: 'text_property',
          layer: sel(p),
          property: 'horizontalScale',
          equals: p.horizontalScale,
          tolerance: 0.5,
        });
      }
      if (typeof p.fauxBold === 'boolean') {
        out.push({ kind: 'text_property', layer: sel(p), property: 'fauxBold', equals: p.fauxBold, tolerance: 0 });
      }
      if (typeof p.fauxItalic === 'boolean') {
        out.push({ kind: 'text_property', layer: sel(p), property: 'fauxItalic', equals: p.fauxItalic, tolerance: 0 });
      }
      if (typeof p.paragraphWidth === 'number') {
        out.push({ kind: 'text_property', layer: sel(p), property: 'width', equals: p.paragraphWidth, tolerance: 3 });
      }
      return out;
    }

    // --- document ----------------------------------------------------------
    /*
     * Three mutating tools deliberately get no derived post-condition, because any
     * expected value would be a guess rather than a fact:
     *   - `trim_document` — the canvas ends up as small as the artwork allows;
     *   - `merge_visible_layers` — the layer count drops by an unknown amount,
     *     since it depends on how the visible layers are grouped;
     *   - `close_document` — the check would be that the document is *gone*, and
     *     no `document_property` can express absence.
     * All three report their own result, all three show up in the diff, and all
     * three are gated on confirmation. Deriving a check here would be theatre.
     */

    case 'create_document': {
      const out: Expectation[] = [];
      if (typeof p.width === 'number') {
        out.push({ kind: 'document_property', property: 'width', equals: p.width, tolerance: 0.5 });
      }
      if (typeof p.height === 'number') {
        out.push({ kind: 'document_property', property: 'height', equals: p.height, tolerance: 0.5 });
      }
      return out;
    }

    case 'set_selection': {
      // The selection's real extent depends on the artwork (a marquee clipped to
      // the canvas, a select-all over existing content), so the check is on the
      // requested size against what came back, not on a fixed number.
      const out: Expectation[] = [];
      if (typeof p.width === 'number') {
        out.push({ kind: 'document_property', property: 'selectionWidth', equals: p.width, tolerance: 1 });
      }
      if (typeof p.height === 'number') {
        out.push({ kind: 'document_property', property: 'selectionHeight', equals: p.height, tolerance: 1 });
      }
      return out;
    }

    case 'flatten_document':
      return [{ kind: 'layer_count', equals: 1 }];

    // --- selection --------------------------------------------------------
    case 'modify_selection': {
      // Only "is there a selection" is derivable. The resulting *size* of a grown,
      // smoothed or bordered selection depends on the artwork — a grow stops at the
      // canvas edge and a contract stops at the last fully-covered pixel — so any
      // expected number would be a guess dressed up as a check.
      return [{ kind: 'document_property', property: 'selectionActive', equals: p.action !== 'deselect', tolerance: 0 }];
    }

    // --- locking ----------------------------------------------------------
    /*
     * `set_layer_locking` gets no derived check, and the reason is specific rather
     * than convenient: `setLocking` is accepted on this build but no flag is
     * readable afterwards. `layer.locked` stays `false` whether or not the request
     * worked, and `lockedTransparency` / `lockedPosition` are not on the DOM at all.
     * A check against `isLocked` would therefore fail every time and prove nothing;
     * one that echoed the request back would only confirm the plugin sent it.
     *
     * Until a host reports the flags back, the tool reports `locking` (what was
     * asked for) and `lockReported` (what came back) side by side, and the caller
     * decides what to trust.
     */

    // --- files -------------------------------------------------------------
    // Writing a file cannot be checked by looking at the document, and these
    // tools were completely unverified: an export that silently wrote nothing,
    // or wrote to the wrong place, reported a clean step.

    case 'export_png':
    case 'export_jpg':
    case 'export_document':
    case 'save_document':
    case 'save_psd':
      return typeof p.path === 'string' ? [{ kind: 'file_exists', path: p.path }] : [];

    case 'duplicate_layers':
      // Only checkable when the caller named the copy. Photoshop's own "… copy"
      // suffix is not knowable in advance, so an unnamed duplicate gets no
      // expectation rather than a guessed one; the result carries the real name and
      // the diff shows the new layer.
      return typeof p.name === 'string'
        ? [{ kind: 'layer_exists', layer: { layerName: p.name }, where: 'document' }]
        : [];

    case 'duplicate_document':
      // Only checkable when the caller named the copy; otherwise Photoshop appends
      // its own " copy" suffix and any expected name would be a guess.
      return typeof p.name === 'string'
        ? [{ kind: 'document_property', property: 'name', equals: p.name, tolerance: 0 }]
        : [];

    case 'move_layer_to_group': {
      // The group is named rather than addressed by id, because that is the only
      // thing a snapshot can confirm a layer ended up inside.
      const group = sel(p.group);
      if (typeof group.layerName !== 'string') return [];
      return [{ kind: 'layer_parent_named', layer: sel(p.layer), groupName: group.layerName }];
    }

    case 'convert_color_mode':
      return [{ kind: 'document_property', property: 'colorMode', equals: String(p.mode), tolerance: 0 }];

    // --- pixels ------------------------------------------------------------
    // A filter or a transform changes pixels and bounds, never a named value the
    // snapshot carries. What *is* checkable is that the layer survived and is
    // still on the canvas, which catches the two ways these fail: the layer went
    // missing, or the operation moved it out of the document.
    case 'apply_image':
    case 'apply_filter':
    case 'flip_layer':
    case 'rotate_layer':
      return [
        { kind: 'layer_exists', layer: sel(p), where: 'document' },
        { kind: 'layer_property', layer: sel(p), property: 'withinCanvas', equals: true, tolerance: 0 },
      ];

    case 'create_layer':
      return [
        { kind: 'layer_exists', layer: { layerName: String(p.name) }, where: 'document' },
        { kind: 'layer_property', layer: { layerName: String(p.name) }, property: 'name', equals: String(p.name), tolerance: 0 },
      ];

    case 'create_group':
      return [
        { kind: 'layer_exists', layer: { layerName: String(p.name) }, where: 'document' },
        { kind: 'layer_property', layer: { layerName: String(p.name) }, property: 'type', equals: 'group', tolerance: 0 },
      ];

    case 'move_layer_to_group': {
      const group = sel(p.group);
      // Addressed by id, the resulting parentId is known up front; addressed by
      // name it is only knowable once the group exists, so assert the name.
      if (group.layerId !== undefined) {
        return [{ kind: 'layer_property', layer: sel(p.layer), property: 'parentId', equals: group.layerId, tolerance: 0 }];
      }
      if (group.layerName !== undefined) {
        return [
          { kind: 'layer_parent_named', layer: sel(p.layer), groupName: group.layerName },
          { kind: 'layer_property', layer: { layerName: group.layerName }, property: 'type', equals: 'group', tolerance: 0 },
        ];
      }
      return [];
    }

    case 'reorder_layer':
      return [{ kind: 'layer_exists', layer: sel(p.layer), where: 'document' }];

    // --- text --------------------------------------------------------------
    case 'create_text_layer':
      return [
        { kind: 'layer_exists', layer: p.name ? { layerName: String(p.name) } : { layerId: -1 }, where: 'document' },
        {
          kind: 'text_property',
          layer: p.name ? { layerName: String(p.name) } : { layerId: -1 },
          property: 'text',
          equals: String(p.text),
          tolerance: 0,
        },
      ];

    case 'update_text_layer': {
      if (p.text === undefined) return [];
      return [{ kind: 'text_property', layer: sel(p), property: 'text', equals: String(p.text), tolerance: 0 }];
    }

    case 'set_text_position':
      return [
        { kind: 'layer_property', layer: sel(p), property: 'x', equals: Number(p.x), tolerance: 1 },
        { kind: 'layer_property', layer: sel(p), property: 'y', equals: Number(p.y), tolerance: 1 },
      ];

    case 'set_text_font_size':
      return [{ kind: 'text_property', layer: sel(p), property: 'fontSize', equals: Number(p.fontSize), tolerance: 0.01 }];

    case 'set_text_color':
      return [{ kind: 'text_property', layer: sel(p), property: 'color', equals: p.color as Record<string, unknown>, tolerance: 0 }];

    // --- images ------------------------------------------------------------
    case 'place_image':
      return [{ kind: 'layer_exists', layer: { layerName: String(p.name ?? '') }, where: 'document' }];

    case 'resize_layer': {
      const out: Expectation[] = [{ kind: 'layer_exists', layer: sel(p), where: 'document' }];
      if (typeof p.width === 'number') out.push({ kind: 'layer_property', layer: sel(p), property: 'width', equals: p.width, tolerance: 2 });
      if (typeof p.height === 'number') out.push({ kind: 'layer_property', layer: sel(p), property: 'height', equals: p.height, tolerance: 2 });
      return out;
    }

    // --- canvas ------------------------------------------------------------
    case 'resize_canvas':
      return [
        { kind: 'document_property', property: 'width', equals: Number(p.width), tolerance: 1 },
        { kind: 'document_property', property: 'height', equals: Number(p.height), tolerance: 1 },
      ];

    case 'crop_document':
      return [
        { kind: 'document_property', property: 'width', equals: Number(p.width), tolerance: 1 },
        { kind: 'document_property', property: 'height', equals: Number(p.height), tolerance: 1 },
      ];

    case 'duplicate_layers':
      // Only checkable when the caller named the copy. Photoshop's own "… copy"
      // suffix is not knowable in advance, so an unnamed duplicate gets no
      // expectation rather than a guessed one; the result carries the real name and
      // the diff shows the new layer.
      return typeof p.name === 'string'
        ? [{ kind: 'layer_exists', layer: { layerName: p.name }, where: 'document' }]
        : [];

    case 'duplicate_document': {
      if (p.name === undefined) return [];
      return [{ kind: 'document_property', property: 'name', equals: String(p.name), tolerance: 0 }];
    }

    // --- export ------------------------------------------------------------
    case 'export_png':
    case 'export_jpg':
    case 'export_document':
    case 'save_psd':
    case 'save_document':
      return typeof p.path === 'string' && p.path.length > 0
        ? [{ kind: 'file_exists', path: String(p.path) }]
        : [];

    default:
      // Read-only tools and anything unmodelled: nothing to verify.
      void OPERATIONS[op];
      return [];
  }
}

/**
 * Merges planner-supplied expectations with derived ones.
 *
 * Planner entries come first (they may express intent we cannot derive, e.g.
 * "no layer may leave the canvas"), derived entries are appended and only added
 * when they are not already covered by an identical derived key — this keeps
 * verification cheap and the report readable.
 */
export function mergeExpectations(
  declared: readonly Expectation[],
  op: PhotoshopOpName,
  params: unknown,
): Expectation[] {
  const derived = deriveExpectations(op, params as never);
  if (derived.length === 0) return [...declared];
  const covered = new Set(derived.map(expectationKey));
  const extra = declared.filter((e) => !covered.has(expectationKey(e)));
  return [...derived, ...extra];
}

function expectationKey(e: Expectation): string {
  const layer = 'layer' in e ? JSON.stringify(e.layer) : '';
  switch (e.kind) {
    case 'layer_property':
      return `${e.kind}|${layer}|${e.property}`;
    case 'text_property':
      return `${e.kind}|${layer}|${e.property}`;
    case 'document_property':
      return `${e.kind}|${e.property}`;
    case 'layer_parent_named':
      return `${e.kind}|${layer}|${e.groupName}`;
    case 'layer_exists':
    case 'layer_absent':
      return `${e.kind}|${layer}`;
    case 'file_exists':
      return `${e.kind}|${e.path}`;
    case 'layer_count':
      return e.kind;
    case 'custom':
      return `${e.kind}|${e.description}`;
  }
}
