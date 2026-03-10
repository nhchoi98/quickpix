/**
 * QuickPixEasy — high-level API wrapper over the QuickPix resize engine.
 *
 * Provides Blob-to-Blob pipeline, batch processing via worker pool,
 * thumbnail generation, metadata preservation, and auto-rotation.
 */

import { QuickPix } from "./index.js";
import { decodeBlob, decodeBlobWithOrientation, hasCreateImageBitmap, hasOffscreenCanvas } from "./decode.js";
import { encodeToBlob } from "./encode.js";
import { computeTargetSize, normalizeSource, getImageSize } from "./utils.js";
import { readOrientation, extractSegments, injectSegments, orientationTransform } from "./metadata.js";
import { WorkerPool } from "./worker-pool.js";
import { resizeFromContext } from "./chunked-resize.js";
import { normalizeWorkerSources, resolveWorkerURLs, warnMainThreadFallback } from "./worker-utils.js";

let _defaultWorkerURL;
const DEFAULT_PIPELINE_WORKER_CANDIDATES = [
  "./pipeline-worker.js?worker&module",
  "./pipeline-worker.js?worker",
  "./pipeline-worker.js?url",
  "./pipeline-worker.js?module",
  "./pipeline-worker.js",
];

function getDefaultWorkerURL() {
  if (_defaultWorkerURL === undefined) {
    _defaultWorkerURL = resolveWorkerURLs(DEFAULT_PIPELINE_WORKER_CANDIDATES, import.meta.url);
  }
  return _defaultWorkerURL;
}

let _defaultWasmPath;
function getDefaultWasmPath() {
  if (_defaultWasmPath === undefined) {
    try {
      _defaultWasmPath = new URL("./wasm/quickpix_wasm.js", import.meta.url).toString();
    } catch {
      _defaultWasmPath = null;
    }
  }
  return _defaultWasmPath;
}

function getWorkerSources(input) {
  return normalizeWorkerSources(input, getDefaultWorkerURL());
}

function createWorkerFactory(sources) {
  const sourceList = sources.length ? sources : [];
  return async () => {
    let lastError = null;

    for (const source of sourceList) {
      try {
        if (typeof source === "function") {
          const worker = await Promise.resolve(source());
          if (
            !worker ||
            typeof worker.addEventListener !== "function" ||
            typeof worker.postMessage !== "function"
          ) {
            throw new Error("invalid worker instance");
          }
          return worker;
        }

        return new Worker(source, { type: "module" });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Worker creation failed");
  };
}

/**
 * Detect the best execution level for this environment.
 *
 * Level 1: Full pipeline worker (OffscreenCanvas + createImageBitmap in worker)
 * Level 2: Decode/encode on main thread, resize in worker
 * Level 3: Everything on main thread
 */
function detectLevel() {
  if (
    typeof Worker === "function" &&
    hasCreateImageBitmap() &&
    hasOffscreenCanvas()
  ) {
    return 1;
  }

  if (typeof Worker === "function" && hasCreateImageBitmap()) {
    return 2;
  }

  return 3;
}

export class QuickPixEasy {
  /**
   * @param {object} [options]
   * @param {string} [options.filter='bilinear']
   * @param {number} [options.maxWorkers]
   * @param {number} [options.idleTimeout=30000]
   * @param {string} [options.outputMimeType='image/png']
   * @param {number} [options.outputQuality=0.92]
   * @param {boolean} [options.useWasm=true]
   * @param {boolean} [options.preserveMetadata=false]
   * @param {boolean} [options.autoRotate=true]
   * @param {string|URL|Function|Array<string|URL|Function>} [options.workerURL]  - Override pipeline worker URL (for bundlers)
   * @param {boolean} [options.requireWorker=false] - Throw when worker pipeline cannot be created
   * @param {string} [options.wasmPath]   - Override WASM module path (for bundlers)
   */
  constructor(options = {}) {
    this._filter = options.filter || "bilinear";
    this._outputMimeType = options.outputMimeType || "image/png";
    this._outputQuality = options.outputQuality ?? 0.92;
    this._useWasm = options.useWasm !== false;
    this._preserveMetadata = options.preserveMetadata || false;
    this._autoRotate = options.autoRotate !== false;
    this._maxWorkers = options.maxWorkers || 0;
    this._idleTimeout = options.idleTimeout ?? 30000;
    this._workerURL = options.workerURL || null;
    this._wasmPath = options.wasmPath || null;
    this._requireWorker = options.requireWorker || false;
    this._workerSources = getWorkerSources(this._workerURL);

    this._level = detectLevel();
    this._pool = null;
    this._engine = new QuickPix({
      useWasm: this._useWasm,
      filter: this._filter,
      wasmPath: this._wasmPath || undefined,
      requireWorker: this._requireWorker,
      concurrency: this._requireWorker
        ? (typeof this._maxWorkers === "number" && this._maxWorkers > 0 ? this._maxWorkers : 2)
        : 1,
    });
    this._destroyed = false;
  }

  /** @private */
  _getPool() {
    if (this._pool) return this._pool;
    if (this._level < 1) {
      if (this._requireWorker) {
        throw new Error("QuickPixEasy requires a worker environment for the pipeline mode");
      }
      return null;
    }

    if (!this._workerSources.length) {
      if (this._requireWorker) {
        throw new Error("QuickPixEasy requires pipeline worker URL, but none is available");
      }
      return null;
    }

    this._pool = new WorkerPool({
      workerFactory: createWorkerFactory(this._workerSources),
      maxWorkers: this._maxWorkers || undefined,
      idleTimeout: this._idleTimeout,
    });
    return this._pool;
  }

  /**
   * Resize a Blob to exact target dimensions. Returns a new image Blob.
   *
   * @param {Blob} blob
   * @param {number|null} width  - Target width (null to auto-calculate from height)
   * @param {number|null} height - Target height (null to auto-calculate from width)
   * @param {object} [options]
   * @param {string} [options.filter]
   * @param {string} [options.outputMimeType]
   * @param {number} [options.outputQuality]
   * @param {string} [options.fit]
   * @param {number} [options.maxDimension] - Max longest side (overrides width/height)
   * @param {boolean} [options.preserveMetadata]
   * @param {boolean} [options.autoRotate]
   * @returns {Promise<Blob>}
   */
  async resizeBlob(blob, width, height, options = {}) {
    this._checkDestroyed();

    // Auto-calculate missing dimension from aspect ratio
    if (options.maxDimension || !width || !height) {
      const size = await getImageSize(blob);
      if (options.maxDimension) {
        const target = computeTargetSize(size.width, size.height, { maxDimension: options.maxDimension });
        width = target.width;
        height = target.height;
      } else if (!width && height) {
        const target = computeTargetSize(size.width, size.height, { height });
        width = target.width;
        height = target.height;
      } else if (width && !height) {
        const target = computeTargetSize(size.width, size.height, { width });
        width = target.width;
        height = target.height;
      } else {
        width = size.width;
        height = size.height;
      }
    }

    const filter = options.filter || this._filter;
    const mimeType = options.outputMimeType || this._outputMimeType;
    const quality = options.outputQuality ?? this._outputQuality;
    const preserveMetadata = options.preserveMetadata ?? this._preserveMetadata;
    const autoRotate = options.autoRotate ?? this._autoRotate;

    // Level 1: Full pipeline in worker
    if (this._level === 1) {
      try {
        return await this._runPipeline(blob, width, height, {
          filter,
          outputMimeType: mimeType,
          outputQuality: quality,
          preserveMetadata,
          autoRotate,
        });
      } catch (error) {
        if (this._requireWorker) {
          throw error;
        }
        warnMainThreadFallback("QuickPixEasy: pipeline worker failed, fallback to main-thread resize", error);
        // fall through to main thread path
      }
    }

    if (this._level < 1) {
      warnMainThreadFallback(
        "QuickPixEasy: worker pipeline environment is unavailable, fallback to main-thread resize."
      );
    }

    if (this._requireWorker) {
      throw new Error("QuickPixEasy requires pipeline worker execution, but worker mode is unavailable");
    }

    // Level 2 & 3: Main thread decode/encode
    return this._resizeOnMainThread(blob, width, height, {
      filter,
      outputMimeType: mimeType,
      outputQuality: quality,
      preserveMetadata,
      autoRotate,
    });
  }

  /**
   * Resize a File (convenience wrapper over resizeBlob).
   *
   * @param {File} file
   * @param {number} width
   * @param {number} height
   * @param {object} [options]
   * @returns {Promise<Blob>}
   */
  async resizeFile(file, width, height, options = {}) {
    return this.resizeBlob(file, width, height, options);
  }

  /**
   * Create a thumbnail with preserved aspect ratio.
   * The longest side will be at most `maxDimension` pixels.
   *
   * @param {Blob|File|ImageData|HTMLCanvasElement|HTMLImageElement} source
   * @param {number} maxDimension
   * @param {object} [options]
   * @returns {Promise<Blob>}
   */
  async createThumbnail(source, maxDimension, options = {}) {
    this._checkDestroyed();

    const blob = await normalizeSource(source);
    const size = await getImageSize(blob);
    const target = computeTargetSize(size.width, size.height, { maxDimension });

    return this.resizeBlob(blob, target.width, target.height, options);
  }

  /**
   * Resize source and draw result onto a canvas.
   *
   * @param {Blob|File|ImageData} source
   * @param {HTMLCanvasElement|OffscreenCanvas} canvas - Must have width/height set
   * @param {object} [options]
   * @returns {Promise<HTMLCanvasElement|OffscreenCanvas>}
   */
  async resizeToCanvas(source, canvas, options = {}) {
    this._checkDestroyed();

    const blob = await normalizeSource(source);
    const filter = options.filter || this._filter;
    const autoRotate = options.autoRotate ?? this._autoRotate;

    let orientation = 1;
    if (autoRotate) {
      try {
        const buf = await blob.arrayBuffer();
        orientation = readOrientation(buf);
      } catch {
        // not JPEG
      }
    }

    const decoded = orientation > 1
      ? await decodeBlobWithOrientation(blob, orientation)
      : await decodeBlob(blob);

    const result = await this._engine.resizeBuffer(
      decoded.data,
      decoded.width,
      decoded.height,
      canvas.width,
      canvas.height,
      { filter }
    );

    const ctx = canvas.getContext("2d");
    const imageData = new ImageData(result.data, result.width, result.height);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * Process multiple images in parallel using the worker pool.
   *
   * @param {Array<{ source: Blob|File, width?: number, height?: number, maxDimension?: number }>} items
   * @param {object} [options] - Shared options for all items
   * @returns {Promise<Blob[]>}
   */
  async batchResize(items, options = {}) {
    this._checkDestroyed();

    if (this._level === 1) {
      try {
        return await this._batchPipeline(items, options);
      } catch (error) {
        if (this._requireWorker) {
          throw error;
        }
        warnMainThreadFallback("QuickPixEasy: batch pipeline worker failed, fallback to main-thread batch resize", error);
        // fall through
      }
    }

    if (this._level < 1) {
      warnMainThreadFallback(
        "QuickPixEasy: worker pipeline environment is unavailable, fallback to main-thread batch resize."
      );
    }

    if (this._requireWorker) {
      throw new Error("QuickPixEasy requires pipeline worker execution, but worker mode is unavailable");
    }

    // Sequential fallback
    const results = [];
    for (const item of items) {
      const blob = await normalizeSource(item.source);
      const size = await getImageSize(blob);
      const target = item.maxDimension
        ? computeTargetSize(size.width, size.height, { maxDimension: item.maxDimension })
        : computeTargetSize(size.width, size.height, { width: item.width, height: item.height });

      results.push(await this.resizeBlob(blob, target.width, target.height, options));
    }
    return results;
  }

  /**
   * Release all workers and resources.
   */
  destroy() {
    this._destroyed = true;
    if (this._pool) {
      this._pool.destroy();
      this._pool = null;
    }
  }

  /** @private */
  _checkDestroyed() {
    if (this._destroyed) {
      throw new Error("QuickPixEasy has been destroyed");
    }
  }

  /** @private */
  async _runPipeline(blob, width, height, opts) {
    const pool = this._getPool();
    if (!pool) {
      throw new Error("Pipeline worker pool is unavailable");
    }
    const result = await pool.run({
      type: "pipeline",
      blob,
      targetWidth: width,
      targetHeight: height,
      filter: opts.filter,
      outputMimeType: opts.outputMimeType,
      outputQuality: opts.outputQuality,
      useWasm: this._useWasm,
      wasmPath: this._wasmPath || getDefaultWasmPath() || "",
      preserveMetadata: opts.preserveMetadata,
      autoRotate: opts.autoRotate,
    });
    return result.blob;
  }

  /** @private */
  async _batchPipeline(items, options) {
    const pool = this._getPool();
    if (!pool) {
      throw new Error("Pipeline worker pool is unavailable");
    }
    const filter = options.filter || this._filter;
    const mimeType = options.outputMimeType || this._outputMimeType;
    const quality = options.outputQuality ?? this._outputQuality;
    const preserveMetadata = options.preserveMetadata ?? this._preserveMetadata;
    const autoRotate = options.autoRotate ?? this._autoRotate;
    const wasmPath = this._wasmPath || getDefaultWasmPath() || "";

    const tasks = await Promise.all(
      items.map(async (item) => {
        const blob = await normalizeSource(item.source);
        const size = await getImageSize(blob);
        const target = item.maxDimension
          ? computeTargetSize(size.width, size.height, { maxDimension: item.maxDimension })
          : computeTargetSize(size.width, size.height, { width: item.width, height: item.height });

        return {
          type: "pipeline",
          blob,
          targetWidth: target.width,
          targetHeight: target.height,
          filter,
          outputMimeType: mimeType,
          outputQuality: quality,
          useWasm: this._useWasm,
          wasmPath,
          preserveMetadata,
          autoRotate,
        };
      })
    );

    const results = await pool.runBatch(tasks);
    return results.map((r) => r.blob);
  }

  /** @private */
  async _resizeOnMainThread(blob, width, height, opts) {
    // Extract metadata before decode
    let segments = null;
    let orientation = 1;

    if (opts.preserveMetadata || opts.autoRotate) {
      try {
        const buf = await blob.arrayBuffer();
        if (opts.preserveMetadata) segments = extractSegments(buf);
        if (opts.autoRotate) orientation = readOrientation(buf);
      } catch {
        // not JPEG
      }
    }

    // Check image size to decide chunked vs full path
    const size = await getImageSize(blob);
    const CHUNKED_THRESHOLD = 4096 * 4096;
    const totalPixels = size.width * size.height;
    let resultData;

    if (totalPixels > CHUNKED_THRESHOLD && hasCreateImageBitmap()) {
      // Large image: chunked path via canvas strips
      const bitmap = await createImageBitmap(blob);
      let srcW = bitmap.width;
      let srcH = bitmap.height;
      let canvas, ctx;

      if (orientation > 1) {
        const transform = orientationTransform(orientation, srcW, srcH);
        if (hasOffscreenCanvas()) {
          canvas = new OffscreenCanvas(transform.width, transform.height);
        } else {
          canvas = document.createElement("canvas");
          canvas.width = transform.width;
          canvas.height = transform.height;
        }
        ctx = canvas.getContext("2d", { willReadFrequently: true });
        transform.apply(ctx);
        ctx.drawImage(bitmap, 0, 0);
        srcW = transform.width;
        srcH = transform.height;
      } else {
        if (hasOffscreenCanvas()) {
          canvas = new OffscreenCanvas(srcW, srcH);
        } else {
          canvas = document.createElement("canvas");
          canvas.width = srcW;
          canvas.height = srcH;
        }
        ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();

      resultData = resizeFromContext(ctx, srcW, srcH, width, height, opts.filter);
      canvas = null;
      ctx = null;
    } else {
      // Small/medium image: full decode → engine resize
      const decoded = orientation > 1
        ? await decodeBlobWithOrientation(blob, orientation)
        : await decodeBlob(blob);

      const result = await this._engine.resizeBuffer(
        decoded.data,
        decoded.width,
        decoded.height,
        width,
        height,
        { filter: opts.filter }
      );
      resultData = result.data;
    }

    // Encode
    let resultBlob = await encodeToBlob(resultData, width, height, opts.outputMimeType, opts.outputQuality);

    // Re-inject metadata
    if (opts.preserveMetadata && segments && opts.outputMimeType === "image/jpeg") {
      resultBlob = await injectSegments(resultBlob, segments);
    }

    return resultBlob;
  }
}

/**
 * Factory function to create a QuickPixEasy instance.
 * @param {object} [options]
 * @returns {QuickPixEasy}
 */
export function createQuickPixEasy(options = {}) {
  return new QuickPixEasy(options);
}
