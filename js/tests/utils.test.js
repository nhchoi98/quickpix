import test from "node:test";
import assert from "node:assert/strict";
import { computeTargetSize } from "../src/utils.js";

test("maxDimension scales down landscape", () => {
  const r = computeTargetSize(6000, 4000, { maxDimension: 200 });
  assert.equal(r.width, 200);
  assert.equal(r.height, 133);
});

test("maxDimension scales down portrait", () => {
  const r = computeTargetSize(3000, 6000, { maxDimension: 200 });
  assert.equal(r.width, 100);
  assert.equal(r.height, 200);
});

test("maxDimension no-op when already smaller", () => {
  const r = computeTargetSize(100, 50, { maxDimension: 200 });
  assert.equal(r.width, 100);
  assert.equal(r.height, 50);
});

test("maxDimension square", () => {
  const r = computeTargetSize(1000, 1000, { maxDimension: 100 });
  assert.equal(r.width, 100);
  assert.equal(r.height, 100);
});

test("width only preserves aspect", () => {
  const r = computeTargetSize(800, 600, { width: 400 });
  assert.equal(r.width, 400);
  assert.equal(r.height, 300);
});

test("height only preserves aspect", () => {
  const r = computeTargetSize(800, 600, { height: 300 });
  assert.equal(r.width, 400);
  assert.equal(r.height, 300);
});

test("contain fits within box", () => {
  const r = computeTargetSize(800, 400, { width: 200, height: 200, fit: "contain" });
  assert.equal(r.width, 200);
  assert.equal(r.height, 100);
});

test("cover fills the box", () => {
  const r = computeTargetSize(800, 400, { width: 200, height: 200, fit: "cover" });
  assert.equal(r.width, 400);
  assert.equal(r.height, 200);
});

test("fill ignores aspect ratio", () => {
  const r = computeTargetSize(800, 600, { width: 200, height: 300, fit: "fill" });
  assert.equal(r.width, 200);
  assert.equal(r.height, 300);
});

test("no options returns original size", () => {
  const r = computeTargetSize(640, 480);
  assert.equal(r.width, 640);
  assert.equal(r.height, 480);
});

test("minimum dimension is 1", () => {
  const r = computeTargetSize(10000, 1, { maxDimension: 100 });
  assert.equal(r.width, 100);
  assert.ok(r.height >= 1);
});

test("throws on invalid source dimensions", () => {
  assert.throws(() => computeTargetSize(0, 100, { maxDimension: 50 }), RangeError);
  assert.throws(() => computeTargetSize(-1, 100, { maxDimension: 50 }), RangeError);
});
