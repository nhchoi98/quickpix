import { performance } from "node:perf_hooks";
import { QuickPix } from "../js/src/index.js";
import PicaFactory from "pica";

function parseArg(name, fallback = null) {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function parseExtensions(value) {
  if (!value) {
    return ["raw"];
  }
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .map((item) => (item === "jpg" ? "jpeg" : item))
    .filter(Boolean);
}

function normalizeExtension(ext) {
  if (!ext) {
    return "raw";
  }
  const lower = String(ext).toLowerCase();
  return lower === "jpg" ? "jpeg" : lower;
}

function percent(value, total) {
  return total === 0 ? 0 : (value / total) * 100;
}

function toTimeRatio(fasterIsQP, baselineMs, challengerMs) {
  if (baselineMs === 0 && challengerMs === 0) {
    return { ratio: 0, display: "n/a" };
  }
  if (baselineMs === 0) {
    return { ratio: Infinity, display: "0x?" };
  }
  if (challengerMs === 0) {
    return { ratio: 0, display: "∞" };
  }

  const ratio = challengerMs / baselineMs;
  return {
    ratio,
    display: `${ratio.toFixed(2)}x`,
  };
}

function getIterationsByArea(area) {
  if (area >= 20_000_000) return 1;
  if (area >= 8_000_000) return 2;
  if (area >= 3_000_000) return 4;
  return 12;
}

function fillRandom(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

const FILTER_MAPPING = {
  nearest: { pica: "box", exact: false, note: "pica has no nearest filter; mapped to box as nearest-like fallback" },
  bilinear: { pica: "lanczos2", exact: false, note: "no bilinear kernel in pica; mapped to lanczos2 for closest high-speed filter family" },
  box: { pica: "box", exact: true, note: "exact match" },
  hamming: { pica: "hamming", exact: true, note: "exact match" },
  lanczos: { pica: "lanczos3", exact: true, note: "exact match (pica lanczos3)" },
  lanczos3: { pica: "lanczos3", exact: true, note: "exact match" },
};

function mapFilterForPica(filter) {
  const normalized = String(filter || "bilinear").toLowerCase().replace(/[-_]/g, "");
  const mapped = FILTER_MAPPING[normalized];
  return mapped ? mapped.pica : "lanczos2";
}

function getFilterMapping(filter) {
  const normalized = String(filter || "bilinear").toLowerCase().replace(/[-_]/g, "");
  return FILTER_MAPPING[normalized] || {
    pica: mapFilterForPica(normalized),
    exact: false,
    note: "no explicit mapping; fallback to lanczos2",
  };
}

const sourceCache = new Map();
function getSource(width, height) {
  const key = `${width}x${height}`;
  if (!sourceCache.has(key)) {
    sourceCache.set(key, fillRandom(width, height));
  }
  return sourceCache.get(key);
}

let sharpModule = null;
let sharpError = null;

async function getSharpModule() {
  if (sharpModule) {
    return sharpModule;
  }
  if (sharpError) {
    throw sharpError;
  }

  try {
    const loaded = await import("sharp");
    sharpModule = loaded?.default || loaded;
    return sharpModule;
  } catch (error) {
    sharpError = new Error(
      "extension benchmarks need optional dependency 'sharp'. Install with `npm i -D sharp`.",
    );
    sharpError.cause = error;
    throw sharpError;
  }
}

async function encodeCodec(ext, source, width, height) {
  const sharp = await getSharpModule();
  const image = sharp(Buffer.from(source), {
    raw: { width, height, channels: 4 },
  });

  if (ext === "png") {
    return image.png({ compressionLevel: 6 }).toBuffer();
  }
  if (ext === "jpeg") {
    return image.jpeg({ quality: 86 }).toBuffer();
  }
  if (ext === "webp") {
    return image.webp({ quality: 80 }).toBuffer();
  }
  if (ext === "avif") {
    return image.avif({ quality: 45 }).toBuffer();
  }

  throw new Error(`unsupported codec: ${ext}`);
}

async function decodeCodec(ext, encoded) {
  const sharp = await getSharpModule();
  const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer();
  return new Uint8ClampedArray(decoded);
}

async function prepareSource(ext, width, height) {
  const source = getSource(width, height);

  if (ext === "raw") {
    return {
      source,
      inputBytes: source.byteLength,
      decodeMs: 0,
      encodeInMs: 0,
      codec: "raw",
    };
  }

  const encodeInStart = performance.now();
  const encoded = await encodeCodec(ext, source, width, height);
  const encodeInMs = performance.now() - encodeInStart;

  const decodeStart = performance.now();
  const decoded = await decodeCodec(ext, encoded);
  const decodeMs = performance.now() - decodeStart;

  return {
    source: decoded,
    inputBytes: encoded.byteLength,
    decodeMs,
    encodeInMs,
    codec: ext,
  };
}

async function saveOutput(ext, outData, dstW, dstH) {
  if (ext === "raw") {
    return {
      bytes: outData.byteLength,
      encodeMs: 0,
      codec: "raw",
    };
  }

  const start = performance.now();
  const encoded = await encodeCodec(ext, outData, dstW, dstH);
  return {
    bytes: encoded.byteLength,
    encodeMs: performance.now() - start,
    codec: ext,
  };
}

async function runQuickPix(scenario) {
  const pica = new QuickPix({
    useWasm: !scenario.forceWasmOff,
    forceFallback: scenario.forceWasmOff,
    filter: scenario.filter,
    tileSize: scenario.tileSize,
    concurrency: 1,
  });

  const stats = {
    resizeMs: 0,
    decodeMs: 0,
    encodeInMs: 0,
    encodeOutMs: 0,
    inBytes: 0,
    outBytes: 0,
  };

  for (let i = 0; i < scenario.iterations; i += 1) {
    const prepared = await prepareSource(scenario.extension, scenario.srcW, scenario.srcH);
    stats.decodeMs += prepared.decodeMs;
    stats.encodeInMs += prepared.encodeInMs;
    stats.inBytes += prepared.inputBytes;

    const start = performance.now();
    const out = await pica.resizeBuffer(
      prepared.source,
      scenario.srcW,
      scenario.srcH,
      scenario.dstW,
      scenario.dstH,
      {
        filter: scenario.filter,
        tileSize: scenario.tileSize,
      },
    );
    stats.resizeMs += performance.now() - start;

    const encoded = await saveOutput(
      scenario.extension,
      out.data,
      scenario.dstW,
      scenario.dstH,
    );
    stats.encodeOutMs += encoded.encodeMs;
    stats.outBytes += encoded.bytes;
  }

  const totalMs = stats.resizeMs + stats.decodeMs + stats.encodeInMs + stats.encodeOutMs;
  const mpix = (scenario.srcW * scenario.srcH * scenario.iterations) / 1_000_000;
  const resizeThroughput = mpix / (stats.resizeMs / 1000);
  const totalThroughput = mpix / (totalMs / 1000);

  return {
    ...stats,
    totalMs,
    resizeThroughput,
    totalThroughput,
    source: `${scenario.srcW}x${scenario.srcH}`,
    method: `quickpix(${scenario.forceWasmOff ? "fallback" : "auto"})`,
  };
}

async function runPica(scenario) {
  const features = scenario.forceWasmOff
    ? ["js"]
    : ["js", "wasm", "ww"];

  const pica = new PicaFactory({
    concurrency: 1,
    features,
    tile: scenario.tileSize || 0,
  });

  const stats = {
    resizeMs: 0,
    decodeMs: 0,
    encodeInMs: 0,
    encodeOutMs: 0,
    inBytes: 0,
    outBytes: 0,
  };

  for (let i = 0; i < scenario.iterations; i += 1) {
    const prepared = await prepareSource(scenario.extension, scenario.srcW, scenario.srcH);
    stats.decodeMs += prepared.decodeMs;
    stats.encodeInMs += prepared.encodeInMs;
    stats.inBytes += prepared.inputBytes;

    const start = performance.now();
    const out = await pica.resizeBuffer({
      src: prepared.source,
      width: scenario.srcW,
      height: scenario.srcH,
      toWidth: scenario.dstW,
      toHeight: scenario.dstH,
      filter: mapFilterForPica(scenario.filter),
    });
    stats.resizeMs += performance.now() - start;

    const encoded = await saveOutput(
      scenario.extension,
      out,
      scenario.dstW,
      scenario.dstH,
    );
    stats.encodeOutMs += encoded.encodeMs;
    stats.outBytes += encoded.bytes;
  }

  const totalMs = stats.resizeMs + stats.decodeMs + stats.encodeInMs + stats.encodeOutMs;
  const mpix = (scenario.srcW * scenario.srcH * scenario.iterations) / 1_000_000;
  const resizeThroughput = mpix / (stats.resizeMs / 1000);
  const totalThroughput = mpix / (totalMs / 1000);

  return {
    ...stats,
    totalMs,
    resizeThroughput,
    totalThroughput,
    source: `${scenario.srcW}x${scenario.srcH}`,
    method: `pica(${scenario.forceWasmOff ? "js-only" : "auto"})`,
  };
}

const BASE = [
  {
    name: "auto-possible",
    filter: "bilinear",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: false,
    extensions: ["raw"],
  },
  {
    name: "auto-box",
    filter: "box",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: false,
    extensions: ["raw"],
  },
  {
    name: "fallback-box",
    filter: "box",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: true,
    extensions: ["raw"],
  },
  {
    name: "auto-hamming",
    filter: "hamming",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: false,
    extensions: ["raw"],
  },
  {
    name: "auto-lanczos",
    filter: "lanczos",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: false,
    extensions: ["raw"],
  },
  {
    name: "fallback-nearest",
    filter: "nearest",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: true,
    extensions: ["raw"],
  },
  {
    name: "fallback-bilinear",
    filter: "bilinear",
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    forceWasmOff: true,
    extensions: ["raw"],
  },
  {
    name: "auto-bilinear-24m",
    filter: "bilinear",
    srcW: 6000,
    srcH: 4000,
    dstW: 3000,
    dstH: 2000,
    forceWasmOff: false,
    iterations: 1,
    extensions: ["raw", "jpeg"],
  },
  {
    name: "fallback-bilinear-24m",
    filter: "bilinear",
    srcW: 6000,
    srcH: 4000,
    dstW: 3000,
    dstH: 2000,
    forceWasmOff: true,
    iterations: 1,
    extensions: ["raw", "jpeg"],
  },
];

function buildMatrix(base, enabledExtensions) {
  const matrix = [];
  const extensionSet = new Set((enabledExtensions || ["raw"]).map(normalizeExtension));

  for (const row of base) {
    const candidates = (row.extensions || ["raw"]).map(normalizeExtension);
    const active = candidates.filter((ext) => extensionSet.has(ext));
    if (active.length === 0) {
      continue;
    }

    const iterations = row.iterations ?? getIterationsByArea(row.srcW * row.srcH);

    for (const ext of active) {
      matrix.push({
        ...row,
        iterations,
        extension: ext,
      });
    }
  }

  return matrix;
}

(async () => {
  const extArg = parseArg("extensions", process.env.BENCH_EXTENSIONS || "raw");
  const extensions = parseExtensions(extArg);
  const strictExactOnly = hasArg("strict-filter");
  const matrix = buildMatrix(BASE, extensions);
  const skipped = [];

  for (const scenario of matrix) {
    const scenarioName = `${scenario.name}-${scenario.extension}`;
    const mapping = getFilterMapping(scenario.filter);
    if (strictExactOnly && !mapping.exact) {
      skipped.push(`${scenarioName}: skipped (non-exact filter mapping)`);
      continue;
    }
    try {
      const qp = await runQuickPix(scenario);
      const pjs = await runPica(scenario);
      const ratio = qp.resizeThroughput === 0 ? 0 : pjs.resizeThroughput / qp.resizeThroughput;
      const ratioTotal =
        qp.totalThroughput === 0 ? 0 : pjs.totalThroughput / qp.totalThroughput;
      const speedWin =
        ratio === 0 ? "n/a" : ratio > 1 ? "pica" : ratio < 1 ? "quickpix" : "tie";
      const label = mapping.exact ? "exact" : "approx";
      const qpDecodePct = percent(qp.decodeMs, qp.totalMs);
      const qpEncodeInPct = percent(qp.encodeInMs, qp.totalMs);
      const qpResizePct = percent(qp.resizeMs, qp.totalMs);
      const qpEncodeOutPct = percent(qp.encodeOutMs, qp.totalMs);
      const pjsDecodePct = percent(pjs.decodeMs, pjs.totalMs);
      const pjsEncodeInPct = percent(pjs.encodeInMs, pjs.totalMs);
      const pjsResizePct = percent(pjs.resizeMs, pjs.totalMs);
      const pjsEncodeOutPct = percent(pjs.encodeOutMs, pjs.totalMs);

      const decodeRatio = toTimeRatio(true, qp.decodeMs, pjs.decodeMs);
      const encodeInRatio = toTimeRatio(true, qp.encodeInMs, pjs.encodeInMs);
      const resizeRatio = toTimeRatio(true, qp.resizeMs, pjs.resizeMs);
      const encodeOutRatio = toTimeRatio(true, qp.encodeOutMs, pjs.encodeOutMs);

      const qpBottleneck =
        [
          { name: "decode", ms: qp.decodeMs },
          { name: "encodeIn", ms: qp.encodeInMs },
          { name: "resize", ms: qp.resizeMs },
          { name: "encodeOut", ms: qp.encodeOutMs },
        ].reduce((a, b) => (a.ms > b.ms ? a : b));
      const pjsBottleneck =
        [
          { name: "decode", ms: pjs.decodeMs },
          { name: "encodeIn", ms: pjs.encodeInMs },
          { name: "resize", ms: pjs.resizeMs },
          { name: "encodeOut", ms: pjs.encodeOutMs },
        ].reduce((a, b) => (a.ms > b.ms ? a : b));

      console.log(`
[${scenarioName}]`);
      console.log(
        `quickpix: resize=${qp.resizeMs.toFixed(2)}ms, total=${qp.totalMs.toFixed(
          2,
        )}ms, tpt=${qp.resizeThroughput.toFixed(2)}/${qp.totalThroughput.toFixed(2)} Mpix/s`,
      );
      console.log(
        `pica   : resize=${pjs.resizeMs.toFixed(2)}ms, total=${pjs.totalMs.toFixed(
          2,
        )}ms, tpt=${pjs.resizeThroughput.toFixed(2)}/${pjs.totalThroughput.toFixed(2)} Mpix/s`,
      );
      console.log(`ratio  : resize=${ratio.toFixed(2)}x, total=${ratioTotal.toFixed(2)}x (${speedWin})`);
      console.log(`phase  : quickpix decode/encIn/resize/encOut = ${qpDecodePct.toFixed(
        1,
      )}% / ${qpEncodeInPct.toFixed(1)}% / ${qpResizePct.toFixed(1)}% / ${qpEncodeOutPct.toFixed(
        1,
      )}%`);
      console.log(`phase  : pica    decode/encIn/resize/encOut = ${pjsDecodePct.toFixed(
        1,
      )}% / ${pjsEncodeInPct.toFixed(1)}% / ${pjsResizePct.toFixed(1)}% / ${pjsEncodeOutPct.toFixed(
        1,
      )}%`);
      console.log(
        `ratio  : decode=${decodeRatio.display}, encIn=${encodeInRatio.display}, resize=${resizeRatio.display}, encOut=${encodeOutRatio.display}`,
      );
      console.log(`bottleneck: quickpix=${qpBottleneck.name}, pica=${pjsBottleneck.name}`);
      console.log(
        `filter : quickpix=${scenario.filter}, pica=${mapping.pica} (${label}) => ${mapping.note}`,
      );
    } catch (error) {
      console.error(`bench failed: ${scenarioName} -> ${error.message}`);
    }
  }

  if (strictExactOnly && skipped.length > 0) {
    console.log("\nskipped (strict-filter):");
    skipped.forEach((line) => console.log(`- ${line}`));
  }
})();
