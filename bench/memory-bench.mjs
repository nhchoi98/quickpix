import { QuickPix } from "../js/src/index.js";
import PicaFactory from "pica";

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function forceGc() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
}

function snap() {
  forceGc();
  return process.memoryUsage();
}

function diffSnap(before, after) {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function totalUsed(m) {
  return m.heapUsed + m.external;
}

function fillRandom(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

const FILTER_MAP = {
  bilinear: "lanczos2",
  box: "box",
  hamming: "hamming",
  lanczos: "lanczos3",
};

const SCENARIOS = [
  { name: "640x480 → 320x240", srcW: 640, srcH: 480, dstW: 320, dstH: 240 },
  { name: "1920x1080 → 960x540", srcW: 1920, srcH: 1080, dstW: 960, dstH: 540 },
  { name: "4000x3000 → 2000x1500", srcW: 4000, srcH: 3000, dstW: 2000, dstH: 1500 },
  { name: "6000x4000 → 3000x2000", srcW: 6000, srcH: 4000, dstW: 3000, dstH: 2000 },
  { name: "6000x4000 → 600x400", srcW: 6000, srcH: 4000, dstW: 600, dstH: 400 },
];

const FILTERS = ["bilinear", "box", "lanczos"];

async function measureQuickPix(src, scenario, filter, iters) {
  const qp = new QuickPix({ forceFallback: true });

  // warmup
  await qp.resizeBuffer(src, scenario.srcW, scenario.srcH, scenario.dstW, scenario.dstH, { filter });
  await new Promise((r) => setTimeout(r, 30));

  const before = snap();

  const snapshots = [];
  for (let i = 0; i < iters; i += 1) {
    await qp.resizeBuffer(src, scenario.srcW, scenario.srcH, scenario.dstW, scenario.dstH, { filter });
    snapshots.push(process.memoryUsage());
  }

  const peak = snapshots.reduce(
    (max, m) => ({
      heapUsed: Math.max(max.heapUsed, m.heapUsed),
      external: Math.max(max.external, m.external),
      arrayBuffers: Math.max(max.arrayBuffers, m.arrayBuffers),
      rss: Math.max(max.rss, m.rss),
    }),
    { heapUsed: 0, external: 0, arrayBuffers: 0, rss: 0 }
  );

  const afterGc = snap();

  return {
    before,
    peak,
    afterGc,
    peakDelta: diffSnap(before, peak),
    retained: diffSnap(before, afterGc),
    peakTotal: totalUsed(peak) - totalUsed(before),
  };
}

async function measurePica(src, scenario, filter, iters) {
  const picaFilter = FILTER_MAP[filter] || "lanczos2";
  const pica = new PicaFactory({ features: ["js"], concurrency: 1 });

  // warmup
  await pica.resizeBuffer({
    src,
    width: scenario.srcW,
    height: scenario.srcH,
    toWidth: scenario.dstW,
    toHeight: scenario.dstH,
    filter: picaFilter,
  });
  await new Promise((r) => setTimeout(r, 30));

  const before = snap();

  const snapshots = [];
  for (let i = 0; i < iters; i += 1) {
    await pica.resizeBuffer({
      src,
      width: scenario.srcW,
      height: scenario.srcH,
      toWidth: scenario.dstW,
      toHeight: scenario.dstH,
      filter: picaFilter,
    });
    snapshots.push(process.memoryUsage());
  }

  const peak = snapshots.reduce(
    (max, m) => ({
      heapUsed: Math.max(max.heapUsed, m.heapUsed),
      external: Math.max(max.external, m.external),
      arrayBuffers: Math.max(max.arrayBuffers, m.arrayBuffers),
      rss: Math.max(max.rss, m.rss),
    }),
    { heapUsed: 0, external: 0, arrayBuffers: 0, rss: 0 }
  );

  const afterGc = snap();

  return {
    before,
    peak,
    afterGc,
    peakDelta: diffSnap(before, peak),
    retained: diffSnap(before, afterGc),
    peakTotal: totalUsed(peak) - totalUsed(before),
  };
}

function printCompare(label, qpVal, picaVal, unit) {
  const ratio = picaVal === 0 ? "n/a" : (qpVal / picaVal).toFixed(2) + "x";
  const winner = qpVal < picaVal ? "quickpix" : qpVal > picaVal ? "pica" : "tie";
  console.log(
    `  ${label.padEnd(18)} quickpix=${(formatMB(qpVal)).padStart(10)}  pica=${(formatMB(picaVal)).padStart(10)}  ratio=${ratio.padStart(7)}  (${winner})`
  );
}

(async () => {
  const hasGc = typeof global.gc === "function";
  if (!hasGc) {
    console.warn("⚠  Run with --expose-gc for accurate measurements:");
    console.warn("   node --expose-gc ./bench/memory-bench.mjs\n");
  }

  const ITERS = 3;

  console.log(`=== quickpix vs pica — Memory Comparison (${ITERS} iters, no intermediate GC) ===\n`);

  for (const filter of FILTERS) {
    const picaFilter = FILTER_MAP[filter] || "lanczos2";
    console.log(`[filter: quickpix=${filter}, pica=${picaFilter}]`);

    for (const scenario of SCENARIOS) {
      const src = fillRandom(scenario.srcW, scenario.srcH);
      const srcMB = formatMB(src.byteLength);
      const dstMB = formatMB(scenario.dstW * scenario.dstH * 4);

      console.log(`\n  ${scenario.name}  (src=${srcMB}, dst=${dstMB})`);

      const qp = await measureQuickPix(src, scenario, filter, ITERS);
      const pica = await measurePica(src, scenario, filter, ITERS);

      printCompare("peak heapUsed", qp.peakDelta.heapUsed, pica.peakDelta.heapUsed);
      printCompare("peak external", qp.peakDelta.external, pica.peakDelta.external);
      printCompare("peak total", qp.peakTotal, pica.peakTotal);
      printCompare("retained heap", qp.retained.heapUsed, pica.retained.heapUsed);
      printCompare("retained ext", qp.retained.external, pica.retained.external);

      const qpRetainTotal = qp.retained.heapUsed + qp.retained.external;
      const picaRetainTotal = pica.retained.heapUsed + pica.retained.external;
      printCompare("retained total", qpRetainTotal, picaRetainTotal);
    }
    console.log("\n" + "─".repeat(100) + "\n");
  }

  console.log("=== Summary Legend ===");
  console.log("  peak       = max memory increase during resize (higher = more temp allocations)");
  console.log("  retained   = memory still held after GC (should be ~dst buffer only, else leak)");
  console.log("  ratio      = quickpix / pica (< 1x = quickpix uses less memory)");
})();
