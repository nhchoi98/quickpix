import test from "node:test";
import assert from "node:assert/strict";
import { QuickPix } from "../src/index.js";
import { resizeBufferFallback } from "../src/fallback.js";

function l1Distance(a, b) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += Math.abs(a[i] - b[i]);
  }
  return d / a.length;
}

test("resizeBuffer fallback keeps destination geometry", async () => {
  const pica = new QuickPix({ forceFallback: true });
  const src = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 255,
  ]);
  const out = await pica.resizeBuffer(src, 2, 2, 1, 1, { filter: "bilinear" });
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.equal(out.data.length, 4);
});

test("resizeBuffer nearest fallback is deterministic", async () => {
  const pica = new QuickPix({ forceFallback: true });
  const src = new Uint8ClampedArray([
    10, 20, 30, 40,
    50, 60, 70, 80,
    90, 100, 110, 120,
    130, 140, 150, 160,
  ]);
  const out = await pica.resizeBuffer(src, 2, 2, 2, 2, { filter: "nearest" });
  assert.deepEqual(Array.from(out.data), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
});

test("tile path produces same results as untiled path", async () => {
  const pica = new QuickPix({ forceFallback: true, tileSize: 1 });
  const src = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 255,
  ]);

  const out1 = await pica.resizeBuffer(src, 2, 2, 2, 2, { filter: "bilinear", tileSize: 0 });
  const out2 = await pica.resizeBuffer(src, 2, 2, 2, 2, { filter: "bilinear", tileSize: 2 });

  assert.equal(out1.data.length, out2.data.length);
  assert.equal(l1Distance(out1.data, out2.data), 0);
});

test("core fallback API is used when wasm unavailable", async () => {
  const pica = new QuickPix({ forceFallback: true });
  const src = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255, 12, 34, 56, 78, 90, 123, 45, 67]);
  const out = await pica.resizeBuffer(src, 2, 2, 3, 1, { filter: "bilinear" });
  const direct = resizeBufferFallback(src, 2, 2, 3, 1, "bilinear");
  assert.equal(l1Distance(out.data, direct), 0);
});

test("concurrency path matches single-thread fallback result", async () => {
  const pica = new QuickPix({ forceFallback: true, concurrency: 4, tileSize: 1 });
  const src = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
    12, 34, 56, 78,
    90, 123, 45, 67,
    210, 220, 230, 240,
  ]);

  const single = await pica.resizeBuffer(src, 2, 4, 3, 3, { filter: "bilinear", concurrency: 1 });
  const parallel = await pica.resizeBuffer(src, 2, 4, 3, 3, { filter: "bilinear", concurrency: 4 });

  assert.equal(single.width, 3);
  assert.equal(single.height, 3);
  assert.equal(parallel.width, 3);
  assert.equal(parallel.height, 3);
  assert.equal(l1Distance(single.data, parallel.data), 0);
});

test("convolution filters are accepted in fallback path", async () => {
  const pica = new QuickPix({ forceFallback: true });
  const src = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);

  const box = await pica.resizeBuffer(src, 2, 2, 3, 3, { filter: "box" });
  const hamming = await pica.resizeBuffer(src, 2, 2, 3, 3, { filter: "hamming" });
  const lanczos = await pica.resizeBuffer(src, 2, 2, 3, 3, { filter: "lanczos" });

  assert.equal(box.width, 3);
  assert.equal(box.height, 3);
  assert.equal(box.data.length, 3 * 3 * 4);
  assert.equal(hamming.width, 3);
  assert.equal(hamming.height, 3);
  assert.equal(hamming.data.length, 3 * 3 * 4);
  assert.equal(lanczos.width, 3);
  assert.equal(lanczos.height, 3);
  assert.equal(lanczos.data.length, 3 * 3 * 4);

  const directBox = resizeBufferFallback(src, 2, 2, 3, 3, "box");
  const directHamming = resizeBufferFallback(src, 2, 2, 3, 3, "hamming");
  const directLanczos = resizeBufferFallback(src, 2, 2, 3, 3, "lanczos");

  assert.equal(l1Distance(box.data, directBox), 0);
  assert.equal(l1Distance(hamming.data, directHamming), 0);
  assert.equal(l1Distance(lanczos.data, directLanczos), 0);
});

test("lanczos3 alias resolves to lanczos", async () => {
  const pica = new QuickPix({ forceFallback: true });
  const src = new Uint8ClampedArray([
    50, 80, 120, 255,
    30, 60, 90, 255,
    200, 180, 40, 255,
    70, 90, 150, 255,
  ]);
  const a = await pica.resizeBuffer(src, 2, 2, 4, 4, { filter: "lanczos" });
  const b = await pica.resizeBuffer(src, 2, 2, 4, 4, { filter: "lanczos3" });
  assert.equal(l1Distance(a.data, b.data), 0);
});
