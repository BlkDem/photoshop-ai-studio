import { describe, expect, it } from 'vitest';

import { deriveExpectations } from '@photoshop-ai-studio/shared';


describe('create_layer measures the layer it made', () => {
  it('checks the requested size instead of trusting the request', () => {
    // Existence and name passed on a 0×0 layer: this build's DOM layer factories
    // return an empty layer, name it correctly, and ignore width/height/fill. Both
    // original expectations were satisfied by a layer containing nothing, so
    // verification reported success and the plan continued on a blank.
    const withSize = deriveExpectations('create_layer', { name: 'Rect', width: 400, height: 300 });
    expect(withSize).toContainEqual({ kind: 'layer_property', layer: { layerName: 'Rect' }, property: 'width', equals: 400, tolerance: 2 });
    expect(withSize).toContainEqual({ kind: 'layer_property', layer: { layerName: 'Rect' }, property: 'height', equals: 300, tolerance: 2 });
  });

  it('still checks existence and name', () => {
    const derived = deriveExpectations('create_layer', { name: 'Rect', width: 400, height: 300 });
    expect(derived).toContainEqual({ kind: 'layer_exists', layer: { layerName: 'Rect' }, where: 'document' });
    expect(derived).toContainEqual({ kind: 'layer_property', layer: { layerName: 'Rect' }, property: 'name', equals: 'Rect', tolerance: 0 });
  });
});

describe('strokes measure the layer they were asked to create', () => {
  const base = { documentId: 'active', brushSize: 10, color: { r: 0, g: 0, b: 0 } };

  it('checks the named layer when one was given', () => {
    const derived = deriveExpectations('stroke_path', {
      ...base,
      newLayer: true,
      layerName: 'Ink',
      path: [{ type: 'move', point: { x: 0, y: 0 } }, { type: 'line', point: { x: 10, y: 10 } }],
    });

    expect(derived).toContainEqual({ kind: 'layer_exists', layer: { layerName: 'Ink' }, where: 'document' });
  });

  it('checks the default layer name rather than skipping the check', () => {
    // `newLayer` without `layerName` is the common case, and it is exactly the
    // case where a stroke that died before painting would otherwise pass
    // verification with nothing to show for it.
    const derived = deriveExpectations('paint_stroke', {
      ...base,
      newLayer: true,
      points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    });

    expect(derived).toContainEqual({ kind: 'layer_exists', layer: { layerName: 'Stroke' }, where: 'document' });
  });

  it('checks nothing when the stroke reuses the active layer', () => {
    // There is no mechanical property to assert on ink — the plugin reads the
    // canvas itself and fails a stroke that changed nothing, so a pixel check
    // here would only duplicate a weaker version of it.
    expect(
      deriveExpectations('stroke_path', {
        ...base,
        path: [{ type: 'move', point: { x: 0, y: 0 } }, { type: 'line', point: { x: 10, y: 10 } }],
      }),
    ).toEqual([]);
  });
});
