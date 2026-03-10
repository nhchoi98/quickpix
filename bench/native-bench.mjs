import { performance } from "node:perf_hooks";
import { QuickPix } from "../js/src/index.js";
import sharpFactory from "sharp";

function fillRandom(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

function formatMs(ms) {
  return ms.toFixed(2) + "ms";
}

function formatMpix(mpix) {
  return mpix.toFixed(2) + " Mpix/s";
}

// sharp kernel mapping
const SHARP_KERNEL = {
  nearest: "nearest",
  bilinear: "cubic",    // sharp has no bilinear; cubic is closest
  box: "cubic",         // no box in sharp
  hamming: "cubic",     // no hamming in sharp
  lanczos: "lanczos3",
};

const SHARP_LABEL = {
  nearest: "nearest",
  bilinear: "cubic (approx)",
  box: "cubic (approx)",
  hamming: "cubic (approx)",
  lanczos: "lanczos3 (exact)",
};

const SCENARIOS = [
  { name: "1k", srcW: 640, srcH: 480, dstW: 320, dstH: 240 },
  { name: "HD", srcW: 1920, srcH: 1080, dstW: 960, dstH: 540 },
  { name: "4k", srcW: 3840, srcH: 2160, dstW: 1920, dstH: 1080 },
  { name: "12MP", srcW: 4000, srcH: 3000, dstW: 2000, dstH: 1500 },
  { name: "24MP", srcW: 6000, srcH: 4000, dstW: 3000, dstH: 2000 },
  { name: "24MP→thumb", srcW: 6000, srcH: 4000, dstW: 600, dstH: 400 },
];

const FILTERS = ["bilinear", "lanczos"];

function getIters(area) {
  if (area >= 20_000_000) return 2;
  if (area >= 8_000_000) return 3;
  if (area >= 3_000_000) return 5;
  return 10;
}

async function benchQuickPix(src, scenario, filter, iters) {
  const qp = new QuickPix({ forceFallback: true });

  // warmup
  await qp.resizeBuffer(src, scenario.srcW, scenario.srcH, scenario.dstW, scenario.dstH, { filter });

  const start = performance.now();
  for (let i = 0; i < iters; i += 1) {
    await qp.resizeBuffer(src, scenario.srcW, scenario.srcH, scenario.dstW, scenario.dstH, { filter });
  }
  return (performance.now() - start) / iters;
}

async function benchQuickPixWasm(src, scenario, filter, iters) {
  const qp = new QuickPix({ useWasm: true });

  // warmup
  await qp.resizeBuffer(src, scenario.srcW, scenario.srcH, scenario.dstW, scenario.dstH, { filter });

  const start = performance.now();
  for (let i = 0; i < iters; i += 1) {
    await qp.resizeBuffer(src, scenario.srcW, scenario.srcH, scenario.dstW, scenario.dstH, { filter });
  }
  const stats = qp.getStats();
  return { ms: (performance.now() - start) / iters, wasmHits: stats.wasmHits };
}

async function benchSharp(src, scenario, filter, iters) {
  const kernel = SHARP_KERNEL[filter] || "lanczos3";
  const buf = Buffer.from(src.buffer, src.byteOffset, src.byteLength);

  // warmup
  await sharpFactory(buf, { raw: { width: scenario.srcW, height: scenario.srcH, channels: 4 } })
    .resize(scenario.dstW, scenario.dstH, { kernel, fit: "fill" })
    .raw()
    .toBuffer();

  const start = performance.now();
  for (let i = 0; i < iters; i += 1) {
    await sharpFactory(buf, { raw: { width: scenario.srcW, height: scenario.srcH, channels: 4 } })
      .resize(scenario.dstW, scenario.dstH, { kernel, fit: "fill" })
      .raw()
      .toBuffer();
  }
  return (performance.now() - start) / iters;
}

function bar(ratio, width = 30) {
  const filled = Math.min(width, Math.round(ratio * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

(async () => {
  console.log("=== quickpix vs sharp (libvips/C native) — Speed Comparison ===\n");
  console.log("sharp uses libvips (highly optimized C/C++ with SIMD).");
  console.log("This shows where JS/WASM stands against native code.\n");

  for (const filter of FILTERS) {
    const sharpLabel = SHARP_LABEL[filter];
    console.log(`━━━ filter: quickpix=${filter}, sharp=${sharpLabel} ━━━\n`);

    for (const scenario of SCENARIOS) {
      const area = scenario.srcW * scenario.srcH;
      const iters = getIters(area);
      const mpix = area / 1_000_000;
      const src = fillRandom(scenario.srcW, scenario.srcH);

      const sharpMs = await benchSharp(src, scenario, filter, iters);
      const qpFallbackMs = await benchQuickPix(src, scenario, filter, iters);
      const qpWasm = await benchQuickPixWasm(src, scenario, filter, iters);
      const qpWasmMs = qpWasm.ms;

      const sharpTpt = mpix / (sharpMs / 1000);
      const qpFbTpt = mpix / (qpFallbackMs / 1000);
      const qpWasmTpt = mpix / (qpWasmMs / 1000);

      const ratioFb = qpFallbackMs / sharpMs;
      const ratioWasm = qpWasmMs / sharpMs;

      // Normalize bar to sharp=1.0 (shorter is better)
      const maxMs = Math.max(sharpMs, qpFallbackMs, qpWasmMs);

      console.log(`  [${scenario.name}] ${scenario.srcW}x${scenario.srcH} → ${scenario.dstW}x${scenario.dstH}  (${iters} iters)`);
      console.log(`    sharp        ${bar(sharpMs / maxMs)}  ${formatMs(sharpMs).padStart(10)}  ${formatMpix(sharpTpt).padStart(14)}`);
      console.log(`    qp(fallback) ${bar(qpFallbackMs / maxMs)}  ${formatMs(qpFallbackMs).padStart(10)}  ${formatMpix(qpFbTpt).padStart(14)}  ${ratioFb.toFixed(2)}x vs sharp`);
      console.log(`    qp(auto)     ${bar(qpWasmMs / maxMs)}  ${formatMs(qpWasmMs).padStart(10)}  ${formatMpix(qpWasmTpt).padStart(14)}  ${ratioWasm.toFixed(2)}x vs sharp`);
      console.log();
    }
  }

  console.log("━━━ Legend ━━━");
  console.log("  bar length = relative time (shorter = faster)");
  console.log("  Nx vs sharp: <1x = faster than sharp, >1x = slower than sharp");
  console.log("  sharp = libvips (C/C++ native, SIMD optimized)");
  console.log("  qp(fallback) = quickpix JS-only path");
  console.log("  qp(auto) = quickpix with WASM when beneficial, else JS fallback");
})();
