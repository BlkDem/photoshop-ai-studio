import { StudioException } from '../errors.js';
import { assertLayerSelector } from './layer.js';
import { OPERATIONS, type ParamsOf, type PhotoshopOpName } from './operations.js';

/**
 * Cross-field validation that zod schemas cannot express.
 *
 * Kept in one place, in `shared`, so the MCP server applies exactly the same
 * rules regardless of which adapter is behind the tools — the UXP bridge and the
 * in-memory mock must never disagree about what a valid request looks like.
 *
 * Schemas are intentionally effect-free (no `.refine()` / `.transform()`) so the
 * MCP tool JSON Schema stays a plain `object`; everything expressible only across
 * fields lives here instead.
 */
export function validateParams<K extends PhotoshopOpName>(op: K, params: unknown): ParamsOf<K> {
  const schema = OPERATIONS[op].params;
  const parsed = schema.parse(params ?? {}) as ParamsOf<K>;
  const record = parsed as unknown as Record<string, unknown>;

  switch (op) {
    // --- every op that addresses a layer -----------------------------------
    case 'get_layer':
    case 'delete_layer':
    case 'rename_layer':
    case 'set_layer_visibility':
    case 'set_layer_opacity':
    case 'get_text_layer':
    case 'set_text_position':
    case 'set_text_font_size':
    case 'set_text_color':
      assertLayerSelector(record as never);
      break;

    case 'move_layer': {
      assertLayerSelector(record as never);
      const absolute = record.x !== undefined || record.y !== undefined;
      const relative = record.dx !== undefined || record.dy !== undefined;
      if (!absolute && !relative) {
        throw new StudioException('INVALID_PARAMS', 'move_layer needs at least one of x, y, dx, dy');
      }
      if (absolute && relative) {
        throw new StudioException(
          'INVALID_PARAMS',
          'move_layer accepts either x/y (absolute) or dx/dy (relative), not both',
        );
      }
      break;
    }

    case 'update_text_layer':
      assertLayerSelector(record as never);
      break;

    case 'create_group':
      if (record.layer) assertLayerSelector(record.layer as never);
      break;

    case 'move_layer_to_group': {
      const group = record.group as Record<string, unknown> | undefined;
      const layer = record.layer as Record<string, unknown> | undefined;
      assertLayerSelector(layer as never);
      assertLayerSelector(group as never);
      break;
    }

    case 'reorder_layer': {
      const layer = record.layer as Record<string, unknown>;
      assertLayerSelector(layer as never);
      const target = record.target as Record<string, unknown> | undefined;
      if (target) assertLayerSelector(target as never);
      const placement = String(record.placement);
      if ((placement === 'placeBefore' || placement === 'placeAfter') && !target) {
        throw new StudioException(
          'INVALID_PARAMS',
          `reorder_layer with placement "${placement}" requires a target layer`,
        );
      }
      break;
    }

    case 'resize_layer': {
      assertLayerSelector(record as never);
      if (record.width === undefined && record.height === undefined && record.scale === undefined) {
        throw new StudioException('INVALID_PARAMS', 'resize_layer needs width, height or scale');
      }
      break;
    }

    case 'save_psd':
    case 'export_png':
    case 'export_jpg':
      // `overwrite: false` is the safe default; nothing to check here, the
      // adapters refuse to clobber an existing file unless overwrite is set.
      break;

    default:
      break;
  }

  return parsed;
}

/** Reads the layer selector out of a params object regardless of the op shape. */
export function selectorOf(params: unknown): { layerId?: number; layerName?: string } {
  const record = (params ?? {}) as Record<string, unknown>;
  return {
    ...(typeof record.layerId === 'number' ? { layerId: record.layerId } : {}),
    ...(typeof record.layerName === 'string' ? { layerName: record.layerName } : {}),
  };
}

/** Reads the nested `{layer, group}` selectors used by group operations. */
export function nestedSelectorOf(params: unknown, key: 'layer' | 'group'): { layerId?: number; layerName?: string } {
  const record = (params ?? {}) as Record<string, unknown>;
  return selectorOf(record[key]);
}
