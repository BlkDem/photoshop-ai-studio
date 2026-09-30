import * as z from 'zod/v4';

/**
 * Normalised text-layer model.
 *
 * MVP scope: content, font, size, colour and position. Photoshop's full
 * typography model (leading, tracking, warp, anti-alias, paragraph styles) is
 * explicitly out of scope — see docs/architecture.md §"Non-goals".
 */

/** 8-bit sRGB triple, the representation Photoshop uses for text colour. */
export const RgbColorSchema = z.object({
  r: z.number().int().min(0).max(255),
  g: z.number().int().min(0).max(255),
  b: z.number().int().min(0).max(255),
});

export type RgbColor = z.infer<typeof RgbColorSchema>;

/** `#rrggbb` convenience form. Validated and normalised to `RgbColor`. */
export const HexColorSchema = z
  .string()
  .regex(/^#?([0-9a-fA-F]{6})$/, 'Expected a hex colour like #1A2B3C');

export function hexToRgb(hex: string): RgbColor {
  const clean = hex.replace(/^#/, '');
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

/**
 * Accepts either `{ r, g, b }` or `"#rrggbb"` and returns the canonical form.
 * Used by every tool that takes a colour so the AI can emit either shape.
 */
export const ColorInputSchema = z.union([RgbColorSchema, HexColorSchema]);

export type ColorInput = z.infer<typeof ColorInputSchema>;

export function normalizeColor(input: ColorInput): RgbColor {
  return typeof input === 'string' ? hexToRgb(input) : { r: input.r, g: input.g, b: input.b };
}

export const TextAlignSchema = z.enum(['left', 'center', 'right', 'justify']);
export type TextAlign = z.infer<typeof TextAlignSchema>;

export const TextLayerInfoSchema = z.object({
  layerId: z.number().int(),
  name: z.string(),
  text: z.string(),
  /** PostScript font name as Photoshop knows it, e.g. "MyriadPro-Regular". */
  font: z.string(),
  /** Points at the document resolution. */
  fontSize: z.number(),
  color: RgbColorSchema,
  alignment: TextAlignSchema.optional(),
  /** Paragraph-text width in document pixels. Omitted for point text. */
  width: z.number().optional(),
  /** Bounds height in document pixels; grows with wrapped content. */
  height: z.number().optional(),
  /** Point-text origin in document pixels. */
  x: z.number().optional(),
  y: z.number().optional(),
});

export type TextLayerInfo = z.infer<typeof TextLayerInfoSchema>;

/** Resample algorithms exposed for canvas/image resizing. */
export const ResampleMethodSchema = z.enum([
  'automatic',
  'nearestNeighbor',
  'bilinear',
  'bicubic',
  'bicubicSharper',
  'bicubicSmoother',
  'none',
]);

export type ResampleMethod = z.infer<typeof ResampleMethodSchema>;

/** 3x3 anchor grid for `resize_canvas` / `crop_document` / `resize_layer`. */
export const AnchorSchema = z.enum([
  'topLeft',
  'topCenter',
  'topRight',
  'middleLeft',
  'center',
  'middleRight',
  'bottomLeft',
  'bottomCenter',
  'bottomRight',
]);

export type Anchor = z.infer<typeof AnchorSchema>;

export const PREVIEW_DEFAULT_MAX_WIDTH = 480;
export const PREVIEW_MAX_WIDTH = 2048;
