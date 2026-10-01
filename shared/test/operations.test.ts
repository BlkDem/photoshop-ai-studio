import { describe, expect, it } from 'vitest';

import {
  OP_NAMES,
  OPERATIONS,
  TOOL_META,
  TOOL_META_MAP,
  TOOL_NAME_LIST,
  buildLayerTree,
  deriveExpectations,
  diffSnapshots,
  findLayer,
  flattenLayerTree,
  formatDiff,
  hexToRgb,
  normalizeColor,
  opForTool,
  rgbToHex,
  toolForOp,
  validateParams,
  type DocumentSnapshot,
  type LayerInfo,
} from '@photoshop-ai-studio/shared';

/**
 * Registry integrity.
 *
 * `shared/photoshop/operations.ts` is the single source of truth for the whole
 * tool surface, so its invariants are worth pinning down: if these drift, the MCP
 * server, the plugin and the Studio all drift with them.
 */
describe('operation registry', () => {
  it('exposes one tool per operation', () => {
    expect(OP_NAMES.length).toBe(TOOL_META.length);
    expect(TOOL_NAME_LIST.length).toBe(OP_NAMES.length);
  });

  it('names every tool photoshop.<op>', () => {
    for (const op of OP_NAMES) {
      expect(toolForOp(op)).toBe(`photoshop.${op}`);
      expect(opForTool(toolForOp(op))).toBe(op);
    }
  });

  it('has no duplicate tool names', () => {
    expect(new Set(TOOL_NAME_LIST).size).toBe(TOOL_NAME_LIST.length);
  });

  it('documents every tool with a usable description', () => {
    for (const meta of TOOL_META) {
      expect(meta.title.length, `${meta.tool} title`).toBeGreaterThan(2);
      expect(meta.description.length, `${meta.tool} description`).toBeGreaterThan(40);
      expect(TOOL_META_MAP[meta.tool]).toBe(meta);
    }
  });

  it('marks exactly the destructive tools', () => {
    const destructive = TOOL_META.filter((t) => t.destructive).map((t) => t.op).sort();
    // Listed rather than derived: a tool that gains `destructive` by accident
    // should fail here, and one that loses it should too. The destructive set is
    // a safety decision, not an implementation detail.
    expect(destructive).toEqual(
      [
        'apply_filter',
        // Composites another document's pixels *over* the layer's, replacing what
        // was there — a filter adds to it, this does not.
        'apply_image',
        'close_document',
        'convert_color_mode',
        'crop_document',
        'delete_layer',
        'export_document',
        'export_jpg',
        'export_png',
        'flatten_document',
        'flip_layer',
        'merge_visible_layers',
        'rasterize_layer',
        'rotate_layer',
        'save_document',
        'save_psd',
        'trim_document',
      ].sort(),
    );
  });

  it('requires confirmation for every destructive tool', () => {
    for (const meta of TOOL_META) {
      if (meta.destructive) expect(meta.requiresConfirmation, `${meta.tool} must be gated`).toBe(true);
    }
  });

  it('covers every capability listed in the brief', () => {
    // Explicit list rather than "all ops": a capability removed by accident must
    // fail here rather than quietly disappear from the product.
    for (const required of [
      'get_document',
      'get_document_info',
      'save_document',
      'export_document',
      'get_layers',
      'get_layer',
      'create_layer',
      'delete_layer',
      'rename_layer',
      'move_layer',
      'set_layer_visibility',
      'set_layer_opacity',
      'create_group',
      'move_layer_to_group',
      'create_text_layer',
      'get_text_layer',
      'update_text_layer',
      'set_text_position',
      'set_text_font_size',
      'set_text_color',
      'place_image',
      'resize_layer',
      'resize_canvas',
      'crop_document',
      'export_png',
      'export_jpg',
      'save_psd',
    ]) {
      expect(OP_NAMES, `missing ${required}`).toContain(required);
    }
  });

  it('never exposes a batchPlay / escape-hatch tool', () => {
    for (const name of TOOL_NAME_LIST) {
      expect(name).not.toMatch(/batch|execute|script|eval|raw|shell|command/i);
    }
  });
});

describe('parameter validation', () => {
  it('accepts a minimal valid call and applies defaults', () => {
    const parsed = validateParams('create_text_layer', { text: 'Hello' });
    expect(parsed).toMatchObject({
      documentId: 'active',
      text: 'Hello',
      fontSize: 24,
      color: { r: 0, g: 0, b: 0 },
    });
  });

  it('rejects a layer selector with both id and name', () => {
    expect(() => validateParams('get_layer', { layerId: 3, layerName: 'Title' })).toThrow(/must be omitted when/i);
  });

  it('rejects a layer selector with neither id nor name', () => {
    expect(() => validateParams('rename_layer', { name: 'x' })).toThrow(/either `layerId` or `layerName`/i);
  });

  it('rejects absolute and relative moves together', () => {
    expect(() => validateParams('move_layer', { layerName: 'Title', x: 10, dx: 5 })).toThrow(/not both/i);
  });

  it('rejects a move with no coordinates at all', () => {
    expect(() => validateParams('move_layer', { layerName: 'Title' })).toThrow(/at least one of/i);
  });

  it('accepts a relative-only move', () => {
    expect(validateParams('move_layer', { layerId: 2, dx: 5, dy: -5 })).toMatchObject({ dx: 5, dy: -5 });
  });

  it('requires a target for relative reorder placements', () => {
    expect(() => validateParams('reorder_layer', { layer: { layerId: 1 }, placement: 'placeBefore' })).toThrow(
      /requires a target/i,
    );
    expect(() =>
      validateParams('reorder_layer', { layer: { layerId: 1 }, placement: 'placeAtEnd' }),
    ).not.toThrow();
  });

  it('requires something to resize', () => {
    expect(() => validateParams('resize_layer', { layerId: 1 })).toThrow(/width, height or scale/i);
  });

  it('rejects out-of-range values from the schema', () => {
    expect(() => validateParams('set_layer_opacity', { layerId: 1, opacity: 120 })).toThrow();
    expect(() => validateParams('resize_canvas', { width: -5, height: 10 })).toThrow();
    expect(() => validateParams('set_text_font_size', { layerId: 1, fontSize: 5000 })).toThrow();
  });

  it('accepts colour as an object or a hex string', () => {
    // The schema keeps the caller's shape; normalisation happens once, in the
    // tool dispatch, so the value crossing the bridge is always `{r,g,b}`.
    expect(validateParams('set_text_color', { layerId: 1, color: '#FF8800' }).color).toBe('#FF8800');
    expect(validateParams('set_text_color', { layerId: 1, color: { r: 1, g: 2, b: 3 } }).color).toEqual({ r: 1, g: 2, b: 3 });
    expect(() => validateParams('set_text_color', { layerId: 1, color: 'orange' })).toThrow();
  });
});

describe('expectation derivation', () => {
  it('derives the rename outcome from the tool arguments alone', () => {
    expect(deriveExpectations('rename_layer', { layerName: 'Logo', name: 'Company Logo' })).toEqual([
      { kind: 'layer_property', layer: { layerName: 'Logo' }, property: 'name', equals: 'Company Logo', tolerance: 0 },
    ]);
  });

  it('derives canvas geometry for resize_canvas', () => {
    const expectations = deriveExpectations('resize_canvas', { width: 1080, height: 1080, anchor: 'center' });
    expect(expectations).toHaveLength(2);
    expect(expectations.every((e) => e.kind === 'document_property')).toBe(true);
  });

  it('derives absence for delete_layer', () => {
    expect(deriveExpectations('delete_layer', { layerId: 7 })[0]).toMatchObject({ kind: 'layer_absent', layer: { layerId: 7 } });
  });

  it('derives file existence for exports with an explicit path', () => {
    expect(deriveExpectations('export_png', { path: 'out/a.png' })[0]).toEqual({
      kind: 'file_exists',
      path: 'out/a.png',
    });
    expect(deriveExpectations('export_png', {})).toEqual([]);
  });

  it('derives nothing for read-only tools', () => {
    expect(deriveExpectations('get_document', {})).toEqual([]);
    expect(deriveExpectations('get_layers', { documentId: 'active', includeHidden: true })).toEqual([]);
  });
});

describe('snapshot diffing', () => {
  const layer = (over: Partial<LayerInfo> = {}): LayerInfo => ({
    id: 1,
    name: 'Title',
    type: 'text',
    visible: true,
    opacity: 100,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    parentId: null,
    ...over,
  });

  const snapshot = (layers: LayerInfo[], doc: Partial<DocumentSnapshot['document']> = {}): DocumentSnapshot => ({
    capturedAt: '2026-01-01T00:00:00.000Z',
    document: {
      id: 'd1',
      name: 'banner.psd',
      width: 1920,
      height: 1080,
      resolution: 72,
      colorMode: 'RGB',
      layerCount: layers.length,
      ...doc,
    },
    layers,
  });

  it('reports no changes for identical snapshots', () => {
    const diff = diffSnapshots(snapshot([layer()]), snapshot([layer()]));
    expect(diff.hasChanges).toBe(false);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('detects canvas geometry changes', () => {
    const diff = diffSnapshots(snapshot([layer()]), snapshot([layer()], { width: 1080, height: 1350 }));
    expect(diff.hasChanges).toBe(true);
    expect(diff.documentChanges).toEqual([
      { property: 'width', before: 1920, after: 1080 },
      { property: 'height', before: 1080, after: 1350 },
    ]);
  });

  it('detects moved and resized layers', () => {
    const diff = diffSnapshots(snapshot([layer()]), snapshot([layer({ x: 80, y: 220, opacity: 70 })]));
    const changes = diff.layers[0]?.changes ?? [];
    expect(diff.layers[0]?.status).toBe('changed');
    expect(changes).toEqual(
      expect.arrayContaining([
        { property: 'x', before: 0, after: 80 },
        { property: 'y', before: 0, after: 220 },
        { property: 'opacity', before: 100, after: 70 },
      ]),
    );
  });

  it('detects added and removed layers', () => {
    const diff = diffSnapshots(snapshot([layer({ id: 1 })]), snapshot([layer({ id: 2, name: 'New' })]));
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.removed).toBe(1);
  });

  it('detects reparenting', () => {
    const diff = diffSnapshots(snapshot([layer({ id: 2 })]), snapshot([layer({ id: 2, parentId: 1 })]));
    expect(diff.layers[0]?.changes).toContainEqual({ property: 'parentId', before: null, after: 1 });
  });

  it('renders the human-readable diff block', () => {
    const diff = diffSnapshots(snapshot([layer()]), snapshot([layer({ opacity: 70 })], { width: 1080, height: 1350 }));
    const text = formatDiff(diff);
    expect(text).toContain('DOCUMENT DIFF');
    expect(text).toContain('width: 1920 → 1080');
    expect(text).toContain('opacity: 100 → 70');
    expect(text).toContain('1 changed');
  });

  it('renders an explicit no-change block', () => {
    expect(formatDiff(diffSnapshots(snapshot([]), snapshot([])))).toContain('(no changes)');
  });
});

describe('layer helpers', () => {
  const layers: LayerInfo[] = [
    { id: 1, name: 'Background', type: 'pixel', visible: true, opacity: 100, x: 0, y: 0, width: 100, height: 100, parentId: null },
    { id: 2, name: 'Header', type: 'group', visible: true, opacity: 100, x: 0, y: 0, width: 0, height: 0, parentId: null },
    { id: 3, name: 'Logo', type: 'smartObject', visible: true, opacity: 100, x: 10, y: 10, width: 20, height: 20, parentId: 2 },
    { id: 4, name: 'Title', type: 'text', visible: true, opacity: 100, x: 10, y: 40, width: 50, height: 20, parentId: 2 },
  ];

  it('rebuilds the hierarchy from parentId', () => {
    const tree = buildLayerTree(layers);
    expect(tree.map((n) => n.name)).toEqual(['Background', 'Header']);
    expect(tree[1]?.childLayers.map((n) => n.name)).toEqual(['Logo', 'Title']);
    expect(tree[1]?.childLayers[0]?.depth).toBe(1);
  });

  it('treats an orphaned parentId as a root rather than losing the layer', () => {
    const tree = buildLayerTree([...layers, { ...layers[0]!, id: 9, name: 'Orphan', parentId: 404 }]);
    expect(tree.map((n) => n.name)).toContain('Orphan');
  });

  it('flattens a tree back to a list', () => {
    expect(flattenLayerTree(buildLayerTree(layers)).map((n) => n.name)).toEqual([
      'Background',
      'Header',
      'Logo',
      'Title',
    ]);
  });

  it('finds a layer by id and by name', () => {
    expect(findLayer(layers, { layerId: 3 })?.name).toBe('Logo');
    expect(findLayer(layers, { layerName: 'Title' })?.name).toBe('Title');
    expect(findLayer(layers, { layerName: 'Missing' })).toBeNull();
  });
});

describe('colour helpers', () => {
  it('round-trips hex and rgb', () => {
    expect(hexToRgb('#1A2B3C')).toEqual({ r: 26, g: 43, b: 60 });
    expect(rgbToHex({ r: 26, g: 43, b: 60 })).toBe('#1A2B3C');
    expect(normalizeColor('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60 });
    expect(normalizeColor({ r: 1, g: 2, b: 3 })).toEqual({ r: 1, g: 2, b: 3 });
  });
});

describe('operation schemas', () => {
  it('parses every registry result schema', () => {
    // Cheap guard against a malformed `.extend()` in the registry.
    for (const op of OP_NAMES) {
      expect(() => OPERATIONS[op].result.safeParse(undefined)).not.toThrow();
    }
  });

  it('exposes a schema for params and result on every operation', () => {
    for (const op of OP_NAMES) {
      expect(OPERATIONS[op].params).toBeDefined();
      expect(OPERATIONS[op].result).toBeDefined();
      expect(typeof OPERATIONS[op].params.parse).toBe('function');
      expect(typeof OPERATIONS[op].result.parse).toBe('function');
    }
  });
});
