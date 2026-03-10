/**
 * Pipeline worker: decode → resize → encode entirely off the main thread.
 *
 * Requires: createImageBitmap + OffscreenCanvas (Chrome 69+, Firefox 105+, Safari 16.4+)
 *
 * Message protocol:
 *   Main → Worker: { type: 'pipeline', id, blob, srcWidth?, srcHeight?,
 *                     targetWidth, targetHeight, filter, outputMimeType, outputQuality,
 *                     useWasm, wasmPath, preserveMetadata, autoRotate }
 *   Worker → Main: { type: 'pipeline-result', id, success, blob?, width?, height?,
 *                     error?, usedWasm? }
 */

import { resizeBufferFallback } from "./fallback.js";
import { readOrientation, extractSegments, orientationTransform } from "./metadata.js";

let wasmModule = null;
let wasmLoadError = null;

async function loadWasm(wasmPath) {
  if (wasmModule) return wasmModule;
  if (wasmLoadError) return null;

  try {
    const mod = await import(wasmPath);
    if (mod.default) {
      await mod.default();
    }
    wasmModule = mod;
    return mod;
  } catch (e) {
    wasmLoadError = e;
    return null;
  }
}

function parseResizeFilter(value) {
  const f = String(value || "bilinear").toLowerCase().replace(/[-_]/g, "");
  if (f === "nearest") return "nearest";
  if (f === "box") return "box";
  if (f === "hamming") return "hamming";
  if (f === "lanczos" || f === "lanczos3") return "lanczos";
  return "bilinear";
}

function toFilterCode(filter) {
  if (filter === "nearest") return 0;
  if (filter === "box") return 2;
  if (filter === "hamming") return 3;
  if (filter === "lanczos") return 4;
  return 1;
}

async function resizeRGBA(src, srcW, srcH, dstW, dstH, filter, useWasm, wasmPath) {
  const normalized = parseResizeFilter(filter);

  // Try WASM for heavy filters
  if (useWasm && normalized !== "bilinear" && normalized !== "nearest") {
    const wasm = await loadWasm(wasmPath);
    if (wasm && typeof wasm.resize_rgba === "function") {
      try {
        const output = wasm.resize_rgba(src, srcW, srcH, dstW, dstH, toFilterCode(normalized));
        return { data: new Uint8ClampedArray(output), usedWasm: true };
      } catch {
        // fall through to JS
      }
    }
  }

  const data = resizeBufferFallback(src, srcW, srcH, dstW, dstH, normalized);
  return { data, usedWasm: false };
}

async function handlePipeline(msg) {
  const {
    id,
    blob,
    targetWidth,
    targetHeight,
    filter = "bilinear",
    outputMimeType = "image/png",
    outputQuality = 0.92,
    useWasm = false,
    wasmPath = "",
    preserveMetadata = false,
    autoRotate = true,
  } = msg;

  // 1. Extract metadata if needed
  let segments = null;
  let orientation = 1;

  if (preserveMetadata || autoRotate) {
    try {
      const arrayBuf = await blob.arrayBuffer();
      if (preserveMetadata) {
        segments = extractSegments(arrayBuf);
      }
      if (autoRotate) {
        orientation = readOrientation(arrayBuf);
      }
    } catch {
      // non-JPEG or parse failure — proceed without metadata
    }
  }

  // 2. Decode Blob → pixels
  const bitmap = await createImageBitmap(blob);
  let srcW = bitmap.width;
  let srcH = bitmap.height;

  let canvas, ctx;

  if (autoRotate && orientation > 1) {
    const transform = orientationTransform(orientation, srcW, srcH);
    canvas = new OffscreenCanvas(transform.width, transform.height);
    ctx = canvas.getContext("2d");
    transform.apply(ctx);
    ctx.drawImage(bitmap, 0, 0);
    srcW = transform.width;
    srcH = transform.height;
  } else {
    canvas = new OffscreenCanvas(srcW, srcH);
    ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
  }

  bitmap.close();
  const srcData = ctx.getImageData(0, 0, srcW, srcH).data;

  // 3. Resize
  const { data: dstData, usedWasm } = await resizeRGBA(
    srcData, srcW, srcH, targetWidth, targetHeight, filter, useWasm, wasmPath
  );

  // 4. Encode → Blob
  const outCanvas = new OffscreenCanvas(targetWidth, targetHeight);
  const outCtx = outCanvas.getContext("2d");
  const outImageData = new ImageData(dstData, targetWidth, targetHeight);
  outCtx.putImageData(outImageData, 0, 0);
  let resultBlob = await outCanvas.convertToBlob({ type: outputMimeType, quality: outputQuality });

  // 5. Re-inject metadata if preserving
  if (preserveMetadata && segments && outputMimeType === "image/jpeg") {
    const { injectSegments } = await import("./metadata.js");
    resultBlob = await injectSegments(resultBlob, segments);
  }

  return { id, success: true, blob: resultBlob, width: targetWidth, height: targetHeight, usedWasm };
}

self.addEventListener("message", async (event) => {
  const msg = event.data || {};

  if (msg.type === "init") {
    self.postMessage({ type: "ready", id: msg.id, ok: true });
    return;
  }

  if (msg.type === "pipeline") {
    try {
      const result = await handlePipeline(msg);
      self.postMessage({ type: "pipeline-result", ...result });
    } catch (error) {
      self.postMessage({
        type: "pipeline-result",
        id: msg.id,
        success: false,
        error: error?.message || String(error),
      });
    }
  }
});
