import {
  type PhotoshopAdapter,
  type AdapterConnection,
  type AdapterTarget,
  type ParamsOf,
  type ResultOf,
  type RgbColor,
  type TextAlign,
  type LayerSelector,
} from '@photoshop-ai-studio/shared';
import type { PluginBridge } from '../bridge/plugin-bridge.js';
import { IMAGE_EXTENSIONS, OUTPUT_EXTENSIONS, Workspace } from '../workspace.js';

/**
 * `PhotoshopAdapter` over the UXP bridge.
 *
 * This is the only place where an MCP tool call becomes a bridge frame, and the
 * only place (besides the mock) where filesystem policy is applied. It contains
 * no UXP knowledge: the plugin owns every Adobe-specific detail.
 */
export class UxpRemoteAdapter implements PhotoshopAdapter {
  readonly target: AdapterTarget = { kind: 'uxp', label: 'Photoshop (UXP plugin)' };

  constructor(
    private readonly bridge: PluginBridge,
    private readonly workspace: Workspace,
  ) {}

  isConnected(): boolean {
    return this.bridge.isConnected();
  }

  getConnection(): AdapterConnection {
    return this.bridge.getConnection();
  }

  private send<K extends string>(op: K, params: unknown): Promise<unknown> {
    return this.bridge.request(op, params);
  }

  // --- document ------------------------------------------------------------

  async getDocument(): Promise<ResultOf<'get_document'>> {
    return (await this.send('get_document', {})) as ResultOf<'get_document'>;
  }

  async getDocumentInfo(): Promise<ResultOf<'get_document_info'>> {
    return (await this.send('get_document_info', {})) as ResultOf<'get_document_info'>;
  }

  async duplicateDocument(params: ParamsOf<'duplicate_document'>): Promise<ResultOf<'duplicate_document'>> {
    return (await this.send('duplicate_document', params)) as ResultOf<'duplicate_document'>;
  }

  async saveDocument(params: ParamsOf<'save_document'>): Promise<ResultOf<'save_document'>> {
    const path = params.path
      ? this.workspace.resolveOutput(params.path, 'document.psd')
      : undefined;
    if (path) Workspace.assertExtension(path, ['.psd'], 'save_document');
    return (await this.send('save_document', { ...params, path })) as ResultOf<'save_document'>;
  }

  // --- layers --------------------------------------------------------------

  async getLayers(params: ParamsOf<'get_layers'>): Promise<ResultOf<'get_layers'>> {
    return (await this.send('get_layers', params)) as ResultOf<'get_layers'>;
  }

  async getLayer(sel: ParamsOf<'get_layer'>): Promise<ResultOf<'get_layer'>> {
    return (await this.send('get_layer', sel)) as ResultOf<'get_layer'>;
  }

  async createLayer(params: ParamsOf<'create_layer'>): Promise<ResultOf<'create_layer'>> {
    return (await this.send('create_layer', params)) as ResultOf<'create_layer'>;
  }

  async deleteLayer(sel: ParamsOf<'delete_layer'>): Promise<ResultOf<'delete_layer'>> {
    return (await this.send('delete_layer', sel)) as ResultOf<'delete_layer'>;
  }

  async renameLayer(sel: ParamsOf<'rename_layer'>): Promise<ResultOf<'rename_layer'>> {
    return (await this.send('rename_layer', sel)) as ResultOf<'rename_layer'>;
  }

  async moveLayer(sel: ParamsOf<'move_layer'> & { dx?: number; dy?: number }): Promise<ResultOf<'move_layer'>> {
    // Argument *shape* rules (absolute vs relative, at least one coordinate) live
    // in `validateParams` so both adapters apply them identically.
    return (await this.send('move_layer', sel)) as ResultOf<'move_layer'>;
  }

  async setLayerVisibility(sel: ParamsOf<'set_layer_visibility'>): Promise<ResultOf<'set_layer_visibility'>> {
    return (await this.send('set_layer_visibility', sel)) as ResultOf<'set_layer_visibility'>;
  }

  async setLayerOpacity(sel: ParamsOf<'set_layer_opacity'>): Promise<ResultOf<'set_layer_opacity'>> {
    return (await this.send('set_layer_opacity', sel)) as ResultOf<'set_layer_opacity'>;
  }

  async createGroup(params: ParamsOf<'create_group'>): Promise<ResultOf<'create_group'>> {
    return (await this.send('create_group', params)) as ResultOf<'create_group'>;
  }

  async moveLayerToGroup(layer: LayerSelector, group: LayerSelector): Promise<ResultOf<'move_layer_to_group'>> {
    return (await this.send('move_layer_to_group', { layer, group })) as ResultOf<'move_layer_to_group'>;
  }

  async reorderLayer(params: ParamsOf<'reorder_layer'>): Promise<ResultOf<'reorder_layer'>> {
    return (await this.send('reorder_layer', params)) as ResultOf<'reorder_layer'>;
  }

  // --- text ----------------------------------------------------------------

  async createTextLayer(params: ParamsOf<'create_text_layer'>): Promise<ResultOf<'create_text_layer'>> {
    return (await this.send('create_text_layer', params)) as ResultOf<'create_text_layer'>;
  }

  async getTextLayer(sel: ParamsOf<'get_text_layer'>): Promise<ResultOf<'get_text_layer'>> {
    return (await this.send('get_text_layer', sel)) as ResultOf<'get_text_layer'>;
  }

  async updateTextLayer(
    sel: ParamsOf<'update_text_layer'>,
    patch: { text?: string; font?: string; fontSize?: number; color?: RgbColor; alignment?: TextAlign },
  ): Promise<ResultOf<'update_text_layer'>> {
    const payload = { ...sel, ...patch };
    return (await this.send('update_text_layer', payload)) as ResultOf<'update_text_layer'>;
  }

  async setTextPosition(sel: ParamsOf<'set_text_position'>): Promise<ResultOf<'set_text_position'>> {
    return (await this.send('set_text_position', sel)) as ResultOf<'set_text_position'>;
  }

  async setTextFontSize(sel: ParamsOf<'set_text_font_size'>): Promise<ResultOf<'set_text_font_size'>> {
    return (await this.send('set_text_font_size', sel)) as ResultOf<'set_text_font_size'>;
  }

  async setTextColor(sel: ParamsOf<'set_text_color'>): Promise<ResultOf<'set_text_color'>> {
    return (await this.send('set_text_color', sel)) as ResultOf<'set_text_color'>;
  }

  // --- images --------------------------------------------------------------

  async placeImage(params: ParamsOf<'place_image'>): Promise<ResultOf<'place_image'>> {
    const path = this.workspace.resolvePath(params.path, { defaultDir: 'assets' });
    Workspace.assertExtension(path, IMAGE_EXTENSIONS, 'place_image');
    return (await this.send('place_image', { ...params, path })) as ResultOf<'place_image'>;
  }

  async resizeLayer(params: ParamsOf<'resize_layer'>): Promise<ResultOf<'resize_layer'>> {
    return (await this.send('resize_layer', params)) as ResultOf<'resize_layer'>;
  }

  // --- canvas --------------------------------------------------------------

  async resizeCanvas(params: ParamsOf<'resize_canvas'>): Promise<ResultOf<'resize_canvas'>> {
    return (await this.send('resize_canvas', params)) as ResultOf<'resize_canvas'>;
  }

  async cropDocument(params: ParamsOf<'crop_document'>): Promise<ResultOf<'crop_document'>> {
    return (await this.send('crop_document', params)) as ResultOf<'crop_document'>;
  }

  // --- export --------------------------------------------------------------

  async exportDocument(params: ParamsOf<'export_document'>): Promise<ResultOf<'export_document'>> {
    const ext = params.format === 'jpg' ? '.jpg' : params.format === 'psd' ? '.psd' : '.png';
    const path = this.workspace.resolveOutput(params.path, `export${ext}`);
    Workspace.assertExtension(path, OUTPUT_EXTENSIONS, 'export_document');
    return (await this.send('export_document', { ...params, path })) as ResultOf<'export_document'>;
  }

  async exportPng(params: ParamsOf<'export_png'>): Promise<ResultOf<'export_png'>> {
    const path = this.workspace.resolveOutput(params.path, 'export.png');
    Workspace.assertExtension(path, ['.png'], 'export_png');
    return (await this.send('export_png', { ...params, path })) as ResultOf<'export_png'>;
  }

  async exportJpg(params: ParamsOf<'export_jpg'>): Promise<ResultOf<'export_jpg'>> {
    const path = this.workspace.resolveOutput(params.path, 'export.jpg');
    Workspace.assertExtension(path, ['.jpg', '.jpeg'], 'export_jpg');
    return (await this.send('export_jpg', { ...params, path })) as ResultOf<'export_jpg'>;
  }

  async savePsd(params: ParamsOf<'save_psd'>): Promise<ResultOf<'save_psd'>> {
    const path = this.workspace.resolveOutput(params.path, 'document.psd');
    Workspace.assertExtension(path, ['.psd'], 'save_psd');
    return (await this.send('save_psd', { ...params, path })) as ResultOf<'save_psd'>;
  }

  // --- preview -------------------------------------------------------------

  async renderPreview(params: ParamsOf<'render_preview'>): Promise<ResultOf<'render_preview'>> {
    return (await this.send('render_preview', params)) as ResultOf<'render_preview'>;
  }
}
