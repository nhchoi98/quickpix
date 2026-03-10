export interface MetadataSegments {
  exif: Uint8Array | null;
  icc: Uint8Array[];
  iptc: Uint8Array | null;
}

export interface OrientationTransformResult {
  width: number;
  height: number;
  apply(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void;
}

/**
 * Extract EXIF, ICC, and IPTC segments from a JPEG ArrayBuffer.
 * Returns raw binary segments for preservation/re-injection.
 */
export function extractSegments(jpegBuffer: ArrayBuffer): MetadataSegments;

/**
 * Read EXIF Orientation tag (1–8) from JPEG binary data.
 * Returns 1 if not found or not JPEG.
 */
export function readOrientation(jpegBuffer: ArrayBuffer): number;

/**
 * Inject previously extracted metadata segments into a new JPEG Blob.
 * Inserts after SOI, skipping any existing APP1/APP2/APP13 in the target.
 */
export function injectSegments(jpegBlob: Blob, segments: MetadataSegments): Promise<Blob>;

/**
 * Compute the canvas 2D transform needed to correct an EXIF orientation value.
 * Orientations 5–8 swap width and height.
 */
export function orientationTransform(
  orientation: number,
  width: number,
  height: number,
): OrientationTransformResult;
