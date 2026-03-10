const FILTERS = {
  nearest: 0,
  bilinear: 1,
  box: 2,
  hamming: 3,
  lanczos2: 5,
  lanczos: 4,
};

const PI = Math.PI;
const SUPPORT = {
  nearest: 0,
  bilinear: 1,
  box: 0.5,
  hamming: 2,
  lanczos2: 2,
  lanczos: 3,
};

function roundToU8(v) {
  const r = (v + 0.5) | 0;
  return r <= 0 ? 0 : r >= 255 ? 255 : r;
}

function normalizeFilter(filter) {
  const raw = String(filter || "bilinear").toLowerCase().replace(/[-_]/g, "");
  if (FILTERS[raw] === 0) return "nearest";
  if (FILTERS[raw] === 1) return "bilinear";
  if (FILTERS[raw] === 2) return "box";
  if (FILTERS[raw] === 3) return "hamming";
  if (FILTERS[raw] === 5) return "lanczos2";
  if (FILTERS[raw] === 4) return "lanczos";

  if (raw === "lanczos3") return "lanczos";
  return "bilinear";
}

function normalizeTileSize(tileSize) {
  const v = Number(tileSize);
  return Number.isInteger(v) && v > 0 ? v : 0;
}

function sampleChannel(src, width, x, y, c) {
  const idx = (y * width + x) * 4 + c;
  return src[idx];
}

function sinc(v) {
  if (v === 0) {
    return 1;
  }
  const x = v * PI;
  return Math.sin(x) / x;
}

function filterKernel(filter, distance) {
  const x = Math.abs(distance);
  if (filter === "bilinear") {
    return x >= 1 ? 0 : 1 - x;
  }

  if (filter === "box") {
    return x <= 0.5 ? 1 : 0;
  }

  if (filter === "hamming") {
    if (x >= 2) {
      return 0;
    }
    return sinc(distance) * (0.54 + 0.46 * Math.cos((PI * distance) * 0.5));
  }

  if (filter === "lanczos2") {
    if (x >= 2) {
      return 0;
    }
    return sinc(distance) * sinc(distance / 2);
  }

  if (filter === "lanczos") {
    if (x >= 3) {
      return 0;
    }
    return sinc(distance) * sinc(distance / 3);
  }

  return 0;
}

/**
 * Pre-compute all kernels for one axis using flat contiguous storage.
 * Returns { starts: Uint32Array, offsets: Uint32Array, lengths: Uint16Array, weights: Float32Array }
 */
function computeAxisKernels(srcLen, dstLen, filter) {
  const scale = Math.max(1, srcLen / dstLen);
  const invScale = 1 / scale;
  const support = SUPPORT[filter] * scale;
  const maxKernelSize = Math.ceil(support * 2) + 2;

  const starts = new Uint32Array(dstLen);
  const offsets = new Uint32Array(dstLen);
  const lengths = new Uint16Array(dstLen);
  const allWeights = new Float32Array(dstLen * maxKernelSize);
  let weightPos = 0;

  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) * srcLen / dstLen - 0.5;
    const start = Math.max(0, Math.floor(center - support));
    const end = Math.min(srcLen - 1, Math.ceil(center + support));
    const len = end - start + 1;

    offsets[i] = weightPos;
    let sum = 0;

    for (let j = 0; j < len; j += 1) {
      const w = filterKernel(filter, (center - (start + j)) * invScale);
      allWeights[weightPos + j] = w;
      sum += w;
    }

    if (sum > 0) {
      const invSum = 1 / sum;
      for (let j = 0; j < len; j += 1) {
        allWeights[weightPos + j] *= invSum;
      }
      starts[i] = start;
      lengths[i] = len;
      weightPos += len;
    } else {
      const nearest = Math.min(srcLen - 1, Math.max(0, Math.round(center)));
      starts[i] = nearest;
      lengths[i] = 1;
      allWeights[weightPos] = 1;
      weightPos += 1;
    }
  }

  return {
    starts,
    offsets,
    lengths,
    weights: allWeights.subarray(0, weightPos),
  };
}

function resizeNearestCore(
  src,
  srcWidth,
  srcHeight,
  dst,
  dstWidth,
  dstHeight,
  yStart,
  yEnd
) {
  for (let y = yStart; y < yEnd; y += 1) {
    const sy = Math.min(
      srcHeight - 1,
      Math.max(0, Math.round(((y + 0.5) * srcHeight) / dstHeight - 0.5))
    );
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = Math.min(
        srcWidth - 1,
        Math.max(0, Math.round(((x + 0.5) * srcWidth) / dstWidth - 0.5))
      );
      const si = (sy * srcWidth + sx) * 4;
      const di = ((y - yStart) * dstWidth + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

function resizeBilinearCore(
  src,
  srcWidth,
  srcHeight,
  dst,
  dstWidth,
  dstHeight,
  yStart,
  yEnd
) {
  const srcW4 = srcWidth * 4;
  for (let y = yStart; y < yEnd; y += 1) {
    const gy = ((y + 0.5) * srcHeight) / dstHeight - 0.5;
    const y0 = Math.min(srcHeight - 1, Math.max(0, Math.floor(gy)));
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const ty = gy - y0;
    const ity = 1 - ty;
    const row0 = y0 * srcW4;
    const row1 = y1 * srcW4;

    for (let x = 0; x < dstWidth; x += 1) {
      const gx = ((x + 0.5) * srcWidth) / dstWidth - 0.5;
      const x0 = Math.min(srcWidth - 1, Math.max(0, Math.floor(gx)));
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const tx = gx - x0;
      const itx = 1 - tx;

      const w00 = itx * ity;
      const w10 = tx * ity;
      const w01 = itx * ty;
      const w11 = tx * ty;

      const s00 = row0 + x0 * 4;
      const s10 = row0 + x1 * 4;
      const s01 = row1 + x0 * 4;
      const s11 = row1 + x1 * 4;

      const di = ((y - yStart) * dstWidth + x) * 4;
      dst[di]     = roundToU8(src[s00] * w00 + src[s10] * w10 + src[s01] * w01 + src[s11] * w11);
      dst[di + 1] = roundToU8(src[s00 + 1] * w00 + src[s10 + 1] * w10 + src[s01 + 1] * w01 + src[s11 + 1] * w11);
      dst[di + 2] = roundToU8(src[s00 + 2] * w00 + src[s10 + 2] * w10 + src[s01 + 2] * w01 + src[s11 + 2] * w11);
      dst[di + 3] = roundToU8(src[s00 + 3] * w00 + src[s10 + 3] * w10 + src[s01 + 3] * w01 + src[s11 + 3] * w11);
    }
  }
}

/**
 * Separable 2-pass convolution resize.
 * Pass 1: Horizontal resample src → tmp (Float32Array)
 * Pass 2: Vertical resample tmp → dst (Uint8ClampedArray)
 */
/**
 * Separable 2-pass convolution resize with strip-based memory management.
 * Instead of allocating one huge Float32Array for the entire source range,
 * splits the destination rows into strips so the intermediate buffer stays
 * within a bounded size (~8 MB). The buffer is allocated once and reused
 * across strips.
 */
function resizeConvolutionCore(
  src,
  srcWidth,
  srcHeight,
  dst,
  dstWidth,
  dstHeight,
  filter,
  yStart,
  yEnd
) {
  const xk = computeAxisKernels(srcWidth, dstWidth, filter);
  const yk = computeAxisKernels(srcHeight, dstHeight, filter);

  const tmpStride = dstWidth * 4;
  const bytesPerTmpRow = tmpStride * 4; // Float32 = 4 bytes per element

  // Find full source row range needed
  let fullYMin = srcHeight;
  let fullYMax = 0;
  for (let dy = yStart; dy < yEnd; dy += 1) {
    const ks = yk.starts[dy];
    const kl = yk.lengths[dy];
    if (ks < fullYMin) fullYMin = ks;
    const ke = ks + kl - 1;
    if (ke > fullYMax) fullYMax = ke;
  }
  if (fullYMin > fullYMax) {
    fullYMin = 0;
    fullYMax = 0;
  }

  const fullTmpRows = fullYMax - fullYMin + 1;
  const MAX_TMP_BYTES = 8 * 1024 * 1024;

  // If small enough, process in a single pass (no strip overhead)
  if (fullTmpRows * bytesPerTmpRow <= MAX_TMP_BYTES) {
    resizeConvolutionStrip(
      src, srcWidth, dst, dstWidth, tmpStride,
      xk, yk, yStart, yEnd, fullYMin, fullYMax,
      new Float32Array(fullTmpRows * tmpStride)
    );
    return;
  }

  // Strip-based processing: limit intermediate buffer size
  const maxTmpRows = Math.max(16, Math.floor(MAX_TMP_BYTES / bytesPerTmpRow));
  const tmp = new Float32Array(maxTmpRows * tmpStride);

  let stripStart = yStart;
  while (stripStart < yEnd) {
    // Greedily add dst rows until source range exceeds maxTmpRows
    let sMin = yk.starts[stripStart];
    let sMax = sMin + yk.lengths[stripStart] - 1;
    let stripEnd = stripStart + 1;

    while (stripEnd < yEnd) {
      const ns = yk.starts[stripEnd];
      const ne = ns + yk.lengths[stripEnd] - 1;
      const newMin = ns < sMin ? ns : sMin;
      const newMax = ne > sMax ? ne : sMax;
      if (newMax - newMin + 1 > maxTmpRows) break;
      sMin = newMin;
      sMax = newMax;
      stripEnd += 1;
    }

    resizeConvolutionStrip(
      src, srcWidth, dst, dstWidth, tmpStride,
      xk, yk, stripStart, stripEnd, sMin, sMax, tmp
    );
    stripStart = stripEnd;
  }
}

function resizeConvolutionStrip(
  src, srcWidth, dst, dstWidth, tmpStride,
  xk, yk, yStart, yEnd, tmpYMin, tmpYMax, tmp
) {
  const xStarts = xk.starts;
  const xOffsets = xk.offsets;
  const xLengths = xk.lengths;
  const xWeights = xk.weights;
  const yStarts = yk.starts;
  const yOffsets = yk.offsets;
  const yLengths = yk.lengths;
  const yWeights = yk.weights;

  // Pass 1: Horizontal — resample source rows [tmpYMin, tmpYMax] into tmp
  for (let sy = tmpYMin; sy <= tmpYMax; sy += 1) {
    const srcRowBase = sy * srcWidth * 4;
    const tmpRowBase = (sy - tmpYMin) * tmpStride;

    for (let dx = 0; dx < dstWidth; dx += 1) {
      const ti = tmpRowBase + dx * 4;
      const kStart = xStarts[dx];
      const wOff = xOffsets[dx];
      const wLen = xLengths[dx];
      let r = 0, g = 0, b = 0, a = 0;

      for (let j = 0; j < wLen; j += 1) {
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

  // Pass 2: Vertical — resample tmp columns into destination rows
  for (let dy = yStart; dy < yEnd; dy += 1) {
    const dstRowBase = (dy - yStart) * dstWidth * 4;
    const kStart = yStarts[dy];
    const wOff = yOffsets[dy];
    const wLen = yLengths[dy];

    for (let dx = 0; dx < dstWidth; dx += 1) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let j = 0; j < wLen; j += 1) {
        const w = yWeights[wOff + j];
        const ti = (kStart + j - tmpYMin) * tmpStride + dx * 4;
        r += tmp[ti] * w;
        g += tmp[ti + 1] * w;
        b += tmp[ti + 2] * w;
        a += tmp[ti + 3] * w;
      }

      const di = dstRowBase + dx * 4;
      dst[di] = roundToU8(r);
      dst[di + 1] = roundToU8(g);
      dst[di + 2] = roundToU8(b);
      dst[di + 3] = roundToU8(a);
    }
  }
}

function processRange(
  src,
  srcWidth,
  srcHeight,
  dstWidth,
  dstHeight,
  filter,
  rowStart,
  rowEnd
) {
  const yStart = Math.max(0, Math.min(dstHeight, rowStart));
  const yEnd = Math.max(yStart, Math.min(dstHeight, rowEnd));

  const rows = yEnd - yStart;
  const out = new Uint8ClampedArray(rows * dstWidth * 4);

  if (filter === "nearest") {
    resizeNearestCore(
      src,
      srcWidth,
      srcHeight,
      out,
      dstWidth,
      dstHeight,
      yStart,
      yEnd
    );
    return out;
  }

  if (filter === "bilinear") {
    resizeBilinearCore(
      src,
      srcWidth,
      srcHeight,
      out,
      dstWidth,
      dstHeight,
      yStart,
      yEnd
    );
    return out;
  }

  resizeConvolutionCore(
    src,
    srcWidth,
    srcHeight,
    out,
    dstWidth,
    dstHeight,
    filter,
    yStart,
    yEnd
  );

  return out;
}

export function resizeBufferFallbackRange(
  src,
  srcWidth,
  srcHeight,
  dstWidth,
  dstHeight,
  rowStart,
  rowEnd,
  filter = "bilinear",
  options = {}
) {
  const resolvedFilter = normalizeFilter(filter);
  const tileSize = normalizeTileSize(options.tileSize);
  const yStart = Math.max(0, Math.min(dstHeight, rowStart));
  const yEnd = Math.max(yStart, Math.min(dstHeight, rowEnd));

  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    throw new RangeError("Invalid dimensions");
  }
  if (src.length < srcWidth * srcHeight * 4) {
    throw new RangeError("source buffer too small");
  }

  const out = new Uint8ClampedArray((yEnd - yStart) * dstWidth * 4);
  if (tileSize <= 0) {
    return processRange(src, srcWidth, srcHeight, dstWidth, dstHeight, resolvedFilter, yStart, yEnd);
  }

  let offset = 0;
  for (let row = yStart; row < yEnd; row += tileSize) {
    const rowLimit = Math.min(yEnd, row + tileSize);
    const chunk = processRange(src, srcWidth, srcHeight, dstWidth, dstHeight, resolvedFilter, row, rowLimit);
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function resizeBufferFallback(
  src,
  srcWidth,
  srcHeight,
  dstWidth,
  dstHeight,
  filter = "bilinear",
  options = {}
) {
  if (!Number.isInteger(srcWidth) || !Number.isInteger(srcHeight)) {
    throw new TypeError("srcWidth/srcHeight must be integer");
  }
  if (!Number.isInteger(dstWidth) || !Number.isInteger(dstHeight)) {
    throw new TypeError("dstWidth/dstHeight must be integer");
  }
  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new RangeError("Invalid source size");
  }
  if (dstWidth <= 0 || dstHeight <= 0) {
    throw new RangeError("Invalid destination size");
  }
  if (src.length < srcWidth * srcHeight * 4) {
    throw new RangeError("source buffer too small");
  }

  return resizeBufferFallbackRange(
    src,
    srcWidth,
    srcHeight,
    dstWidth,
    dstHeight,
    0,
    dstHeight,
    filter,
    options
  );
}

export const FILTER_NAMES = {
  nearest: "nearest",
  bilinear: "bilinear",
  box: "box",
  hamming: "hamming",
  lanczos2: "lanczos2",
  lanczos: "lanczos",
};

// Exposed for chunked-resize pipeline
export { computeAxisKernels, normalizeFilter, roundToU8 };
