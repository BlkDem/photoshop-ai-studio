/**
 * A small PNG reader, enough for what this project produces.
 *
 * The critic measures rendered output, and the rendered output arrives as a PNG —
 * either from the mock preview or from Photoshop itself. Measuring it therefore
 * means decoding it, and there is no image library in the dependency tree.
 *
 * Deliberately narrow: 8-bit, non-interlaced, colour types 2 and 6, which is what
 * the mock encoder writes and what Photoshop writes for RGB. Anything else returns
 * `null` rather than guessing, because a critic that silently misreads a 16-bit or
 * palette PNG and then reports confident numbers is worse than one that declines.
 */

import { inflateSync } from 'node:zlib';

export interface RgbImage {
  width: number;
  height: number;
  /** Row-major, three bytes per pixel. */
  rgb: Uint8Array;
}

/** Decodes a PNG, or returns null if it is not a shape this reader understands. */
export function decodePng(data: Uint8Array): RgbImage | null {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 8 || !SIGNATURE.every((byte, i) => data[i] === byte)) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const parts: Uint8Array[] = [];

  while (at + 8 <= data.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(data[at + 4]!, data[at + 5]!, data[at + 6]!, data[at + 7]!);
    const body = data.subarray(at + 8, at + 8 + length);

    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      bitDepth = data[at + 16]!;
      colorType = data[at + 17]!;
      interlace = data[at + 20]!;
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
  if (width === 0 || height === 0) return null;

  const channels = colorType === 6 ? 4 : 3;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts.map((p) => Buffer.from(p))));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-row filters. This is the one piece of PNG that cannot be skipped,
  // and getting it wrong shifts every subsequent row by a pixel, which shows up as
  // a picture that is subtly wrong in a way nobody can see and everybody distrusts.
  const out = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const rawByte = line[x]!;
      const a = x >= channels ? row[x - channels]! : 0;
      const b = previous[x]!;
      const c = x >= channels ? previous[x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      row[x] = value & 0xff;
    }
    previous = row;
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
    const src = i * channels;
    rgb[j] = out[src]!;
    rgb[j + 1] = out[src + 1]!;
    rgb[j + 2] = out[src + 2]!;
  }

  return { width, height, rgb };
}