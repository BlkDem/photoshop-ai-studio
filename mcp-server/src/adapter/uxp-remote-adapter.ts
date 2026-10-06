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
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { StudioException, type ExportResult, type StagedFile } from '@photoshop-ai-studio/shared';
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

  /**
   * Diagnostics go straight down the bridge.
   *
   * They have no entry in the dispatch table by design — a mock must never be
   * able to answer "which route actually fills a layer" — so this is the only
   * path that can reach them, and only an adapter talking to a real Photoshop
   * has one.
   */
  diagnostic(op: string, params: unknown): Promise<unknown> {
    return this.send(op, params);
  }

  /**
   * Rewrites every `path` in an operation payload to its workspace-relative form.
   *
   * The bridge carries relative paths on purpose: the plugin can be on another
   * operating system, where an absolute path from this process means nothing.
   */
  private bridgeParams(params: Record<string, unknown>): Record<string, unknown> {
    if (typeof params.path === 'string') {
      return { ...params, path: this.workspace.toBridgePath(params.path) };
    }
    return params;
  }

  /**
   * Moves a file the plugin staged in its sandbox into the workspace.
   *
   * This process, not the plugin, is what has filesystem permissions — see
   * `ps.stageEntry`. The write goes to a sibling temp name and is renamed into
   * place, so a reader never observes a half-written export and a failure never
   * destroys the previous version of a file.
   */
  private async publish(
    staged: StagedFile,
    destination: string,
    format: ExportResult['format'],
    overwritten: boolean,
  ): Promise<ExportResult> {
    const source = this.workspace.toLocalPath(staged.nativePath);
    await mkdir(dirname(destination), { recursive: true });

    const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(6).toString('hex')}.part`);
    try {
      await copyFile(source, temporary);
    } catch (cause) {
      throw new StudioException(
        'EXPORT_FAILED',
        `Photoshop produced the file at "${staged.nativePath}" but this process could not read it. ` +
          'When the server runs in WSL and Photoshop on Windows, the plugin sandbox must live on a drive WSL mounts.',
        { details: { nativePath: staged.nativePath, localPath: source }, recoverable: false, cause },
      );
    }

    let bytes: number;
    try {
      bytes = (await stat(temporary)).size;
      await rm(destination, { force: true });
      await rename(temporary, destination);
    } catch (cause) {
      await rm(temporary, { force: true });
      throw new StudioException('EXPORT_FAILED', `Could not publish "${basename(destination)}".`, {
        details: { destination },
        recoverable: true,
        cause,
      });
    } finally {
      // The staged copy is transport scratch; leaving it would grow without
      // bound across a long session.
      void rm(source, { force: true }).catch(() => undefined);
    }

    return { path: destination, format, bytes, overwritten };
  }

  /** Sends a file-producing op and publishes whatever the plugin staged. */
  private async exportTo(
    op: 'export_png' | 'export_jpg' | 'save_psd' | 'export_document' | 'save_document',
    params: Record<string, unknown>,
    destination: string,
    format: ExportResult['format'],
    overwritten: boolean,
  ): Promise<ExportResult> {
    const raw = (await this.send(op, params)) as { staged?: StagedFile };
    if (!raw || !raw.staged) {
      throw new StudioException('EXPORT_FAILED', `Photoshop did not stage a file for ${op}.`, {
        details: { op, returned: raw },
        recoverable: true,
      });
    }
    return this.publish(raw.staged, destination, format, overwritten);
  }

  // --- document ------------------------------------------------------------

  async getDocument(): Promise<ResultOf<'get_document'>> {
    return (await this.send('get_document', {})) as ResultOf<'get_document'>;
  }

  async getDocumentInfo(): Promise<ResultOf<'get_document_info'>> {
    return (await this.send('get_document_info', {})) as ResultOf<'get_document_info'>;
  }

  async getCapabilities(): Promise<ResultOf<'get_capabilities'>> {
    return (await this.send('get_capabilities', {})) as ResultOf<'get_capabilities'>;
  }

  async setSelection(params: ParamsOf<'set_selection'>): Promise<ResultOf<'set_selection'>> {
    return (await this.send('set_selection', params)) as ResultOf<'set_selection'>;
  }

  async setLayerBlendMode(params: ParamsOf<'set_layer_blend_mode'>): Promise<ResultOf<'set_layer_blend_mode'>> {
    return (await this.send('set_layer_blend_mode', params)) as ResultOf<'set_layer_blend_mode'>;
  }

  async setLayerFillOpacity(params: ParamsOf<'set_layer_fill_opacity'>): Promise<ResultOf<'set_layer_fill_opacity'>> {
    return (await this.send('set_layer_fill_opacity', params)) as ResultOf<'set_layer_fill_opacity'>;
  }

  async setLayerLocking(params: ParamsOf<'set_layer_locking'>): Promise<ResultOf<'set_layer_locking'>> {
    return (await this.send('set_layer_locking', params)) as ResultOf<'set_layer_locking'>;
  }

  async duplicateLayers(params: ParamsOf<'duplicate_layers'>): Promise<ResultOf<'duplicate_layers'>> {
    return (await this.send('duplicate_layers', params)) as ResultOf<'duplicate_layers'>;
  }

  async applyImage(params: ParamsOf<'apply_image'>): Promise<ResultOf<'apply_image'>> {
    return (await this.send('apply_image', params)) as ResultOf<'apply_image'>;
  }

  async modifySelection(params: ParamsOf<'modify_selection'>): Promise<ResultOf<'modify_selection'>> {
    return (await this.send('modify_selection', params)) as ResultOf<'modify_selection'>;
  }

  async listFonts(params: ParamsOf<'list_fonts'>): Promise<ResultOf<'list_fonts'>> {
    return (await this.send('list_fonts', params)) as ResultOf<'list_fonts'>;
  }

  async setTextStyle(params: ParamsOf<'set_text_style'>): Promise<ResultOf<'set_text_style'>> {
    return (await this.send('set_text_style', params)) as ResultOf<'set_text_style'>;
  }

  async applyFilter(params: ParamsOf<'apply_filter'>): Promise<ResultOf<'apply_filter'>> {
    return (await this.send('apply_filter', params)) as ResultOf<'apply_filter'>;
  }

  async flipLayer(params: ParamsOf<'flip_layer'>): Promise<ResultOf<'flip_layer'>> {
    return (await this.send('flip_layer', params)) as ResultOf<'flip_layer'>;
  }

  async rotateLayer(params: ParamsOf<'rotate_layer'>): Promise<ResultOf<'rotate_layer'>> {
    return (await this.send('rotate_layer', params)) as ResultOf<'rotate_layer'>;
  }

  async rasterizeLayer(params: ParamsOf<'rasterize_layer'>): Promise<ResultOf<'rasterize_layer'>> {
    return (await this.send('rasterize_layer', params)) as ResultOf<'rasterize_layer'>;
  }

  async sampleColor(params: ParamsOf<'sample_color'>): Promise<ResultOf<'sample_color'>> {
    return (await this.send('sample_color', params)) as ResultOf<'sample_color'>;
  }

  async trimDocument(params: ParamsOf<'trim_document'>): Promise<ResultOf<'trim_document'>> {
    return (await this.send('trim_document', params)) as ResultOf<'trim_document'>;
  }

  async flattenDocument(params: ParamsOf<'flatten_document'>): Promise<ResultOf<'flatten_document'>> {
    return (await this.send('flatten_document', params)) as ResultOf<'flatten_document'>;
  }

  async mergeVisibleLayers(params: ParamsOf<'merge_visible_layers'>): Promise<ResultOf<'merge_visible_layers'>> {
    return (await this.send('merge_visible_layers', params)) as ResultOf<'merge_visible_layers'>;
  }

  async convertColorMode(params: ParamsOf<'convert_color_mode'>): Promise<ResultOf<'convert_color_mode'>> {
    return (await this.send('convert_color_mode', params)) as ResultOf<'convert_color_mode'>;
  }

  async createDocument(params: ParamsOf<'create_document'>): Promise<ResultOf<'create_document'>> {
    return (await this.send('create_document', params)) as ResultOf<'create_document'>;
  }

  async getDocuments(): Promise<ResultOf<'get_documents'>> {
    return (await this.send('get_documents', {})) as ResultOf<'get_documents'>;
  }

  async closeDocument(params: ParamsOf<'close_document'>): Promise<ResultOf<'close_document'>> {
    return (await this.send('close_document', params)) as ResultOf<'close_document'>;
  }

  async duplicateDocument(params: ParamsOf<'duplicate_document'>): Promise<ResultOf<'duplicate_document'>> {
    return (await this.send('duplicate_document', params)) as ResultOf<'duplicate_document'>;
  }

  async saveDocument(params: ParamsOf<'save_document'>): Promise<ResultOf<'save_document'>> {
    const path = params.path
      ? this.workspace.resolveOutput(params.path, 'document.psd')
      : undefined;
    if (path) Workspace.assertExtension(path, ['.psd'], 'save_document');
    return this.exportTo(
      'save_document',
      this.bridgeParams({ ...params, path }),
      path ?? this.workspace.resolveOutput(undefined, 'document.psd'),
      'psd',
      params.overwrite === true,
    );
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

  // --- brushes ---------------------------------------------------------------

  async listBrushes(params: ParamsOf<'list_brushes'>): Promise<ResultOf<'list_brushes'>> {
    return (await this.send('list_brushes', params)) as ResultOf<'list_brushes'>;
  }

  async strokePath(params: ParamsOf<'stroke_path'>): Promise<ResultOf<'stroke_path'>> {
    return (await this.send('stroke_path', params)) as ResultOf<'stroke_path'>;
  }

  async paintStroke(params: ParamsOf<'paint_stroke'>): Promise<ResultOf<'paint_stroke'>> {
    return (await this.send('paint_stroke', params)) as ResultOf<'paint_stroke'>;
  }

  /**
   * A whole layer's worth of strokes in one frame.
   *
   * The batching is on this side deliberately: the engine hands over a complete
   * layer, and how that travels — one frame, or many — is a transport decision
   * the painting logic must not know about.
   */
  async paintStrokes(params: ParamsOf<'paint_strokes'>): Promise<ResultOf<'paint_strokes'>> {
    return (await this.send('paint_strokes', params)) as ResultOf<'paint_strokes'>;
  }

  async paintGradient(params: ParamsOf<'paint_gradient'>): Promise<ResultOf<'paint_gradient'>> {
    return (await this.send('paint_gradient', params)) as ResultOf<'paint_gradient'>;
  }

  // --- images --------------------------------------------------------------

  async placeImage(params: ParamsOf<'place_image'>): Promise<ResultOf<'place_image'>> {
    const path = this.workspace.resolveInput(params.path, 'input.png', 'assets');
    Workspace.assertExtension(path, IMAGE_EXTENSIONS, 'place_image');
    // The bytes travel over the bridge, not just the path.
    //
    // The plugin runs inside a UXP sandbox that can only open a file the user
    // granted it in the panel, and `placeEvent` cannot open a staged sandbox
    // file at all on Photoshop 26.x — so the image is sent as data and opened
    // from the plugin's own storage. The path still travels (workspace-relative)
    // and still goes through the allow-list above, which is what makes the
    // request auditable and gives the plugin a name for the layer.
    return (await this.send('place_image', {
      ...this.bridgeParams({ ...params, path }),
      data: { fileName: basename(path), base64: (await readFile(path)).toString('base64') },
    })) as ResultOf<'place_image'>;
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
    return this.exportTo(
      'export_document',
      this.bridgeParams({ ...params, path }),
      path,
      ext === '.jpg' ? 'jpg' : ext === '.psd' ? 'psd' : 'png',
      params.overwrite === true,
    );
  }

  async exportPng(params: ParamsOf<'export_png'>): Promise<ResultOf<'export_png'>> {
    const path = this.workspace.resolveOutput(params.path, 'export.png');
    Workspace.assertExtension(path, ['.png'], 'export_png');
    return this.exportTo(
      'export_png',
      this.bridgeParams({ ...params, path }),
      path,
      'png',
      params.overwrite === true,
    );
  }

  async exportJpg(params: ParamsOf<'export_jpg'>): Promise<ResultOf<'export_jpg'>> {
    const path = this.workspace.resolveOutput(params.path, 'export.jpg');
    Workspace.assertExtension(path, ['.jpg', '.jpeg'], 'export_jpg');
    return this.exportTo(
      'export_jpg',
      this.bridgeParams({ ...params, path }),
      path,
      'jpg',
      params.overwrite === true,
    );
  }

  async savePsd(params: ParamsOf<'save_psd'>): Promise<ResultOf<'save_psd'>> {
    const path = this.workspace.resolveOutput(params.path, 'document.psd');
    Workspace.assertExtension(path, ['.psd'], 'save_psd');
    return this.exportTo(
      'save_psd',
      this.bridgeParams({ ...params, path }),
      path,
      'psd',
      params.overwrite === true,
    );
  }

  // --- preview -------------------------------------------------------------

  async renderPreview(params: ParamsOf<'render_preview'>): Promise<ResultOf<'render_preview'>> {
    return (await this.send('render_preview', params)) as ResultOf<'render_preview'>;
  }
}
