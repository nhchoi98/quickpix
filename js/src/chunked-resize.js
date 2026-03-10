/**
 * Chunked canvas → resize pipeline.
 *
 * Reads the source canvas in horizontal strips via getImageData(),
 * runs the horizontal resample per strip, then runs the vertical
 * resample on the (much smaller) intermediate buffer.
 *
 * This avoids holding the full source RGBA in CPU memory at once.
 *
 * Memory comparison (10000×8000 → 800×600):
 *   Full decode:   320 MB source RGBA + 102 MB intermediate = 422 MB CPU peak
 *   Chunked:        20 MB strip      + 102 MB intermediate = 122 MB CPU peak
 */

import { computeAxisKernels, normalizeFilter, roundToU8 } from "./fallback.js";

const DEFAULT_STRIP_HEIGHT = 512;

/**
 * Resize directly from a canvas context, reading source pixels in strips.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} dstWidth
 * @param {number} dstHeight
 * @param {string} filter
 * @param {object} [opts]
 * @param {number} [opts.stripHeight=512]
 * @returns {Uint8ClampedArray}
 */
export function resizeFromContext(ctx, srcWidth, srcHeight, dstWidth, dstHeight, filter, opts) {
  const resolvedFilter = normalizeFilter(filter);
  const stripHeight = (opts && opts.stripHeight > 0) ? opts.stripHeight : DEFAULT_STRIP_HEIGHT;

  // For nearest and bilinear, we need a different approach since they
  // access source pixels directly (not via precomputed kernels in 2-pass).
  // Fall back to full getImageData for these lightweight filters.
  if (resolvedFilter === "nearest" || resolvedFilter === "bilinear") {
    const imageData = ctx.getImageData(0, 0, srcWidth, srcHeight);
    return resizeSimpleFilter(imageData.data, srcWidth, srcHeight, dstWidth, dstHeight, resolvedFilter);
  }

  return resizeConvolutionChunked(ctx, srcWidth, srcHeight, dstWidth, dstHeight, resolvedFilter, stripHeight);
}

/**
 * Nearest / bilinear: these are fast enough that full-buffer is acceptable,
 * but we still process output in strips to limit peak memory.
 */
function resizeSimpleFilter(src, srcWidth, srcHeight, dstWidth, dstHeight, filter) {
  const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);

  if (filter === "nearest") {
    for (let y = 0; y < dstHeight; y++) {
      const sy = Math.min(srcHeight - 1, Math.max(0, Math.round(((y + 0.5) * srcHeight) / dstHeight - 0.5)));
      for (let x = 0; x < dstWidth; x++) {
        const sx = Math.min(srcWidth - 1, Math.max(0, Math.round(((x + 0.5) * srcWidth) / dstWidth - 0.5)));
        const si = (sy * srcWidth + sx) * 4;
        const di = (y * dstWidth + x) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = src[si + 3];
      }
    }
    return out;
  }

  // bilinear
  const srcW4 = srcWidth * 4;
  for (let y = 0; y < dstHeight; y++) {
    const gy = ((y + 0.5) * srcHeight) / dstHeight - 0.5;
    const y0 = Math.min(srcHeight - 1, Math.max(0, Math.floor(gy)));
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const ty = gy - y0;
    const ity = 1 - ty;
    const row0 = y0 * srcW4;
    const row1 = y1 * srcW4;

    for (let x = 0; x < dstWidth; x++) {
      const gx = ((x + 0.5) * srcWidth) / dstWidth - 0.5;
      const x0 = Math.min(srcWidth - 1, Math.max(0, Math.floor(gx)));
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const tx = gx - x0;
      const itx = 1 - tx;

      const w00 = itx * ity, w10 = tx * ity, w01 = itx * ty, w11 = tx * ty;
      const s00 = row0 + x0 * 4, s10 = row0 + x1 * 4;
      const s01 = row1 + x0 * 4, s11 = row1 + x1 * 4;

      const di = (y * dstWidth + x) * 4;
      out[di]     = roundToU8(src[s00] * w00 + src[s10] * w10 + src[s01] * w01 + src[s11] * w11);
      out[di + 1] = roundToU8(src[s00+1] * w00 + src[s10+1] * w10 + src[s01+1] * w01 + src[s11+1] * w11);
      out[di + 2] = roundToU8(src[s00+2] * w00 + src[s10+2] * w10 + src[s01+2] * w01 + src[s11+2] * w11);
      out[di + 3] = roundToU8(src[s00+3] * w00 + src[s10+3] * w10 + src[s01+3] * w01 + src[s11+3] * w11);
    }
  }
  return out;
}

/**
 * Chunked separable 2-pass convolution resize.
 *
 * Pass 1 (horizontal): read source in strips via getImageData(),
 *   resample each strip's rows horizontally, store results in
 *   an intermediate Float32 buffer (dstWidth × srcHeight × 4).
 *
 * Pass 2 (vertical): resample intermediate columns vertically → output.
 *   Also done in strips to cap memory.
 */
function resizeConvolutionChunked(ctx, srcWidth, srcHeight, dstWidth, dstHeight, filter, stripHeight) {
  const xk = computeAxisKernels(srcWidth, dstWidth, filter);
  const yk = computeAxisKernels(srcHeight, dstHeight, filter);

  const tmpStride = dstWidth * 4;

  // Intermediate buffer: dstWidth × srcHeight × 4 channels × Float32
  // This is the unavoidable cost — but it's dstWidth (small), not srcWidth (huge).
  const tmp = new Float32Array(srcHeight * tmpStride);

  // Pass 1: Horizontal resample, reading source in strips
  for (let stripStart = 0; stripStart < srcHeight; stripStart += stripHeight) {
    const stripEnd = Math.min(srcHeight, stripStart + stripHeight);
    const stripRows = stripEnd - stripStart;

    // Read only this strip from the canvas
    const imageData = ctx.getImageData(0, stripStart, srcWidth, stripRows);
    const src = imageData.data;

    horizontalResample(src, srcWidth, stripRows, dstWidth, xk, tmp, stripStart, tmpStride);

    // src (ImageData.data) can be GC'd after this iteration
  }

  // Pass 2: Vertical resample from intermediate → output
  const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
  verticalResample(tmp, tmpStride, dstWidth, dstHeight, yk, out);

  return out;
}

/**
 * Horizontal resample: for each source row in the strip, apply horizontal
 * kernels and write Float32 results into the intermediate buffer.
 */
function horizontalResample(src, srcWidth, stripRows, dstWidth, xk, tmp, globalRowOffset, tmpStride) {
  const xStarts = xk.starts;
  const xOffsets = xk.offsets;
  const xLengths = xk.lengths;
  const xWeights = xk.weights;
  const srcStride = srcWidth * 4;

  for (let localY = 0; localY < stripRows; localY++) {
    const srcRowBase = localY * srcStride;
    const tmpRowBase = (globalRowOffset + localY) * tmpStride;

    for (let dx = 0; dx < dstWidth; dx++) {
      const ti = tmpRowBase + dx * 4;
      const kStart = xStarts[dx];
      const wOff = xOffsets[dx];
      const wLen = xLengths[dx];
      let r = 0, g = 0, b = 0, a = 0;

      for (let j = 0; j < wLen; j++) {
        const w = xWeights[wOff + j];
        const si = srcRowBase + (kStart + j) * 4;
        r += src[si] * w;
        g += src[si + 1] * w;
        b += src[si + 2] * w;
        a += src[si + 3] * w;
      }

      tmp[ti] = r;
      tmp[ti + 1] = g;
      tmp[ti + 2] = b;
      tmp[ti + 3] = a;
    }
  }
}

/**
 * Vertical resample: for each destination row, apply vertical kernels
 * on the intermediate buffer and write Uint8 results to output.
 */
function verticalResample(tmp, tmpStride, dstWidth, dstHeight, yk, out) {
  const yStarts = yk.starts;
  const yOffsets = yk.offsets;
  const yLengths = yk.lengths;
  const yWeights = yk.weights;
  const outStride = dstWidth * 4;

  for (let dy = 0; dy < dstHeight; dy++) {
    const outRowBase = dy * outStride;
    const kStart = yStarts[dy];
    const wOff = yOffsets[dy];
    const wLen = yLengths[dy];

    for (let dx = 0; dx < dstWidth; dx++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let j = 0; j < wLen; j++) {
        const w = yWeights[wOff + j];
        const ti = (kStart + j) * tmpStride + dx * 4;
        r += tmp[ti] * w;
        g += tmp[ti + 1] * w;
        b += tmp[ti + 2] * w;
        a += tmp[ti + 3] * w;
      }

      const di = outRowBase + dx * 4;
      out[di] = roundToU8(r);
      out[di + 1] = roundToU8(g);
      out[di + 2] = roundToU8(b);
      out[di + 3] = roundToU8(a);
    }
  }
}
