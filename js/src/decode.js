/**
 * Image decoding utilities.
 * Converts Blob/File into raw RGBA ImageData using the best available path.
 */

export function hasCreateImageBitmap() {
  return typeof createImageBitmap === "function";
}

export function hasOffscreenCanvas() {
  return typeof OffscreenCanvas === "function";
}

export function isWorkerScope() {
  return typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
}

/**
 * Decode a Blob into { data: Uint8ClampedArray, width: number, height: number }.
 * Auto-selects the best available path for the current environment.
 */
export async function decodeBlob(blob) {
  if (hasCreateImageBitmap() && hasOffscreenCanvas()) {
    return decodeBlobWithOffscreen(blob);
  }

  if (hasCreateImageBitmap() && !isWorkerScope()) {
    return decodeBlobWithCanvas(blob);
  }

  if (!isWorkerScope() && typeof document !== "undefined") {
    return decodeBlobWithImage(blob);
  }

  throw new Error("No image decoding path available in this environment");
}

/**
 * Decode using OffscreenCanvas (works in both main thread and workers).
 */
async function decodeBlobWithOffscreen(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

/**
 * Decode using HTMLCanvasElement (main thread only).
 */
async function decodeBlobWithCanvas(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

/**
 * Decode using Image element + URL.createObjectURL (legacy fallback, main thread only).
 */
async function decodeBlobWithImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: imageData.data, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/**
 * Decode with EXIF orientation correction.
 * Applies the orientation transform so the output pixels are correctly rotated.
 */
export async function decodeBlobWithOrientation(blob, orientation) {
  if (!orientation || orientation === 1) {
    return decodeBlob(blob);
  }

  const { orientationTransform } = await import("./metadata.js");
  const bitmap = await createImageBitmap(blob);
  const transform = orientationTransform(orientation, bitmap.width, bitmap.height);

  let canvas, ctx;
  if (hasOffscreenCanvas()) {
    canvas = new OffscreenCanvas(transform.width, transform.height);
    ctx = canvas.getContext("2d");
  } else if (!isWorkerScope() && typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = transform.width;
    canvas.height = transform.height;
    ctx = canvas.getContext("2d");
  } else {
    bitmap.close();
    throw new Error("No canvas available for orientation correction");
  }

  transform.apply(ctx);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, transform.width, transform.height);
  return { data: imageData.data, width: transform.width, height: transform.height };
}
