/**
 * Image encoding utilities.
 * Converts raw RGBA data into a Blob using the best available canvas path.
 */

import { hasOffscreenCanvas, isWorkerScope } from "./decode.js";

/**
 * Encode RGBA pixel data into an image Blob.
 *
 * @param {Uint8ClampedArray} data  - RGBA pixel buffer
 * @param {number} width
 * @param {number} height
 * @param {string} [mimeType='image/png']
 * @param {number} [quality=0.92]
 * @returns {Promise<Blob>}
 */
export async function encodeToBlob(data, width, height, mimeType = "image/png", quality = 0.92) {
  if (hasOffscreenCanvas()) {
    return encodeWithOffscreen(data, width, height, mimeType, quality);
  }

  if (!isWorkerScope() && typeof document !== "undefined") {
    return encodeWithCanvas(data, width, height, mimeType, quality);
  }

  throw new Error("No image encoding path available in this environment");
}

async function encodeWithOffscreen(data, width, height, mimeType, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const imageData = new ImageData(data, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: mimeType, quality });
}

function encodeWithCanvas(data, width, height, mimeType, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const imageData = new ImageData(data, width, height);
  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("toBlob returned null"));
        }
      },
      mimeType,
      quality
    );
  });
}
