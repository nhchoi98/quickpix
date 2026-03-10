import type { ImageMimeType } from "./index.js";

/**
 * Encode raw RGBA pixel data into an image Blob.
 * Uses OffscreenCanvas when available, falls back to HTMLCanvasElement.
 */
export function encodeToBlob(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  mimeType?: ImageMimeType,
  quality?: number,
): Promise<Blob>;
