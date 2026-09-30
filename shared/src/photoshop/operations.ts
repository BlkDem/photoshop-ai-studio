import * as z from 'zod/v4';

import { DocumentInfoSchema, DocumentRefSchema, DocumentStateSchema, SaveResultSchema } from './document.js';
import {
  AnchorSchema,
  PREVIEW_DEFAULT_MAX_WIDTH,
  PREVIEW_MAX_WIDTH,
  ResampleMethodSchema,
  RgbColorSchema,
  TextAlignSchema,
  TextLayerInfoSchema,
} from './text.js';
import { BlendModeSchema, ElementPlacementSchema, LayerInfoSchema, LayerSelectorSchema } from './layer.js';

/**
 * The single registry that drives everything:
 *
 *  - the MCP tool list exposed to the AI (`tool` + `description` + `params`)
 *  - the operation envelope sent over the UXP bridge (`op` + `params`)
 *  - the `PhotoshopAdapter` method the MCP server calls
 *  - Studio's "which actions are destructive" indicators
 *
 * Adding a Photoshop capability therefore means adding exactly one entry here
 * plus one adapter method — there is no second place to keep in sync.
 */

export const TOOL_CATEGORIES = ['document', 'layer', 'text', 'image', 'canvas', 'export', 'preview'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const OPERATION_NAMES = [
  // document
  'get_document',
  'get_document_info',
  'get_capabilities',
  'create_document',
  'get_documents',
  'close_document',
  'duplicate_document',
  'save_document',
  // layers
  'get_layers',
  'get_layer',
  'set_layer_blend_mode',
  'set_layer_fill_opacity',
  'create_layer',
  'delete_layer',
  'rename_layer',
  'move_layer',
  'set_layer_visibility',
  'set_layer_opacity',
  'create_group',
  'move_layer_to_group',
  'reorder_layer',
  // text
  'create_text_layer',
  'set_text_style',
  'get_text_layer',
  'update_text_layer',
  'set_text_position',
  'set_text_font_size',
  'set_text_color',
  // images
  'place_image',
  'resize_layer',
  'apply_filter',
  // layers: transforms and finishing
  'flip_layer',
  'rotate_layer',
  'rasterize_layer',
  // canvas
  'set_selection',
  'resize_canvas',
  'crop_document',
  'trim_document',
  // document
  'sample_color',
  'flatten_document',
  'merge_visible_layers',
  'convert_color_mode',
  // export
  'export_document',
  'export_png',
  'export_jpg',
  'save_psd',
  // studio support
  'render_preview',
] as const;

export type PhotoshopOpName = (typeof OPERATION_NAMES)[number];

// ---------------------------------------------------------------------------
// shared parameter pieces
// ---------------------------------------------------------------------------

/** Identifies which open document an operation targets. */
export const DocumentTargetSchema = z.object({
  /** Omit or pass `"active"` to target the document the user is looking at. */
  documentId: z.string().min(1).default('active'),
});

export type DocumentTarget = z.infer<typeof DocumentTargetSchema>;

export const ExportFormatSchema = z.enum(['png', 'jpg', 'psd']);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const NoParamsSchema = z.object({});

/**
 * Every filesystem parameter is a path *inside the configured workspace*.
 * Absolute paths outside it are rejected by the MCP server before the request
 * ever reaches Photoshop — see docs/architecture.md §Security.
 */
export const OutputPathSchema = z
  .string()
  .min(1)
  .describe(
    'Destination path, absolute or relative to the configured workspace root. ' +
      'Paths outside the workspace are rejected.',
  );

/**
 * A short list of open documents.
 *
 * Distinct from `get_documents_info`, which walks layers: listing what is open
 * must stay cheap, because it is what a planner calls before deciding whether
 * it needs a document at all.
 */
export const DocumentListResultSchema = z.object({
  activeDocumentId: z.string().nullable(),
  documents: z.array(DocumentRefSchema),
});

export type DocumentListResult = z.infer<typeof DocumentListResultSchema>;

/**
 * What the connected Photoshop build can actually be asked to do.
 *
 * Presence is not proof: on Photoshop 26.11 `Layer.translate` exists and silently
 * does nothing, `Folder.getEntry().read` does not exist, and `placeEvent` refuses
 * every file the plugin can write. So the report separates three things —
 *
 *  - `api`    the entry point is there;
 *  - `usable` the plugin has exercised it successfully against this build;
 *  - `notes`  what is known about it, for the ones that are not usable.
 *
 * The Studio shows this so a plan can be refused with a reason instead of
 * failing halfway through.
 */
export const CapabilityEntrySchema = z.object({
  /** Whether the API surface exists on this host. */
  api: z.boolean(),
  /** Whether this plugin has actually performed it here and seen it take effect. */
  usable: z.boolean(),
  /** Why not, when `usable` is false and something is known. */
  note: z.string().optional(),
});

export const CapabilitiesResultSchema = z.object({
  hostApp: z.string(),
  hostVersion: z.string(),
  uxpVersion: z.string(),
  /** Areas the plugin is designed to cover, keyed by capability id. */
  capabilities: z.record(z.string(), CapabilityEntrySchema),
  /** Capability ids that are present but known not to work on this build. */
  unsupported: z.array(z.string()),
});

export type CapabilityEntry = z.infer<typeof CapabilityEntrySchema>;
export type CapabilitiesResult = z.infer<typeof CapabilitiesResultSchema>;

/** What `sample_color` found, in both forms a caller might want. */
export const SampleColorResultSchema = z.object({
  color: RgbColorSchema,
  hex: z.string(),
});
export type SampleColorResult = z.infer<typeof SampleColorResultSchema>;

/**
 * A file Photoshop wrote inside its own sandbox, awaiting publication.
 *
 * UXP plugins cannot write to a caller-chosen path: `localFileSystem: "request"`
 * only grants a folder the user picked, and that needs a gesture, which a
 * headless export cannot produce. The plugin therefore writes to
 * `plugin-data:/` and the MCP server — which owns the filesystem — moves the
 * file into the workspace.
 *
 * `nativePath` is the plugin's absolute path and is therefore **only** meaningful
 * to the process reading it; it is never shown to a model or written into a plan.
 */
export const StagedFileSchema = z.object({
  nativePath: z.string().describe('Absolute path inside the plugin sandbox.'),
  fileName: z.string().describe('Name the plugin staged the file under.'),
});

/** The bridge-level result of a file-producing operation, before publication. */
export const StagedExportResultSchema = z.object({
  path: z.string().describe('The path that was requested, for logging and diffing.'),
  format: ExportFormatSchema,
  overwritten: z.boolean(),
  staged: StagedFileSchema,
});

export const ExportResultSchema = z.object({
  path: z.string(),
  format: ExportFormatSchema,
  bytes: z.number().int().nonnegative().optional(),
  overwritten: z.boolean(),
});

export type ExportResult = z.infer<typeof ExportResultSchema>;
export type StagedFile = z.infer<typeof StagedFileSchema>;

export const PreviewResultSchema = z.object({
  mimeType: z.enum(['image/png']),
  base64: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type PreviewResult = z.infer<typeof PreviewResultSchema>;

/**
 * Colour input as written by a human or a model: either `{r,g,b}` or `"#rrggbb"`.
 *
 * Deliberately *not* a `z.transform()`: the MCP tool schemas are converted to
 * JSON Schema for the model, and effect-wrapped fields make that conversion
 * lossy. Normalisation happens explicitly in the tool dispatch instead, so the
 * value crossing the bridge is always a plain `RgbColor`.
 */
export const RgbInputSchema = z.union([
  RgbColorSchema,
  z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'Expected "#rrggbb" or {r,g,b}'),
]);

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

export interface OperationDefinition {
  /** MCP tool name. Dots are explicitly allowed by the MCP tools spec. */
  readonly tool: string;
  readonly title: string;
  /** Fed verbatim to the LLM planner. Be precise about constraints. */
  readonly description: string;
  readonly category: ToolCategory;
  /** Irreversible or lossy without an undo step. */
  readonly destructive: boolean;
  /** Requires an explicit user confirmation before execution. */
  readonly requiresConfirmation: boolean;
  readonly params: z.ZodType;
  readonly result: z.ZodType;
}

type OperationDefinitionMap = { readonly [K in PhotoshopOpName]: OperationDefinition };

/**
 * The filters a layer can take, with each one's own parameters.
 *
 * A discriminated union rather than one object with every field optional,
 * because "blur with a radius" and "unsharp mask with three numbers" are
 * different operations and a model should not have to remember which fields go
 * with which name. The plugin maps each to the matching `Layer.apply*` method.
 */
/** Each filter's own parameters; the union is built from these. */
export const FILTER_PARAM_SHAPES = [
  z.object({filter: z.literal('gaussianBlur'), radius: z.number().min(0.1).max(250).default(4)}),
  z.object({filter: z.literal('smartBlur'), radius: z.number().min(0.1).max(100).default(5), threshold: z.number().min(0.1).max(100).default(10), quality: z.enum(['low', 'medium', 'high']).default('medium')}),
  z.object({filter: z.literal('motionBlur'), angle: z.number().min(-180).max(180).default(0), distance: z.number().min(1).max(200).default(20)}),
  z.object({filter: z.literal('radialBlur'), amount: z.number().min(1).max(100).default(10), type: z.enum(['spin', 'zoom']).default('zoom')}),
  z.object({filter: z.literal('unsharpMask'), amount: z.number().min(1).max(500).default(100), radius: z.number().min(0.1).max(50).default(1), threshold: z.number().int().min(0).max(255).default(0)}),
  z.object({filter: z.literal('sharpen')}),
  z.object({filter: z.literal('sharpenMore')}),
  z.object({filter: z.literal('sharpenEdges')}),
  z.object({filter: z.literal('addNoise'), amount: z.number().min(1).max(100).default(10), distribution: z.enum(['uniform', 'gaussian']).default('gaussian'), monochromatic: z.boolean().default(true)}),
  z.object({filter: z.literal('medianNoise'), radius: z.number().int().min(1).max(100).default(4)}),
  z.object({filter: z.literal('dustAndScratches'), radius: z.number().int().min(1).max(100).default(2), threshold: z.number().int().min(0).max(255).default(10)}),
  z.object({filter: z.literal('despeckle')}),
  z.object({filter: z.literal('speckle'), radius: z.number().int().min(1).max(100).default(50), amount: z.number().int().min(1).max(100).default(4)}),
  z.object({filter: z.literal('highPass'), radius: z.number().min(0.1).max(250).default(2)}),
  z.object({filter: z.literal('offset'), horizontal: z.number().int().min(-1000).max(1000).default(0), vertical: z.number().int().min(-1000).max(1000).default(0)}),
  z.object({filter: z.literal('twirl'), angle: z.number().min(-999).max(999).default(90)}),
  z.object({filter: z.literal('spherize'), amount: z.number().min(-100).max(100).default(50)}),
  z.object({filter: z.literal('ripple'), amount: z.number().int().min(-100).max(100).default(50)}),
  z.object({filter: z.literal('pinch'), amount: z.number().min(-100).max(100).default(50)}),
  z.object({filter: z.literal('zigZag'), amount: z.number().int().min(1).max(100).default(25), style: z.enum(['aroundCenter', 'outFromCenter']).default('aroundCenter')}),
  z.object({filter: z.literal('wave'), amplitude: z.number().int().min(1).max(100).default(25), wavelength: z.number().int().min(4).max(350).default(70)}),
  z.object({filter: z.literal('shear'), degrees: z.number().min(-90).max(90).default(0)}),
  z.object({filter: z.literal('diffuseGlow'), amount: z.number().min(1).max(100).default(10), threshold: z.number().int().min(0).max(255).default(0)}),
  z.object({filter: z.literal('maximum'), radius: z.number().int().min(1).max(100).default(1)}),
  z.object({filter: z.literal('minimum'), radius: z.number().int().min(1).max(100).default(1)}),
] as const;

export const FilterParamsSchema = z.discriminatedUnion('filter', FILTER_PARAM_SHAPES);
export type FilterParams = z.infer<typeof FilterParamsSchema>;

/** The filters this build is known to apply, for the capability report. */
export const FILTER_NAMES = [
  'gaussianBlur', 'smartBlur', 'motionBlur', 'radialBlur', 'unsharpMask', 'sharpen', 'sharpenMore',
  'sharpenEdges', 'addNoise', 'medianNoise', 'dustAndScratches', 'despeckle', 'speckle', 'highPass',
  'offset', 'twirl', 'spherize', 'ripple', 'pinch', 'zigZag', 'wave', 'shear', 'diffuseGlow',
  'maximum', 'minimum',
] as const;

/**
 * Character and paragraph settings a text layer carries.
 *
 * Grouped into one tool rather than six because they are always edited together
 * ("make it a condensed italic") and each is a single property on the same
 * object. Every field is optional; an absent one is left alone.
 */
export const TextStylePatchSchema = z.object({
  /** Letter spacing, in 1/1000 em — Photoshop's own unit, not points. */
  tracking: z.number().int().min(-5000).max(5000).optional(),
  /** Line spacing as a percentage of the font size. */
  leading: z.number().int().min(0).max(5000).optional(),
  fauxBold: z.boolean().optional(),
  fauxItalic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  /** Vertical offset, in the same 1/1000 em unit as tracking. */
  baselineShift: z.number().int().min(-1000).max(1000).optional(),
  /** Horizontal scale, percent. */
  horizontalScale: z.number().int().min(10).max(1000).optional(),
  verticalScale: z.number().int().min(10).max(1000).optional(),
  /** Convert the layer to point text and set the wrap width, in pixels. */
  paragraphWidth: z.number().int().positive().max(20000).optional(),
});
export type TextStylePatch = z.infer<typeof TextStylePatchSchema>;

export const OPERATIONS = {
  // -------------------------------------------------------------- document
  get_document: {
    tool: 'photoshop.get_document',
    title: 'Get Document',
    description:
      'Return the complete current state of a document: metadata (id, name, width, height, ' +
      'resolution, colorMode, layerCount) AND the full flat layer list including nested group ' +
      'children with parentId. Call this FIRST whenever you need to know what actually exists ' +
      'before planning anything.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: NoParamsSchema,
    result: DocumentStateSchema,
  },
  create_document: {
    tool: 'photoshop.create_document',
    title: 'Create Document',
    description:
      'Create a new empty document and make it active. Use this when the request is to start ' +
      'something rather than change what is open — otherwise work on the document the user ' +
      'already has, because opening a new one hides their work.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: z.object({
      name: z.string().min(1).max(255).optional().describe('Document name, without the extension.'),
      width: z.number().int().positive().max(30000).default(1920),
      height: z.number().int().positive().max(30000).default(1080),
      resolution: z.number().int().positive().max(1200).optional().default(72),
      colorMode: z.enum(['RGB', 'CMYK', 'GRAYSCALE', 'LAB', 'BITMAP']).default('RGB'),
      /** Photoshop's own three choices; `transparent` is an empty layer. */
      background: z.enum(['white', 'background', 'transparent']).default('white'),
    }),
    result: DocumentInfoSchema,
  },
  get_documents: {
    tool: 'photoshop.get_documents',
    title: 'Get Documents',
    description:
      'List the open documents and which one is active. Cheap: it reads no layer data, so it is ' +
      'the right first call when deciding what to work on.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: NoParamsSchema,
    result: DocumentListResultSchema,
  },
  close_document: {
    tool: 'photoshop.close_document',
    title: 'Close Document',
    description:
      'Close a document. With `save: false` (the default) unsaved changes are discarded, which ' +
      'is destructive; with `save: true` the document is saved to its current path first.',
    category: 'document',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      save: z.boolean().default(false).describe('Save to the existing path before closing.'),
    }),
    result: DocumentRefSchema,
  },
  get_capabilities: {
    tool: 'photoshop.get_capabilities',
    title: 'Get Capabilities',
    description:
      'Report which Photoshop features this build actually supports. Non-destructive: it ' +
      'inspects the API surface and the plugin\'s own record of what it has verified, and ' +
      'never touches the document. Call it before planning work that depends on masks, ' +
      'adjustments, selections or smart objects, so an unsupported feature can be refused ' +
      'up front rather than failing halfway through.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: NoParamsSchema,
    result: CapabilitiesResultSchema,
  },
  get_document_info: {
    tool: 'photoshop.get_document_info',
    title: 'Get Document Info',
    description:
      'Return only document metadata (id, name, width, height, resolution, colorMode, layerCount). ' +
      'Cheaper than get_document because it skips the layer walk. Use when you only need canvas ' +
      'geometry.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: NoParamsSchema,
    result: DocumentInfoSchema,
  },
  duplicate_document: {
    tool: 'photoshop.duplicate_document',
    title: 'Duplicate Document',
    description:
      'Duplicate the target document. The copy becomes the active document and all following ' +
      'operations apply to it. Use this to safely derive a variant (for example a square version) ' +
      'without touching the original.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      name: z.string().min(1).optional().describe('Name for the duplicate, e.g. "banner-square".'),
    }),
    result: DocumentRefSchema,
  },
  save_document: {
    tool: 'photoshop.save_document',
    title: 'Save Document',
    description:
      'Save the document as PSD. Without `path` it saves in place, which OVERWRITES the original ' +
      'file — prefer `path` for anything AI-generated.',
    category: 'document',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      path: OutputPathSchema.optional(),
      overwrite: z.boolean().default(false).describe('Allow overwriting an existing file.'),
      asCopy: z.boolean().default(true).describe('true keeps the working document unsaved.'),
    }),
    result: SaveResultSchema,
  },

  // ---------------------------------------------------------------- layers
  get_layers: {
    tool: 'photoshop.get_layers',
    title: 'Get Layers',
    description:
      'Return every layer of the document as a flat list ordered bottom-to-top, with parentId for ' +
      'nesting, plus id, name, type, visible, opacity and pixel bounds.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      includeHidden: z.boolean().default(true),
    }),
    result: z.array(LayerInfoSchema),
  },
  get_layer: {
    tool: 'photoshop.get_layer',
    title: 'Get Layer',
    description: 'Return one layer by id (preferred) or exact name.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema,
    result: LayerInfoSchema,
  },
  create_layer: {
    tool: 'photoshop.create_layer',
    title: 'Create Layer',
    description:
      'Create an empty layer above the current selection. Optionally size and position it. ' +
      'Give it a descriptive name so later steps can address it by name.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      name: z.string().min(1).describe('Name for the new layer.'),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      opacity: z.number().min(0).max(100).default(100),
      visible: z.boolean().default(true),
    }),
    result: LayerInfoSchema,
  },
  delete_layer: {
    tool: 'photoshop.delete_layer',
    title: 'Delete Layer',
    description:
      'DESTRUCTIVE. Delete a layer from the document. Requires explicit user confirmation. ' +
      'Never use it to "clean up" unless the user asked for it.',
    category: 'layer',
    destructive: true,
    requiresConfirmation: true,
    params: LayerSelectorSchema,
    result: z.object({ deletedLayerId: z.number().int() }),
  },
  rename_layer: {
    tool: 'photoshop.rename_layer',
    title: 'Rename Layer',
    description: 'Rename an existing layer. Returns the updated layer.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      name: z.string().min(1).describe('The new layer name.'),
    }),
    result: LayerInfoSchema,
  },
  move_layer: {
    tool: 'photoshop.move_layer',
    title: 'Move Layer',
    description:
      'Move a layer in document pixel space. Provide x/y for the new top-left corner, or neither ' +
      'to move by a relative delta via dx/dy. Coordinates are absolute pixels from the canvas ' +
      'top-left, origin y grows downward.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      x: z.number().optional().describe('Absolute left edge in document pixels.'),
      y: z.number().optional().describe('Absolute top edge in document pixels.'),
      dx: z.number().optional().describe('Relative horizontal offset, use instead of x.'),
      dy: z.number().optional().describe('Relative vertical offset, use instead of y.'),
    }),
    result: LayerInfoSchema,
  },
  set_layer_visibility: {
    tool: 'photoshop.set_layer_visibility',
    title: 'Set Layer Visibility',
    description:
      'Show or hide a layer. `visible: false` hides it without deleting anything, ' +
      'which makes it the safe way to test a layout.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      visible: z.boolean(),
    }),
    result: LayerInfoSchema,
  },
  set_layer_blend_mode: {
    tool: 'photoshop.set_layer_blend_mode',
    title: 'Set Layer Blend Mode',
    description:
      "Set how a layer combines with what is beneath it. The names are the DOM's, not the " +
      "Photoshop UI's: `colorDodge` is Colour Dodge, `softLight` is Soft Light.",
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({ mode: BlendModeSchema }),
    result: LayerInfoSchema,
  },
  set_layer_fill_opacity: {
    tool: 'photoshop.set_layer_fill_opacity',
    title: 'Set Layer Fill Opacity',
    description:
      'Set fill opacity (0-100), which fades the layer content without touching a mask or ' +
      'an opacity that would also fade any layer effects. Distinct from `set_layer_opacity`.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      opacity: z.number().int().min(0).max(100),
    }),
    result: LayerInfoSchema,
  },
  set_layer_opacity: {
    tool: 'photoshop.set_layer_opacity',
    title: 'Set Layer Opacity',
    description: 'Set layer opacity as a percentage from 0 (fully transparent) to 100 (opaque).',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      opacity: z.number().min(0).max(100),
    }),
    result: LayerInfoSchema,
  },
  create_group: {
    tool: 'photoshop.create_group',
    title: 'Create Group',
    description:
      'Create a layer group, optionally placing existing layers inside it. Without `layer` the ' +
      'group is created empty at the top of the stacking order.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      name: z.string().min(1),
      layer: LayerSelectorSchema.optional().describe('Existing layer to move into the new group.'),
    }),
    result: LayerInfoSchema,
  },
  move_layer_to_group: {
    tool: 'photoshop.move_layer_to_group',
    title: 'Move Layer To Group',
    description: 'Move a layer into an existing group, preserving relative stacking order.',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: z.object({
      layer: LayerSelectorSchema,
      group: LayerSelectorSchema.describe('Target group. Must be of type "group".'),
    }),
    result: LayerInfoSchema,
  },
  reorder_layer: {
    tool: 'photoshop.reorder_layer',
    title: 'Reorder Layer',
    description:
      'Change the stacking order of a layer. `placement` is one of placeAtEnd (top), ' +
      'placeAtBeginning (bottom), placeBefore, placeAfter (relative to `target`).',
    category: 'layer',
    destructive: false,
    requiresConfirmation: false,
    params: z.object({
      layer: LayerSelectorSchema,
      placement: ElementPlacementSchema.exclude(['placeInside']),
      target: LayerSelectorSchema.optional().describe('Required for placeBefore / placeAfter.'),
    }),
    result: LayerInfoSchema,
  },

  // ------------------------------------------------------------------ text
  create_text_layer: {
    tool: 'photoshop.create_text_layer',
    title: 'Create Text Layer',
    description:
      'Create a new text layer. `font` is a PostScript name (e.g. "MyriadPro-Bold"); omit it to ' +
      'inherit the last used font. `x`/`y` place the bottom-left of the text box. `width` makes it ' +
      'paragraph text that wraps at that width instead of a single line.',
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      text: z.string().min(1),
      name: z.string().min(1).optional().describe('Layer name; defaults to the first line of text.'),
      font: z.string().min(1).optional(),
      fontSize: z.number().positive().max(1296).default(24),
      color: RgbInputSchema.default({ r: 0, g: 0, b: 0 }),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().int().positive().optional(),
      alignment: TextAlignSchema.optional(),
    }),
    result: TextLayerInfoSchema,
  },
  get_text_layer: {
    tool: 'photoshop.get_text_layer',
    title: 'Get Text Layer',
    description: 'Return content, font, size, colour and geometry of a text layer.',
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema,
    result: TextLayerInfoSchema,
  },
  update_text_layer: {
    tool: 'photoshop.update_text_layer',
    title: 'Update Text Layer',
    description:
      'Change the content and/or typographic properties of a text layer. Only the fields you ' +
      'provide are modified. Note that Photoshop auto-resizes point-text layers to fit the new ' +
      'string.',
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      text: z.string().optional(),
      font: z.string().min(1).optional(),
      fontSize: z.number().positive().max(1296).optional(),
      color: RgbInputSchema.optional(),
      alignment: TextAlignSchema.optional(),
    }),
    result: TextLayerInfoSchema,
  },
  set_text_style: {
    tool: 'photoshop.set_text_style',
    title: 'Set Text Style',
    description:
      'Set character and paragraph properties on a text layer: tracking, leading, faux bold and ' +
      'italic, underline, strikethrough, baseline shift, scale, and the paragraph wrap width. ' +
      'Only the fields you pass are changed. Prefer this over several one-property tools — a ' +
      "caption is usually 'condensed and italic', not two separate intents.",
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend(TextStylePatchSchema.shape),
    result: TextLayerInfoSchema,
  },
  set_text_position: {
    tool: 'photoshop.set_text_position',
    title: 'Set Text Position',
    description: 'Move a text layer so its text-box origin sits at (x, y) in document pixels.',
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      x: z.number(),
      y: z.number(),
    }),
    result: TextLayerInfoSchema,
  },
  set_text_font_size: {
    tool: 'photoshop.set_text_font_size',
    title: 'Set Text Font Size',
    description: 'Set the point size of a text layer (1..1296 at 72 ppi).',
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      fontSize: z.number().positive().max(1296),
    }),
    result: TextLayerInfoSchema,
  },
  set_text_color: {
    tool: 'photoshop.set_text_color',
    title: 'Set Text Color',
    description: 'Set the fill colour of a text layer. Accepts {"r":..,"g":..,"b":..} or "#rrggbb".',
    category: 'text',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      color: RgbInputSchema,
    }),
    result: TextLayerInfoSchema,
  },

  // ---------------------------------------------------------------- images
  place_image: {
    tool: 'photoshop.place_image',
    title: 'Place Image',
    description:
      'Place an external image file as a new layer. `path` must live inside the configured ' +
      'workspace. `fit` scales the placed layer; omit it to keep the native pixel size.',
    category: 'image',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      path: z.string().min(1).describe('Image file path inside the workspace, e.g. assets/logo.png'),
      name: z.string().min(1).optional(),
      fit: z
        .object({
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          anchor: AnchorSchema.default('center'),
        })
        .optional(),
    }),
    result: LayerInfoSchema,
  },
  resize_layer: {
    tool: 'photoshop.resize_layer',
    title: 'Resize Layer',
    description:
      'Scale a layer to an absolute width/height, or by a ratio when `scale` is given. ' +
      'Smart objects resize without quality loss; raster layers are resampled with `resample`.',
    category: 'image',
    destructive: false,
    requiresConfirmation: false,
    params: LayerSelectorSchema.extend({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      scale: z.number().positive().max(20).optional().describe('Uniform scale factor, e.g. 0.5.'),
      anchor: AnchorSchema.default('center'),
      resample: ResampleMethodSchema.default('bicubic'),
    }),
    result: LayerInfoSchema,
  },

  // ---------------------------------------------------------------- canvas
  apply_filter: {
    tool: 'photoshop.apply_filter',
    title: 'Apply Filter',
    description:
      'Apply a filter to a layer, destructively. Twenty-five filters, all on the DOM and all ' +
      'exercised against a real Photoshop. Two consequences worth knowing: a filter applied to ' +
      'a text or shape layer rasterizes it, so later text edits are no longer possible on ' +
      'that layer; and nothing here is undoable, because the plugin has no history tool. ' +
      'Work on a duplicate if the layer matters.',
    category: 'image',
    destructive: true,
    requiresConfirmation: true,
    // `.merge` rather than `.extend`: the array holds whole ZodObjects, one per
    // filter variant, and only merge composes two schemas.
    params: z.union(
      FILTER_PARAM_SHAPES.map((variant) => LayerSelectorSchema.merge(variant).extend({ documentId: z.string().min(1).default('active') })),
    ),
    result: LayerInfoSchema,
  },
  flip_layer: {
    tool: 'photoshop.flip_layer',
    title: 'Flip Layer',
    description: 'Mirror a layer horizontally or vertically. Destructive; no undo.',
    category: 'layer',
    destructive: true,
    requiresConfirmation: true,
    params: LayerSelectorSchema.extend({
      direction: z.enum(['horizontal', 'vertical']).default('horizontal'),
    }),
    result: LayerInfoSchema,
  },
  rotate_layer: {
    tool: 'photoshop.rotate_layer',
    title: 'Rotate Layer',
    description:
      "Rotate a layer's content about its centre, in degrees clockwise. `interpolation` maps to " +
      'Photoshop\'s own setting: `nearestNeighbor` keeps hard edges, `bilinear` is the default, ' +
      '`bicubic` is smoothest. Destructive; no undo.',
    category: 'layer',
    destructive: true,
    requiresConfirmation: true,
    params: LayerSelectorSchema.extend({
      angle: z.number().min(-360).max(360).default(90),
      interpolation: z.enum(['nearestNeighbor', 'bilinear', 'bicubic']).default('bilinear'),
    }),
    result: LayerInfoSchema,
  },
  rasterize_layer: {
    tool: 'photoshop.rasterize_layer',
    title: 'Rasterize Layer',
    description:
      'Flatten a layer\'s live effects into its pixels. Irreversible, and the reason it is ' +
      'gated: after rasterizing there is no way to lower the opacity of an effect ' +
      'independently. Only useful as a deliberate final step.',
    category: 'layer',
    destructive: true,
    requiresConfirmation: true,
    params: LayerSelectorSchema,
    result: LayerInfoSchema,
  },
  trim_document: {
    tool: 'photoshop.trim_document',
    title: 'Trim Document',
    description:
      'Crop the canvas to the content, discarding the transparent margin. `type` mirrors ' +
      "Photoshop's own: transparent pixels, or the colour in the corner.",
    category: 'canvas',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      type: z.enum(['transparent', 'topLeftColor', 'bottomRightColor']).default('transparent'),
    }),
    result: DocumentInfoSchema,
  },
  sample_color: {
    tool: 'photoshop.sample_color',
    title: 'Sample Colour',
    description:
      'Read the colour at a point in the document. The way to pick up a brand colour from an ' +
      'existing asset without guessing it. `radius` averages over a square, which is what you ' +
      'want for a gradient or a photo.',
    category: 'document',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      radius: z.number().int().min(0).max(100).default(0),
    }),
    result: z.object({
      color: RgbColorSchema,
      hex: z.string(),
    }),
  },
  flatten_document: {
    tool: 'photoshop.flatten_document',
    title: 'Flatten Document',
    description:
      'Merge every visible layer into one, discarding hidden layers. Irreversible, and the ' +
      'single most destructive thing in this tool surface.',
    category: 'document',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema,
    result: DocumentInfoSchema,
  },
  merge_visible_layers: {
    tool: 'photoshop.merge_visible_layers',
    title: 'Merge Visible Layers',
    description: 'Merge the visible layers into one, keeping hidden layers. Irreversible.',
    category: 'document',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema,
    result: DocumentInfoSchema,
  },
  convert_color_mode: {
    tool: 'photoshop.convert_color_mode',
    title: 'Convert Colour Mode',
    description:
      "Convert the document between RGB, CMYK, Gray and Lab. Irreversible from the user's " +
      'point of view once saved, and it changes every colour in the document — a conversion ' +
      'to CMYK will visibly shift a web palette.',
    category: 'document',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      mode: z.enum(['RGB', 'CMYK', 'GRAYSCALE', 'LAB', 'BITMAP']),
    }),
    result: DocumentInfoSchema,
  },
  set_selection: {
    tool: 'photoshop.set_selection',
    title: 'Set Selection',
    description:
      'Change the active selection. `mode` is `all`, `rectangle`, `ellipse`, `none` or ' +
      '`invert`; a rectangle/ellipse takes x, y, width, height in document pixels and may be ' +
      'feathered. `invert` flips the current selection. Note that this is the marching-ants ' +
      'selection, which the plugin uses to scope the adjustment operations — it is not applied ' +
      'to anything by itself.',
    category: 'canvas',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      mode: z.enum(['all', 'rectangle', 'ellipse', 'none', 'invert']),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      feather: z.number().min(0).max(1000).optional().describe('Feather radius in pixels.'),
    }),
    result: DocumentStateSchema,
  },
  resize_canvas: {
    tool: 'photoshop.resize_canvas',
    title: 'Resize Canvas',
    description:
      'Change the canvas size WITHOUT scaling pixel content — existing artwork keeps its size and ' +
      'position, so surrounding design usually needs follow-up move_layer steps. anchor decides ' +
      'which edge stays fixed.',
    category: 'canvas',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      anchor: AnchorSchema.default('center'),
    }),
    result: DocumentInfoSchema,
  },
  crop_document: {
    tool: 'photoshop.crop_document',
    title: 'Crop Document',
    description:
      'Crop the canvas to the rectangle (x, y, width, height) in document pixels. Pixels outside ' +
      'the rectangle are discarded — prefer resize_canvas when you want to keep content.',
    category: 'canvas',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      x: z.number(),
      y: z.number(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    result: DocumentInfoSchema,
  },

  // ---------------------------------------------------------------- export
  export_document: {
    tool: 'photoshop.export_document',
    title: 'Export Document',
    description:
      'Export the document in a chosen format. `path` defaults to <workspace>/out/<docname>.<ext>. ' +
      'Overwriting an existing file requires `overwrite: true` plus user confirmation.',
    category: 'export',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      format: ExportFormatSchema,
      path: OutputPathSchema.optional(),
      overwrite: z.boolean().default(false),
      quality: z.number().int().min(1).max(12).optional().describe('JPEG quality 1..12.'),
      compression: z.number().int().min(0).max(9).optional().describe('PNG compression 0..9.'),
    }),
    result: ExportResultSchema,
  },
  export_png: {
    tool: 'photoshop.export_png',
    title: 'Export PNG',
    description: 'Export the document to PNG (lossless, keeps alpha).',
    category: 'export',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      path: OutputPathSchema.optional(),
      overwrite: z.boolean().default(false),
      compression: z.number().int().min(0).max(9).default(6),
      maxWidth: z.number().int().positive().max(8192).optional().describe('Downscale before saving.'),
    }),
    result: ExportResultSchema,
  },
  export_jpg: {
    tool: 'photoshop.export_jpg',
    title: 'Export JPG',
    description: 'Export the document to JPEG. Has no alpha channel. `quality` is 1..12.',
    category: 'export',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      path: OutputPathSchema.optional(),
      overwrite: z.boolean().default(false),
      quality: z.number().int().min(1).max(12).default(9),
      maxWidth: z.number().int().positive().max(8192).optional(),
    }),
    result: ExportResultSchema,
  },
  save_psd: {
    tool: 'photoshop.save_psd',
    title: 'Save PSD',
    description:
      'Save the document as a .psd file, preserving layers. With `asCopy: true` (default) the ' +
      'in-memory document keeps its current path.',
    category: 'export',
    destructive: true,
    requiresConfirmation: true,
    params: DocumentTargetSchema.extend({
      path: OutputPathSchema.optional(),
      overwrite: z.boolean().default(false),
      asCopy: z.boolean().default(true),
    }),
    result: ExportResultSchema,
  },

  // --------------------------------------------------------------- preview
  render_preview: {
    tool: 'photoshop.render_preview',
    title: 'Render Preview',
    description:
      'Render a downscaled PNG preview of the current document and return it base64-encoded. ' +
      'Used by the Studio preview pane; not normally needed by a plan.',
    category: 'preview',
    destructive: false,
    requiresConfirmation: false,
    params: DocumentTargetSchema.extend({
      maxWidth: z.number().int().positive().max(PREVIEW_MAX_WIDTH).default(PREVIEW_DEFAULT_MAX_WIDTH),
    }),
    result: PreviewResultSchema,
  },
} satisfies OperationDefinitionMap;

// ---------------------------------------------------------------------------
// derived types
// ---------------------------------------------------------------------------

export type ParamsOf<K extends PhotoshopOpName> = z.output<(typeof OPERATIONS)[K]['params']>;
export type InputOf<K extends PhotoshopOpName> = z.input<(typeof OPERATIONS)[K]['params']>;
export type ResultOf<K extends PhotoshopOpName> = z.output<(typeof OPERATIONS)[K]['result']>;

export const OP_NAMES = Object.keys(OPERATIONS) as PhotoshopOpName[];

const TOOL_TO_OP = new Map<string, PhotoshopOpName>(
  OP_NAMES.map((op) => [OPERATIONS[op].tool, op]),
);

export function opForTool(tool: string): PhotoshopOpName | null {
  return TOOL_TO_OP.get(tool) ?? null;
}

export function toolForOp(op: PhotoshopOpName): string {
  return OPERATIONS[op].tool;
}

export interface ToolMeta {
  tool: string;
  op: PhotoshopOpName;
  title: string;
  description: string;
  category: ToolCategory;
  destructive: boolean;
  requiresConfirmation: boolean;
}

export const ToolMetaSchema = z.object({
  tool: z.string(),
  op: z.enum(OPERATION_NAMES),
  title: z.string(),
  description: z.string(),
  category: z.enum(TOOL_CATEGORIES),
  destructive: z.boolean(),
  requiresConfirmation: z.boolean(),
});

/** Tool metadata for the Studio UI and for prompt construction. */
export const TOOL_META: readonly ToolMeta[] = OP_NAMES.map((op) => ({
  tool: OPERATIONS[op].tool,
  op,
  title: OPERATIONS[op].title,
  description: OPERATIONS[op].description,
  category: OPERATIONS[op].category,
  destructive: OPERATIONS[op].destructive,
  requiresConfirmation: OPERATIONS[op].requiresConfirmation,
}));

export const TOOL_META_MAP: Readonly<Record<string, ToolMeta>> = Object.freeze(
  Object.fromEntries(TOOL_META.map((t) => [t.tool, t])),
);

export const TOOL_NAME_LIST: readonly string[] = TOOL_META.map((t) => t.tool);

export const DESTRUCTIVE_TOOLS: readonly string[] = TOOL_META.filter((t) => t.destructive).map((t) => t.tool);

/** Compact tool list injected into planner prompts. */
export function describeToolsForPrompt(categories?: readonly ToolCategory[]): string {
  return TOOL_META.filter((t) => !categories || categories.includes(t.category))
    .map((t) => {
      const flags = [t.destructive ? 'DESTRUCTIVE' : null, t.requiresConfirmation ? 'needs-confirmation' : null]
        .filter(Boolean)
        .join(',');
      return `- ${t.tool}${flags ? ` [${flags}]` : ''}: ${t.title} — ${t.description.split('.')[0]}.`;
    })
    .join('\n');
}

export { AnchorSchema, ElementPlacementSchema, LayerSelectorSchema, ResampleMethodSchema, TextAlignSchema };
