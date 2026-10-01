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
