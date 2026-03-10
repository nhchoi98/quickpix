import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSegments,
  readOrientation,
  injectSegments,
  orientationTransform,
} from "../src/metadata.js";

// Build a minimal valid JPEG with an EXIF segment containing Orientation tag.
// Structure: SOI + APP1(EXIF with orientation) + SOS(fake) + EOI
function buildJpegWithOrientation(orientation, littleEndian = true) {
  const parts = [];

  // SOI
  parts.push(new Uint8Array([0xff, 0xd8]));

  // APP1 EXIF segment
  const exifPayload = buildExifPayload(orientation, littleEndian);
  const app1Len = 2 + exifPayload.length; // length field includes itself
  const app1 = new Uint8Array(4 + exifPayload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (app1Len >> 8) & 0xff;
  app1[3] = app1Len & 0xff;
  app1.set(exifPayload, 4);
  parts.push(app1);

  // Fake SOS + EOI
  parts.push(new Uint8Array([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result.buffer;
}

function buildExifPayload(orientation, littleEndian) {
  // Exif\0\0 header (6 bytes) + TIFF header + IFD with 1 entry
  const buf = new ArrayBuffer(6 + 8 + 2 + 12 + 4);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const le = littleEndian;

  // "Exif\0\0"
  u8[0] = 0x45; u8[1] = 0x78; u8[2] = 0x69;
  u8[3] = 0x66; u8[4] = 0x00; u8[5] = 0x00;

  const tiffBase = 6;

  // Byte order
  if (le) {
    u8[tiffBase] = 0x49; u8[tiffBase + 1] = 0x49; // 'II'
  } else {
    u8[tiffBase] = 0x4d; u8[tiffBase + 1] = 0x4d; // 'MM'
  }

  // TIFF magic 42
  view.setUint16(tiffBase + 2, 42, le);

  // IFD0 offset = 8 (right after TIFF header)
  view.setUint32(tiffBase + 4, 8, le);

  const ifdBase = tiffBase + 8;

  // 1 entry
  view.setUint16(ifdBase, 1, le);

  // Orientation tag entry (tag=0x0112, type=SHORT(3), count=1, value=orientation)
  const entryBase = ifdBase + 2;
  view.setUint16(entryBase, 0x0112, le);      // tag
  view.setUint16(entryBase + 2, 3, le);       // type = SHORT
  view.setUint32(entryBase + 4, 1, le);       // count
  view.setUint16(entryBase + 8, orientation, le); // value

  // Next IFD offset = 0 (no next IFD)
  view.setUint32(ifdBase + 2 + 12, 0, le);

  return new Uint8Array(buf);
}

// --- Tests ---

test("readOrientation returns correct value (little-endian)", () => {
  for (let i = 1; i <= 8; i += 1) {
    const jpeg = buildJpegWithOrientation(i, true);
    assert.equal(readOrientation(jpeg), i, `orientation ${i} LE`);
  }
});

test("readOrientation returns correct value (big-endian)", () => {
  for (let i = 1; i <= 8; i += 1) {
    const jpeg = buildJpegWithOrientation(i, false);
    assert.equal(readOrientation(jpeg), i, `orientation ${i} BE`);
  }
});

test("readOrientation returns 1 for non-JPEG", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  assert.equal(readOrientation(png), 1);
});

test("readOrientation returns 1 for JPEG without EXIF", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]).buffer;
  assert.equal(readOrientation(jpeg), 1);
});

test("extractSegments finds EXIF segment", () => {
  const jpeg = buildJpegWithOrientation(6, true);
  const seg = extractSegments(jpeg);
  assert.ok(seg.exif, "exif segment should exist");
  assert.ok(seg.exif.length > 0);
  assert.equal(seg.icc.length, 0);
  assert.equal(seg.iptc, null);
});

test("extractSegments returns empty for non-JPEG", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  const seg = extractSegments(png);
  assert.equal(seg.exif, null);
  assert.equal(seg.icc.length, 0);
  assert.equal(seg.iptc, null);
});

test("injectSegments preserves orientation through round-trip", async () => {
  const original = buildJpegWithOrientation(3, true);
  const segments = extractSegments(original);

  // Build a "new" JPEG without EXIF (just SOI + SOS + EOI)
  const stripped = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const strippedBlob = new Blob([stripped], { type: "image/jpeg" });

  const restored = await injectSegments(strippedBlob, segments);
  const restoredBuf = await restored.arrayBuffer();

  assert.equal(readOrientation(restoredBuf), 3, "orientation should be preserved");
});

test("injectSegments returns blob unchanged for non-JPEG", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const blob = new Blob([png], { type: "image/png" });
  const result = await injectSegments(blob, { exif: null, icc: [], iptc: null });
  const buf = await result.arrayBuffer();
  assert.equal(buf.byteLength, 4);
  assert.equal(new Uint8Array(buf)[0], 0x89);
});

test("orientationTransform swaps dimensions for 5-8", () => {
  for (let i = 1; i <= 4; i += 1) {
    const t = orientationTransform(i, 100, 50);
    assert.equal(t.width, 100, `orientation ${i} width`);
    assert.equal(t.height, 50, `orientation ${i} height`);
  }
  for (let i = 5; i <= 8; i += 1) {
    const t = orientationTransform(i, 100, 50);
    assert.equal(t.width, 50, `orientation ${i} width swapped`);
    assert.equal(t.height, 100, `orientation ${i} height swapped`);
  }
});

test("orientationTransform.apply is callable", () => {
  const t = orientationTransform(6, 100, 50);
  // Mock context
  let called = false;
  const ctx = { transform() { called = true; } };
  t.apply(ctx);
  assert.ok(called);
});

test("orientationTransform orientation 1 does not call transform", () => {
  const t = orientationTransform(1, 100, 50);
  let called = false;
  const ctx = { transform() { called = true; } };
  t.apply(ctx);
  assert.ok(!called, "orientation 1 should not call transform");
});
