import { resizeBufferFallbackRange } from "./fallback.js";

let workerState = {
  src: null,
  srcWidth: 0,
  srcHeight: 0,
  dstWidth: 0,
  dstHeight: 0,
  filter: "bilinear",
  tileSize: 0,
};

function normalizeFilterFromMessage(filter, filterCode) {
  if (filterCode === 0) return "nearest";
  if (filterCode === 1) return "bilinear";
  if (filterCode === 2) return "box";
  if (filterCode === 3) return "hamming";
  if (filterCode === 4) return "lanczos";
  if (filter === "nearest") return "nearest";
  if (filter === "box") return "box";
  if (filter === "hamming") return "hamming";
  if (filter === "lanczos" || filter === "lanczos3") return "lanczos";
  return "bilinear";
}

function ensureSourceState(payload) {
  if (workerState.src && payload.filter && payload.tileSize >= 0) {
    // keep existing source and keep options in sync
    workerState.filter = normalizeFilterFromMessage(payload.filter, payload.filterCode);
    workerState.tileSize = Number(payload.tileSize) > 0 ? Number.parseInt(payload.tileSize, 10) : 0;
    return true;
  }

  return false;
}

function decodeSource(payload) {
  const srcValue = payload.src;
  if (!srcValue) return false;

  let sourceArray;
  if (srcValue instanceof SharedArrayBuffer || srcValue instanceof ArrayBuffer) {
    sourceArray = new Uint8ClampedArray(srcValue);
  } else if (ArrayBuffer.isView(srcValue)) {
    sourceArray = new Uint8ClampedArray(srcValue.buffer, srcValue.byteOffset, srcValue.byteLength);
  } else {
    return false;
  }

  const srcWidth = Number(payload.srcWidth);
  const srcHeight = Number(payload.srcHeight);
  const required = srcWidth * srcHeight * 4;
  if (!Number.isInteger(srcWidth) || !Number.isInteger(srcHeight) || srcWidth <= 0 || srcHeight <= 0) {
    return false;
  }
  if (sourceArray.length < required) return false;

  workerState = {
    src: sourceArray,
    srcWidth,
    srcHeight,
    dstWidth: Number(payload.dstWidth),
    dstHeight: Number(payload.dstHeight),
    filter: normalizeFilterFromMessage(payload.filter, payload.filterCode),
    tileSize: Number(payload.tileSize) > 0 ? Number.parseInt(payload.tileSize, 10) : 0,
  };

  return Number.isInteger(workerState.dstWidth)
    && Number.isInteger(workerState.dstHeight)
    && workerState.dstWidth > 0
    && workerState.dstHeight > 0;
}

function normalizeDestinationHeight(msg) {
  const yStart = Number(msg.yStart);
  const yEnd = Number(msg.yEnd);
  if (!Number.isInteger(yStart) || !Number.isInteger(yEnd)) return null;
  return {
    yStart: Math.max(0, Math.min(workerState.dstHeight, yStart)),
    yEnd: Math.max(Math.max(0, Math.min(workerState.dstHeight, yStart)), Math.min(workerState.dstHeight, yEnd)),
  };
}

addEventListener("message", async (event) => {
  const message = event.data || {};

  if (message.type === "init") {
    const ok = decodeSource(message.payload || {});
    if (!ok) {
      postMessage({ type: "ready", id: message.id, ok: false, error: "invalid worker init" });
      return;
    }
    postMessage({ type: "ready", id: message.id, ok: true });
    return;
  }

  if (message.type !== "resize") {
    return;
  }

  const id = message.id;
  if (!workerState.src) {
    postMessage({ type: "result", id, success: false, error: "worker not initialized" });
    return;
  }

  ensureSourceState(message);
  const range = normalizeDestinationHeight(message);
  if (!range) {
    postMessage({ type: "result", id, success: false, error: "invalid resize range" });
    return;
  }

  const filter = normalizeFilterFromMessage(message.filter, message.filterCode);

  try {
    const out = resizeBufferFallbackRange(
      workerState.src,
      workerState.srcWidth,
      workerState.srcHeight,
      workerState.dstWidth,
      workerState.dstHeight,
      range.yStart,
      range.yEnd,
      filter,
      { tileSize: workerState.tileSize }
    );

    postMessage(
      {
        type: "result",
        id,
        yStart: range.yStart,
        yEnd: range.yEnd,
        success: true,
        usedWasm: false,
        data: out.buffer,
      },
      [out.buffer]
    );
  } catch (error) {
    postMessage({
      type: "result",
      id,
      yStart: range.yStart,
      yEnd: range.yEnd,
      success: false,
      error: String(error && error.message ? error.message : error),
    });
  }
});
