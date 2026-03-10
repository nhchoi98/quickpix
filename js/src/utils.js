/**
 * Common utilities for QuickPixEasy.
 */

/**
 * @typedef {'contain' | 'cover' | 'fill'} FitMode
 *
 * contain: scale to fit within target, preserve aspect ratio (may be smaller)
 * cover:   scale to cover target, preserve aspect ratio (may crop)
 * fill:    stretch to exact target size (ignores aspect ratio)
 */

/**
 * Compute target dimensions preserving aspect ratio.
 *
 * @param {number} srcW - Source width
 * @param {number} srcH - Source height
 * @param {object} opts
 * @param {number} [opts.width]         - Target width (used with height for fit)
 * @param {number} [opts.height]        - Target height (used with width for fit)
 * @param {number} [opts.maxDimension]  - Max dimension for either side (overrides width/height)
 * @param {FitMode} [opts.fit='contain']
 * @returns {{ width: number, height: number }}
 */
export function computeTargetSize(srcW, srcH, opts = {}) {
  if (srcW <= 0 || srcH <= 0) {
    throw new RangeError("Invalid source dimensions");
  }

  const fit = opts.fit || "contain";

  // maxDimension mode: fit both sides within the limit
  if (opts.maxDimension && opts.maxDimension > 0) {
    const max = opts.maxDimension;
    if (srcW <= max && srcH <= max) {
      return { width: srcW, height: srcH };
    }
    const scale = Math.min(max / srcW, max / srcH);
    return {
      width: Math.max(1, Math.round(srcW * scale)),
      height: Math.max(1, Math.round(srcH * scale)),
    };
  }

  const targetW = opts.width || 0;
  const targetH = opts.height || 0;

  if (targetW <= 0 && targetH <= 0) {
    return { width: srcW, height: srcH };
  }

  if (fit === "fill") {
    return {
      width: targetW || srcW,
      height: targetH || srcH,
    };
  }

  // Only one dimension specified: compute the other from aspect ratio
  if (targetW > 0 && targetH <= 0) {
    const scale = targetW / srcW;
    return { width: targetW, height: Math.max(1, Math.round(srcH * scale)) };
  }

  if (targetH > 0 && targetW <= 0) {
    const scale = targetH / srcH;
    return { width: Math.max(1, Math.round(srcW * scale)), height: targetH };
  }

  // Both dimensions specified
  const scaleX = targetW / srcW;
  const scaleY = targetH / srcH;

  if (fit === "cover") {
    const scale = Math.max(scaleX, scaleY);
    return {
      width: Math.max(1, Math.round(srcW * scale)),
      height: Math.max(1, Math.round(srcH * scale)),
    };
  }

  // contain (default)
  const scale = Math.min(scaleX, scaleY);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/**
 * Normalize various input types into a Blob.
 *
 * Supports: Blob, File, HTMLCanvasElement, OffscreenCanvas, HTMLImageElement, ImageData
 *
 * @param {*} source
 * @returns {Promise<Blob>}
 */
export async function normalizeSource(source) {
  if (source instanceof Blob) {
    return source;
  }

  // Canvas-like: toBlob or convertToBlob
  if (source && typeof source.convertToBlob === "function") {
    return source.convertToBlob({ type: "image/png" });
  }

  if (source && typeof source.toBlob === "function") {
    return new Promise((resolve, reject) => {
      source.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob returned null"));
      }, "image/png");
    });
  }

  // HTMLImageElement
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    const canvas = document.createElement("canvas");
    canvas.width = source.naturalWidth || source.width;
    canvas.height = source.naturalHeight || source.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob returned null"));
      }, "image/png");
    });
  }

  // ImageData → encode to PNG blob
  if (source && source.data instanceof Uint8ClampedArray && source.width && source.height) {
    const { encodeToBlob } = await import("./encode.js");
    return encodeToBlob(source.data, source.width, source.height, "image/png");
  }

  throw new TypeError("Unsupported source type. Expected Blob, File, Canvas, Image, or ImageData.");
}

/**
 * Get image dimensions from a Blob without fully decoding pixels.
 * Uses createImageBitmap which is lightweight.
 *
 * @param {Blob} blob
 * @returns {Promise<{ width: number, height: number }>}
 */
export async function getImageSize(blob) {
  if (typeof createImageBitmap !== "function") {
    throw new Error("createImageBitmap not available");
  }
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();
  return { width, height };
}
