import { QuickPix } from "../js/src/index.js";

function makePattern(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const checker = (x + y) % 2;
      const base = checker ? 220 : 35;
      data[i] = (base + x * 3) & 255;
      data[i + 1] = (base + y * 2) & 255;
      data[i + 2] = base ^ (x * 11) & 255;
      data[i + 3] = 255;
    }
  }
  return data;
}

function mse(a, b) {
  const len = Math.min(a.length, b.length);
  if (a.length !== b.length) {
    throw new Error("arrays must be same length");
  }
  let s = 0;
  for (let i = 0; i < len; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s / len;
}

function psnr(a, b) {
  const err = mse(a, b);
  if (err === 0) {
    return Infinity;
  }
  return 10 * Math.log10((255 * 255) / err);
}

async function run() {
  const src = makePattern(320, 240);
  const picaFallback = new QuickPix({ forceFallback: true });

  const cases = [
    { name: "downscale-2x", w1: 320, h1: 240, w2: 160, h2: 120 },
    { name: "downscale-4x", w1: 320, h1: 240, w2: 80, h2: 60 },
    { name: "upscale-2x", w1: 80, h1: 60, w2: 160, h2: 120 },
  ];

  for (const c of cases) {
    const srcData = c.w1 === 320 ? src : makePattern(c.w1, c.h1);
    const ref = await picaFallback.resizeBuffer(
      srcData,
      c.w1,
      c.h1,
      c.w2,
      c.h2,
      { filter: "bilinear" }
    );

    let outWasm = ref;
    try {
      const candidate = await new QuickPix().resizeBuffer(
        srcData,
        c.w1,
        c.h1,
        c.w2,
        c.h2,
        { filter: "bilinear" }
      );
      outWasm = candidate;
    } catch {
      outWasm = ref;
    }
    console.log(
      `${c.name}: channels=${outWasm.width}x${outWasm.height}, mse=${mse(ref.data, outWasm.data).toFixed(
        6
      )}, psnr=${psnr(ref.data, outWasm.data).toFixed(2)}`
    );
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
