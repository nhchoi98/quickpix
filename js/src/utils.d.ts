import type { FitMode } from "./index.js";

export interface TargetSizeOptions {
  width?: number;
  height?: number;
  maxDimension?: number;
  fit?: FitMode;
}

export interface TargetSize {
  width: number;
  height: number;
}

export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Compute target dimensions preserving aspect ratio.
 *
 * - `maxDimension`: fits both sides within the limit
 * - `width` + `height` with `fit`:
 *   - `contain` (default): scale to fit inside target box
 *   - `cover`: scale to fill target box (may exceed one side)
 *   - `fill`: stretch to exact size (ignores aspect ratio)
 */
export function computeTargetSize(srcW: number, srcH: number, opts?: TargetSizeOptions): TargetSize;

/**
 * Normalize various input types into a Blob.
 * Supports: Blob, File, HTMLCanvasElement, OffscreenCanvas, HTMLImageElement, ImageData.
 */
export function normalizeSource(
  source: Blob | File | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement | ImageData,
): Promise<Blob>;

/**
 * Get image dimensions from a Blob without full pixel decode.
 * Uses `createImageBitmap` for lightweight dimension extraction.
 */
export function getImageSize(blob: Blob): Promise<TargetSize>;
