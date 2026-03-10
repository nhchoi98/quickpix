# quickpix

[![npm version](https://img.shields.io/npm/v/quickpix)](https://www.npmjs.com/package/quickpix)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/quickpix)](https://bundlephobia.com/package/quickpix)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/quickpix)
[![license](https://img.shields.io/npm/l/quickpix)](./LICENSE)

[한국어](./README.ko.md)

High-performance image resize for browsers and Node.js. Rust/WASM accelerated with pure JS fallback. Zero dependencies.

```bash
npm install quickpix
```

## Quick Start — High-Level API (`QuickPixEasy`)

For most use cases, `QuickPixEasy` is all you need.
Blob/File in → resize → Blob out, in a single call.

```js
import { QuickPixEasy } from "quickpix";

const qp = new QuickPixEasy({
  filter: "lanczos",           // resize filter (default: bilinear)
  outputMimeType: "image/jpeg",
  outputQuality: 0.85,
  preserveMetadata: true,      // preserve EXIF/ICC/IPTC metadata
  autoRotate: true,            // auto-correct EXIF orientation (default: true)
});
```

### Resize Blob/File

```js
const input = document.querySelector('input[type="file"]');
const file = input.files[0];

// Exact dimensions
const resized = await qp.resizeBlob(file, 1200, 800);

// Width only — height auto-calculated (aspect ratio preserved)
const resized2 = await qp.resizeBlob(file, 1200, null);

// Height only — width auto-calculated
const resized3 = await qp.resizeBlob(file, null, 800);

// Max dimension — longest side fits within limit
const resized4 = await qp.resizeBlob(file, null, null, { maxDimension: 4096 });

// resizeFile is an alias for resizeBlob
const resized5 = await qp.resizeFile(file, 1200, null);
```

### Create Thumbnails

Automatically preserves aspect ratio. The longest side fits within `maxDimension`.

```js
// 6000x4000 image → 200x133 thumbnail
const thumbnail = await qp.createThumbnail(file, 200);

// Also accepts Canvas, ImageData, HTMLImageElement
const thumb2 = await qp.createThumbnail(canvasElement, 150);
```

### Draw to Canvas

```js
const canvas = document.getElementById("preview");
canvas.width = 800;
canvas.height = 600;

await qp.resizeToCanvas(file, canvas, { filter: "lanczos" });
```

### Batch Parallel Processing

Processes multiple images concurrently using a Web Worker pool.
Each image runs the full decode→resize→encode pipeline in a separate worker.

```js
const results = await qp.batchResize([
  { source: photo1, maxDimension: 800 },
  { source: photo2, width: 600, height: 400 },
  { source: photo3, maxDimension: 200 },
]);
// results = [Blob, Blob, Blob]
```

### Metadata Preservation

By default, Canvas API strips all EXIF, ICC profiles, and other metadata.
Set `preserveMetadata: true` to re-inject the original JPEG metadata into the output.

```js
// Preserve metadata (EXIF date, GPS, camera info, ICC color profile, etc.)
const withMeta = await qp.resizeBlob(photo, 1200, 800, {
  preserveMetadata: true,
  outputMimeType: "image/jpeg",
});

// Strip metadata (default — better for privacy)
const stripped = await qp.resizeBlob(photo, 1200, 800, {
  preserveMetadata: false,
});
```

### EXIF Orientation Auto-Correction

Smartphone photos store rotation info in EXIF.
With `autoRotate: true` (default), images are automatically corrected to the right orientation.

```js
// autoRotate: true (default) — portrait photos display correctly
const rotated = await qp.resizeBlob(phonePhoto, 800, 600);

// autoRotate: false — keep original pixel orientation
const raw = await qp.resizeBlob(phonePhoto, 800, 600, { autoRotate: false });
```

### Fit Modes

```js
// contain (default): fit within 800x600, preserve aspect ratio
const a = await qp.resizeBlob(photo, 800, 600, { fit: "contain" });

// cover: fill 800x600 completely, preserve aspect ratio (may crop)
const b = await qp.resizeBlob(photo, 800, 600, { fit: "cover" });

// fill: stretch to exactly 800x600, ignore aspect ratio
const c = await qp.resizeBlob(photo, 800, 600, { fit: "fill" });
```

### Cleanup

```js
qp.destroy(); // terminate worker pool and release resources
```

### Options Reference

| Option | Default | Description |
|---|---|---|
| `filter` | `"bilinear"` | Resize filter (`nearest`, `bilinear`, `box`, `hamming`, `lanczos`) |
| `maxWorkers` | `navigator.hardwareConcurrency` | Max worker pool size |
| `idleTimeout` | `30000` | Auto-terminate idle workers (ms) |
| `outputMimeType` | `"image/png"` | Output image format |
| `outputQuality` | `0.92` | JPEG/WebP quality (0–1) |
| `useWasm` | `true` | Enable WASM acceleration |
| `preserveMetadata` | `false` | Preserve EXIF/ICC/IPTC metadata |
| `autoRotate` | `true` | Auto-correct EXIF orientation |

---

## Low-Level API (`QuickPix`)

For direct RGBA buffer manipulation or fine-grained control.

```js
import { QuickPix } from "quickpix";

const qp = new QuickPix({ useWasm: true, filter: "lanczos" });

const src = new Uint8ClampedArray(640 * 480 * 4);
const out = await qp.resizeBuffer(src, 640, 480, 320, 240, {
  filter: "lanczos",
});

console.log(out.width, out.height, out.data.length); // 320 240 307200
```

### Supported Filters

| Filter | Description | Speed | Quality |
|---|---|---|---|
| `nearest` | Nearest neighbor | Fastest | Low |
| `bilinear` | 2x2 linear interpolation (default) | Fast | Medium |
| `box` | Box average | Medium | Medium |
| `hamming` | Hamming window | Slow | High |
| `lanczos` | Lanczos3 sinc-based | Slowest | Best |

---

## Metadata Module

Standalone module for direct EXIF/ICC/IPTC manipulation.

```js
import { readOrientation, extractSegments, injectSegments } from "quickpix/metadata";

const buffer = await file.arrayBuffer();
const orientation = readOrientation(buffer);
const segments = extractSegments(buffer);
const restored = await injectSegments(resizedJpegBlob, segments);
```

---

## Install & Build

```bash
npm install quickpix

# Development (build from source)
npm install
npm run build:wasm    # Rust → WASM (requires wasm-pack)
npm run test:js
npm run test:rust
```

## Benchmarks

```bash
npm run bench           # performance
npm run bench:compare   # vs pica
npm run bench:memory    # memory profiling
npm run bench:native    # vs sharp (libvips)
npm run bench:quality   # quality comparison
```

## Browser Compatibility

| Feature | Chrome 69+ | Firefox 105+ | Safari 16.4+ |
|---|---|---|---|
| Pipeline worker (optimal) | Yes | Yes | Yes |
| JS fallback | All browsers | All browsers | All browsers |

Automatically falls back to main-thread processing when `OffscreenCanvas` is unavailable.

## License

MIT
