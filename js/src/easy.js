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

const PIPELINE_WORKER_URL = new URL("./pipeline-worker.js", import.meta.url).toString();

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

    this._level = detectLevel();
    this._pool = null;
    this._engine = new QuickPix({
      useWasm: this._useWasm,
      filter: this._filter,
    });
    this._destroyed = false;
  }

  /** @private */
  _getPool() {
    if (this._pool) return this._pool;
    if (this._level < 1) return null;

    this._pool = new WorkerPool({
      workerScript: PIPELINE_WORKER_URL,
      maxWorkers: this._maxWorkers || undefined,
      idleTimeout: this._idleTimeout,
    });
    return this._pool;
  }

  /**
   * Resize a Blob to exact target dimensions. Returns a new image Blob.
   *
   * @param {Blob} blob
   * @param {number} width  - Target width
   * @param {number} height - Target height
   * @param {object} [options]
   * @param {string} [options.filter]
   * @param {string} [options.outputMimeType]
   * @param {number} [options.outputQuality]
   * @param {string} [options.fit]
   * @param {boolean} [options.preserveMetadata]
   * @param {boolean} [options.autoRotate]
   * @returns {Promise<Blob>}
   */
  async resizeBlob(blob, width, height, options = {}) {
    this._checkDestroyed();

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
      } catch {
        // fall through to main thread path
      }
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
      } catch {
        // fall through
      }
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
    const result = await pool.run({
      type: "pipeline",
      blob,
      targetWidth: width,
      targetHeight: height,
      filter: opts.filter,
      outputMimeType: opts.outputMimeType,
      outputQuality: opts.outputQuality,
      useWasm: this._useWasm,
      wasmPath: new URL("./wasm/quickpix_wasm.js", import.meta.url).toString(),
      preserveMetadata: opts.preserveMetadata,
      autoRotate: opts.autoRotate,
    });
    return result.blob;
  }

  /** @private */
  async _batchPipeline(items, options) {
    const pool = this._getPool();
    const filter = options.filter || this._filter;
    const mimeType = options.outputMimeType || this._outputMimeType;
    const quality = options.outputQuality ?? this._outputQuality;
    const preserveMetadata = options.preserveMetadata ?? this._preserveMetadata;
    const autoRotate = options.autoRotate ?? this._autoRotate;
    const wasmPath = new URL("./wasm/quickpix_wasm.js", import.meta.url).toString();

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
