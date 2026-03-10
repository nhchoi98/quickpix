import { loadWasmModule } from "./wasm-loader.js";
import { resizeBufferFallback } from "./fallback.js";

const DEFAULT_WASM_PATH = new URL("./wasm/quickpix_wasm.js", import.meta.url).toString();
const WORKER_SCRIPT_URL = new URL("./resize-worker.js", import.meta.url).toString();

function normalizeOptions(input) {
  const options = Object.assign(
    { useWasm: true, filter: "bilinear", tileSize: 0, forceFallback: false, concurrency: 1 },
    input || {}
  );

  options.useWasm = options.useWasm !== false && !options.forceFallback;
  options.filter = String(options.filter || "bilinear");
  options.tileSize = Number(options.tileSize) > 0 ? Number.parseInt(options.tileSize, 10) : 0;
  options.concurrency = Number.isFinite(Number(options.concurrency))
    ? Math.max(1, Number.parseInt(options.concurrency, 10))
    : 1;
  return options;
}

function parseResizeFilter(value) {
  const filter = String(value || "bilinear").toLowerCase().replace(/[-_]/g, "");
  if (filter === "nearest") return "nearest";
  if (filter === "box") return "box";
  if (filter === "hamming") return "hamming";
  if (filter === "lanczos2") return "lanczos2";
  if (filter === "lanczos" || filter === "lanczos3") return "lanczos";
  if (filter === "bilinear") return "bilinear";
  return "bilinear";
}

function toFilterCode(filter) {
  const normalized = parseResizeFilter(filter);
  if (normalized === "nearest") return 0;
  if (normalized === "box") return 2;
  if (normalized === "hamming") return 3;
  if (normalized === "lanczos2") return 5;
  if (normalized === "lanczos") return 4;
  return 1;
}

function mergeOption(base, override) {
  return Object.assign({}, base, override || {});
}

function validateBuffer(src, srcWidth, srcHeight) {
  if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
    throw new TypeError("src must be Uint8Array");
  }
  if (!Number.isInteger(srcWidth) || !Number.isInteger(srcHeight)) {
    throw new TypeError("srcWidth/srcHeight must be integer");
  }
  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new RangeError("Invalid source size");
  }
  if (src.length < srcWidth * srcHeight * 4) {
    throw new RangeError("source buffer too small");
  }
}

function validateDestination(dstWidth, dstHeight) {
  if (!Number.isInteger(dstWidth) || !Number.isInteger(dstHeight)) {
    throw new TypeError("dstWidth/dstHeight must be integer");
  }
  if (dstWidth <= 0 || dstHeight <= 0) {
    throw new RangeError("Invalid destination size");
  }
}

function toImageDataFromCanvas(canvas) {
  if (typeof ImageData !== "undefined" && canvas instanceof ImageData) {
    return canvas;
  }

  if (canvas && typeof canvas.getContext === "function") {
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof ctx.getImageData !== "function") {
      throw new TypeError("canvas-like object must provide 2D context with getImageData");
    }
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  throw new TypeError("unsupported input type");
}

async function drawImageDataToCanvas(canvas, imageData) {
  if (canvas && typeof canvas.getContext === "function") {
    const ctx = canvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);
    return;
  }
  throw new TypeError("output canvas is required when input/output are canvas-like");
}

function hasWorkerSupport() {
  return typeof Worker === "function" && typeof Blob === "function";
}

function buildWorkerSource(src) {
  if (typeof SharedArrayBuffer !== "undefined") {
    try {
      const shared = new SharedArrayBuffer(src.byteLength);
      new Uint8ClampedArray(shared).set(src);
      return { type: "shared", source: shared };
    } catch {
      // fall through to copied source
    }
  }

  return { type: "array", source: new Uint8ClampedArray(src).buffer };
}

function resolveWorkersToUse(concurrency, dstHeight) {
  const hw = (typeof navigator !== "undefined" && navigator && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(concurrency, dstHeight, hw));
}

export class QuickPix {
  constructor(options = {}) {
    const normalized = normalizeOptions(options);
    this._options = normalized;
    this._wasmPath = normalized.wasmPath || DEFAULT_WASM_PATH;
    this._loadError = null;
    this._wasm = null;
    this._stats = {
      calls: 0,
      wasmHits: 0,
      fallbackHits: 0,
      lastError: null,
    };
    this._workerId = 0;
  }

  async _ensureWasm() {
    if (!this._options.useWasm || this._wasm) {
      return this._wasm;
    }

    if (this._loadError) {
      return null;
    }

    try {
      this._wasm = await loadWasmModule(this._wasmPath);
      return this._wasm;
    } catch (error) {
      this._loadError = error;
      this._stats.lastError = error;
      return null;
    }
  }

  async _createWorker(initPayload) {
    const worker = new Worker(WORKER_SCRIPT_URL, { type: "module" });
    const id = this._workerId += 1;

    return new Promise((resolve, reject) => {
      let settled = false;

      const done = (payload) => {
        if (settled) return;
        settled = true;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);

        if (payload && payload.ok) {
          resolve({ id, worker });
        } else if (payload && payload.error) {
          reject(new Error(payload.error));
        } else {
          reject(new Error("worker init failed"));
        }
      };

      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.type !== "ready") return;
        done(msg);
      };

      const onError = (event) => {
        done({ error: String(event && (event.message || event.error) || "worker initialization failed") });
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({
        type: "init",
        id,
        payload: initPayload,
      });
    });
  }

  async _runWorkerTask(worker, task) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.id !== task.id || msg.type !== "result") {
          return;
        }

        settled = true;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);

        if (msg.success) {
          resolve({
            yStart: msg.yStart,
            yEnd: msg.yEnd,
            usedWasm: msg.usedWasm,
            data: new Uint8ClampedArray(msg.data),
          });
          return;
        }

        reject(new Error(msg.error || "worker resize failed"));
      };

      const onError = () => {
        if (settled) return;
        settled = true;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        reject(new Error("worker runtime error"));
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ type: "resize", id: task.id, ...task });
    });
  }

  async _resizeWithWorkers(src, srcWidth, srcHeight, dstWidth, dstHeight, options) {
    if (!hasWorkerSupport()) {
      return this._runFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, options);
    }

    const workerCount = resolveWorkersToUse(options.concurrency, dstHeight);
    if (workerCount <= 1) {
      return this._runFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, options);
    }

    const rowsPerWorker = Math.ceil(dstHeight / workerCount);
    const source = buildWorkerSource(src);
    const filter = parseResizeFilter(options.filter);
    const filterCode = toFilterCode(filter);
    const workers = [];

    try {
      for (let i = 0; i < workerCount; i += 1) {
        const payload = {
          srcWidth,
          srcHeight,
          dstWidth,
          dstHeight,
          filter,
          filterCode,
          tileSize: options.tileSize,
          sourceType: source.type,
          src: source.type === "shared" ? source.source : source.source.slice(0),
          useWasm: options.useWasm && !options.forceFallback,
          wasmPath: this._wasmPath,
        };

        const created = await this._createWorker(payload);
        workers.push(created.worker);
      }
    } catch (error) {
      workers.forEach((w) => w.terminate());
      this._stats.lastError = error;
      throw error;
    }

    const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
    let usedWasm = false;
    const tasks = [];

    for (let rowStart = 0; rowStart < dstHeight; rowStart += rowsPerWorker) {
      const rowEnd = Math.min(dstHeight, rowStart + rowsPerWorker);
      const taskId = this._workerId += 1;
      const worker = workers[(rowStart / rowsPerWorker) % workers.length];

      tasks.push(
        this._runWorkerTask(worker, {
          id: taskId,
          yStart: rowStart,
          yEnd: rowEnd,
          srcWidth,
          srcHeight,
          dstWidth,
          dstHeight,
          filter,
          filterCode,
          tileSize: options.tileSize,
        }).then((result) => {
          out.set(result.data, result.yStart * dstWidth * 4);
          if (result.usedWasm) {
            usedWasm = true;
          }
        })
      );
    }

    try {
      await Promise.all(tasks);
    } catch (error) {
      this._stats.lastError = error;
      throw error;
    } finally {
      workers.forEach((w) => w.terminate());
    }

    return {
      data: out,
      width: dstWidth,
      height: dstHeight,
      usedWasm,
    };
  }

  async _runFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, options) {
    const out = resizeBufferFallback(
      src,
      srcWidth,
      srcHeight,
      dstWidth,
      dstHeight,
      parseResizeFilter(options.filter),
      { tileSize: options.tileSize }
    );
    return {
      data: out,
      width: dstWidth,
      height: dstHeight,
      usedWasm: false,
    };
  }

  async _runWasmFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, options) {
    // bilinear and nearest are lightweight enough that JS direct path
    // outperforms WASM due to zero memory-copy overhead.
    const filter = parseResizeFilter(options.filter);
    if (filter === "bilinear" || filter === "nearest") {
      return this._runFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, options);
    }

    const wasm = options.useWasm ? await this._ensureWasm() : null;
    if (wasm && typeof wasm.resize_rgba === "function") {
      try {
        const output = wasm.resize_rgba(
          src,
          srcWidth,
          srcHeight,
          dstWidth,
          dstHeight,
          toFilterCode(options.filter)
        );
        return {
          data: new Uint8ClampedArray(output),
          width: dstWidth,
          height: dstHeight,
          usedWasm: true,
        };
      } catch (error) {
        this._loadError = error;
        this._stats.lastError = error;
      }
    }

    return this._runFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, options);
  }

  async resizeBuffer(src, srcWidth, srcHeight, dstWidth, dstHeight, options = {}) {
    validateBuffer(src, srcWidth, srcHeight);
    validateDestination(dstWidth, dstHeight);

    const merged = mergeOption(this._options, options);
    this._stats.calls += 1;

    if (merged.concurrency > 1) {
      try {
        const workerResult = await this._resizeWithWorkers(
          src,
          srcWidth,
          srcHeight,
          dstWidth,
          dstHeight,
          merged
        );

        if (workerResult.usedWasm) {
          this._stats.wasmHits += 1;
        } else {
          this._stats.fallbackHits += 1;
        }

        return {
          data: workerResult.data,
          width: workerResult.width,
          height: workerResult.height,
        };
      } catch {
        // fall through to direct path
      }
    }

    const direct = merged.useWasm
      ? await this._runWasmFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, merged)
      : await this._runFallback(src, srcWidth, srcHeight, dstWidth, dstHeight, merged);

    if (direct.usedWasm) {
      this._stats.wasmHits += 1;
    } else {
      this._stats.fallbackHits += 1;
    }

    return {
      data: direct.data,
      width: direct.width,
      height: direct.height,
    };
  }

  async resize(from, to, options = {}) {
    const merged = mergeOption(this._options, options);
    const source = toImageDataFromCanvas(from);
    const target = toImageDataFromCanvas(to);
    const result = await this.resizeBuffer(
      source.data,
      source.width,
      source.height,
      target.width,
      target.height,
      merged
    );
    target.data.set(result.data);
    await drawImageDataToCanvas(to, target);
    return to;
  }

  async toBlob(canvas, mimeType = "image/png", quality = 0.92) {
    if (typeof canvas.convertToBlob === "function") {
      return canvas.convertToBlob({ type: mimeType, quality });
    }

    if (typeof canvas.toBlob === "function") {
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob == null) {
            reject(new TypeError("toBlob returned null"));
          } else {
            resolve(blob);
          }
        }, mimeType, quality);
      });
    }

    throw new TypeError("canvas.toBlob is not available");
  }

  getStats() {
    return Object.assign({}, this._stats);
  }
}

export function createQuickPix(options = {}) {
  return new QuickPix(options);
}

export { QuickPixEasy, createQuickPixEasy } from "./easy.js";

export default {
  QuickPix,
  createQuickPix,
};
