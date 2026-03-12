// ── Core types ──────────────────────────────────────────────────────────

export type ResizeFilter = "nearest" | "bilinear" | "box" | "hamming" | "lanczos2" | "lanczos";

export type FitMode = "contain" | "cover" | "fill";

export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp" | (string & {});
export type WorkerSource = string | URL | (() => Worker | Promise<Worker>);

// ── QuickPix (low-level engine) ─────────────────────────────────────────

export interface QuickPixOptions {
  useWasm?: boolean;
  wasmPath?: string;
  forceFallback?: boolean;
  tileSize?: number;
  filter?: ResizeFilter;
  concurrency?: number;
  workerURL?: WorkerSource | WorkerSource[];
  requireWorker?: boolean;
}

export interface ResizeOptions {
  filter?: ResizeFilter;
  tileSize?: number;
  useWasm?: boolean;
  forceFallback?: boolean;
  concurrency?: number;
}

export interface ResizeBufferResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface QuickPixStats {
  calls: number;
  wasmHits: number;
  fallbackHits: number;
  lastError: Error | null;
}

export class QuickPix {
  constructor(options?: QuickPixOptions);
  resizeBuffer(
    src: Uint8Array | Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
    options?: ResizeOptions,
  ): Promise<ResizeBufferResult>;
  resize(
    from: ImageData | HTMLCanvasElement | OffscreenCanvas,
    to: ImageData | HTMLCanvasElement | OffscreenCanvas,
    options?: ResizeOptions,
  ): Promise<ImageData | HTMLCanvasElement | OffscreenCanvas>;
  toBlob(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    mimeType?: ImageMimeType,
    quality?: number,
  ): Promise<Blob>;
  getStats(): QuickPixStats;
}

export function createQuickPix(options?: QuickPixOptions): QuickPix;

// ── QuickPixEasy (high-level API) ───────────────────────────────────────

export interface QuickPixEasyOptions {
  filter?: ResizeFilter;
  maxWorkers?: number;
  idleTimeout?: number;
  outputMimeType?: ImageMimeType;
  outputQuality?: number;
  useWasm?: boolean;
  preserveMetadata?: boolean;
  autoRotate?: boolean;
  workerURL?: WorkerSource | WorkerSource[];
  requireWorker?: boolean;
  wasmPath?: string;
}

export interface EasyResizeOptions {
  filter?: ResizeFilter;
  fit?: FitMode;
  maxDimension?: number;
  outputMimeType?: ImageMimeType;
  outputQuality?: number;
  preserveMetadata?: boolean;
  autoRotate?: boolean;
}

export interface BatchItem {
  source: Blob | File;
  width?: number;
  height?: number;
  maxDimension?: number;
}

export class QuickPixEasy {
  constructor(options?: QuickPixEasyOptions);
  resizeBlob(blob: Blob, width: number | null, height: number | null, options?: EasyResizeOptions): Promise<Blob>;
  resizeFile(file: File, width: number | null, height: number | null, options?: EasyResizeOptions): Promise<Blob>;
  createThumbnail(
    source: Blob | File | ImageData | HTMLCanvasElement | HTMLImageElement,
    maxDimension: number,
    options?: EasyResizeOptions,
  ): Promise<Blob>;
  resizeToCanvas(
    source: Blob | File | ImageData,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options?: EasyResizeOptions,
  ): Promise<HTMLCanvasElement | OffscreenCanvas>;
  batchResize(items: BatchItem[], options?: EasyResizeOptions): Promise<Blob[]>;
  destroy(): void;
}

export function createQuickPixEasy(options?: QuickPixEasyOptions): QuickPixEasy;

// ── Re-exports ──────────────────────────────────────────────────────────

export type { MetadataSegments, OrientationTransformResult } from "./metadata.js";
export type { TargetSizeOptions, DecodedImage } from "./utils.js";
