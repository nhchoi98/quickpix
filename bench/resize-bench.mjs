import { performance } from "node:perf_hooks";
import { QuickPix } from "../js/src/index.js";

function parseArg(name, fallback = null) {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return fallback;
}

function parseExtensionArg(value) {
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
  if (typeof ext !== "string" || !ext.trim()) {
    return "raw";
  }
  const lower = ext.toLowerCase();
  return lower === "jpg" ? "jpeg" : lower;
}

function getIterationsByArea(area) {
  if (area >= 20_000_000) {
    return 1;
  }
  if (area >= 8_000_000) {
    return 2;
  }
  if (area >= 3_000_000) {
    return 4;
  }
  return 12;
}

function fillRandom(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

const sourceCache = new Map();
function getBaseSource(width, height) {
  const key = `${width}x${height}`;
  if (!sourceCache.has(key)) {
    sourceCache.set(key, fillRandom(width, height));
  }
  return sourceCache.get(key);
}

let sharpModule = null;
let sharpLoadError = null;

async function getSharpModule() {
  if (sharpModule) {
    return sharpModule;
  }
  if (sharpLoadError) {
    throw sharpLoadError;
  }

  try {
    const loaded = await import("sharp");
    sharpModule = loaded?.default || loaded;
    return sharpModule;
  } catch (error) {
    sharpLoadError = new Error(
      "extension benchmarks need optional dependency 'sharp'. Install with `npm i -D sharp`.",
    );
    sharpLoadError.cause = error;
    throw sharpLoadError;
  }
}

async function encodeExtension(ext, source, width, height) {
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

async function decodeExtension(ext, buffer) {
  const sharp = await getSharpModule();
  const decoded = await sharp(buffer).ensureAlpha().raw().toBuffer();
  return {
    data: new Uint8ClampedArray(decoded),
  };
}

async function loadWithCodec(ext, width, height) {
  const source = getBaseSource(width, height);

  if (ext === "raw") {
    return {
      source,
      decodeMs: 0,
      encodeMs: 0,
      ioBytes: source.byteLength,
      codec: "raw",
    };
  }

  const encodeStart = performance.now();
  const encoded = await encodeExtension(ext, source, width, height);
  const encodeMs = performance.now() - encodeStart;

  const decodeStart = performance.now();
  const decoded = await decodeExtension(ext, encoded);
  const decodeMs = performance.now() - decodeStart;

  return {
    source: decoded.data,
    decodeMs,
    encodeMs,
    ioBytes: encoded.byteLength,
    codec: ext,
  };
}

async function saveWithCodec(ext, data, width, height) {
  if (ext === "raw") {
    return data.byteLength;
  }

  const encodeStart = performance.now();
  const encoded = await encodeExtension(ext, data, width, height);
  const encodeMs = performance.now() - encodeStart;
  return { bytes: encoded.byteLength, encodeMs };
}

async function runScenario(name, scenario) {
  const pica = new QuickPix({
    useWasm: !!scenario.useWasm,
    forceFallback: !!scenario.forceFallback,
    filter: scenario.filter,
  });

  let resizeMsTotal = 0;
  let decodeMsTotal = 0;
  let encodeMsInputTotal = 0;
  let encodeMsOutputTotal = 0;
  let inputBytes = 0;
  let outputBytes = 0;

  for (let i = 0; i < scenario.iterations; i += 1) {
    const prepared = await loadWithCodec(
      scenario.extension,
      scenario.srcW,
      scenario.srcH,
    );

    decodeMsTotal += prepared.decodeMs;
    encodeMsInputTotal += prepared.encodeMs;
    inputBytes += prepared.ioBytes;

    const resizeStart = performance.now();
    const out = await pica.resizeBuffer(
      prepared.source,
      scenario.srcW,
      scenario.srcH,
      scenario.dstW,
      scenario.dstH,
      { filter: scenario.filter, tileSize: scenario.tileSize },
    );
    const resizeMs = performance.now() - resizeStart;
    resizeMsTotal += resizeMs;

    const output = await saveWithCodec(
      scenario.extension,
      out.data,
      scenario.dstW,
      scenario.dstH,
    );
    if (typeof output === "number") {
      outputBytes += output;
    } else {
      outputBytes += output.bytes;
      encodeMsOutputTotal += output.encodeMs;
    }
  }

  const totalMs =
    resizeMsTotal + decodeMsTotal + encodeMsInputTotal + encodeMsOutputTotal;
  const mpix = (scenario.srcW * scenario.srcH * scenario.iterations) / 1_000_000;
  const throughputResize = mpix / (resizeMsTotal / 1000);
  const throughputTotal = mpix / (totalMs / 1000);
  const stats = pica.getStats();

  console.log(
    `${name}: iters=${scenario.iterations}, ext=${scenario.extension}, area=${(
      scenario.srcW * scenario.srcH
    ).toLocaleString()}px, ` +
      `resize=${resizeMsTotal.toFixed(2)}ms, decode=${decodeMsTotal.toFixed(
        2,
      )}ms, encIn=${encodeMsInputTotal.toFixed(
        2,
      )}ms, encOut=${encodeMsOutputTotal.toFixed(
        2,
      )}ms, total=${totalMs.toFixed(
        2,
      )}ms, throughput=${throughputResize.toFixed(
        2,
      )}/${throughputTotal.toFixed(2)} Mpix/s (resize/end-to-end), ` +
      `inBytes=${inputBytes.toLocaleString()}, outBytes=${outputBytes.toLocaleString()}, ` +
      `wasm=${stats.wasmHits}, fallback=${stats.fallbackHits}`,
  );
}

const BASE_SCENARIOS = [
  {
    name: "auto-possible-wasm-1k",
    useWasm: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "bilinear",
  },
  {
    name: "fallback-nearest-1k",
    forceFallback: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "nearest",
  },
  {
    name: "fallback-bilinear-1k",
    forceFallback: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "bilinear",
  },
  {
    name: "fallback-bilinear-hd",
    forceFallback: true,
    srcW: 1920,
    srcH: 1080,
    dstW: 960,
    dstH: 540,
    filter: "bilinear",
  },
  {
    name: "tile-bilinear-hd",
    useWasm: false,
    srcW: 1920,
    srcH: 1080,
    dstW: 960,
    dstH: 540,
    filter: "bilinear",
    tileSize: 128,
  },
  {
    name: "fallback-box-1k",
    forceFallback: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "box",
  },
  {
    name: "fallback-hamming-1k",
    forceFallback: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "hamming",
  },
  {
    name: "fallback-lanczos2-1k",
    forceFallback: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "lanczos2",
  },
  {
    name: "fallback-lanczos3-1k",
    forceFallback: true,
    srcW: 640,
    srcH: 480,
    dstW: 320,
    dstH: 240,
    filter: "lanczos",
  },
  {
    name: "fallback-lanczos2-hd",
    forceFallback: true,
    srcW: 1920,
    srcH: 1080,
    dstW: 960,
    dstH: 540,
    filter: "lanczos2",
  },
  {
    name: "fallback-lanczos3-hd",
    forceFallback: true,
    srcW: 1920,
    srcH: 1080,
    dstW: 960,
    dstH: 540,
    filter: "lanczos",
  },
  {
    name: "auto-bilinear-24m",
    useWasm: true,
    srcW: 6000,
    srcH: 4000,
    dstW: 3000,
    dstH: 2000,
    filter: "bilinear",
    iterations: 1,
    extensions: ["raw", "jpeg", "png"],
  },
  {
    name: "fallback-bilinear-24m",
    forceFallback: true,
    srcW: 6000,
    srcH: 4000,
    dstW: 3000,
    dstH: 2000,
    filter: "bilinear",
    iterations: 1,
    extensions: ["raw"],
  },
];

function buildMatrix(baseScenarios, selectedExtensions) {
  const matrix = [];
  const enabled = new Set((selectedExtensions || []).map(normalizeExtension));

  for (const scenario of baseScenarios) {
    const candidateExtensions = (scenario.extensions || ["raw"]).map(normalizeExtension);
    const active = candidateExtensions.filter((ext) => enabled.has(ext));

    if (active.length === 0) {
      continue;
    }

    for (const extension of active) {
      const area = scenario.srcW * scenario.srcH;
      matrix.push({
        ...scenario,
        extensions: undefined,
        extension,
        iterations: scenario.iterations ?? getIterationsByArea(area),
      });
    }
  }

  return matrix;
}

(async () => {
  const selectedExtensions = parseExtensionArg(
    parseArg("extensions", process.env.BENCH_EXTENSIONS || "raw"),
  );
  const matrix = buildMatrix(BASE_SCENARIOS, selectedExtensions);

  const failures = [];

  for (const scenario of matrix) {
    const caseName = `${scenario.name}-${scenario.extension}`;
    try {
      await runScenario(caseName, scenario);
    } catch (error) {
      if (scenario.extension === "raw") {
        failures.push(`${caseName}: ${error.message}`);
      } else {
        failures.push(`${caseName}: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.log("bench failed/skipped:");
    failures.forEach((failure) => console.log(`- ${failure}`));
  }
})();
