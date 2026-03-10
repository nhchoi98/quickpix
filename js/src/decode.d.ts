export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Check if `createImageBitmap` is available. */
export function hasCreateImageBitmap(): boolean;

/** Check if `OffscreenCanvas` is available. */
export function hasOffscreenCanvas(): boolean;

/** Check if running inside a Web Worker. */
export function isWorkerScope(): boolean;

/**
 * Decode a Blob into raw RGBA pixel data.
 * Auto-selects the best decoding path for the current environment.
 */
export function decodeBlob(blob: Blob): Promise<DecodedImage>;

/**
 * Decode a Blob with EXIF orientation correction applied.
 * If orientation is 1 or absent, behaves identically to `decodeBlob`.
 */
export function decodeBlobWithOrientation(blob: Blob, orientation: number): Promise<DecodedImage>;
