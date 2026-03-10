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
| `workerURL` | `null` | Pipeline worker URL (or `data:` URL) for bundlers that do not rewrite worker paths |
| `requireWorker` | `false` | If `true`, throws when worker pipeline is unavailable instead of falling back to main thread |
| `wasmPath` | `null` | Override WASM module URL |

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

### Bundler-safe worker setup (Next, Vite, Rollup, esbuild, webpack, Turbopack)

QuickPix resolves worker entry from multiple candidates by default, but for bundlers that do not rewrite worker URLs reliably, pass `workerURL` explicitly.
If you need hard failure when worker mode is unavailable, set `requireWorker: true`.

Example config templates: [examples/bundlers](/Users/ncai_nak/Desktop/Repository/pica_rust/examples/bundlers)

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";

const qp = new QuickPix({
  workerURL: resizeWorker,
  requireWorker: true,
});

const qpe = new QuickPixEasy({
  workerURL: pipelineWorker,
  requireWorker: true,
});
```

If your setup already handles worker modules, this also works:

```js
import resizeWorker from "quickpix/resize-worker?url";
import pipelineWorker from "quickpix/pipeline-worker?url";
```

Rollup users can use either the `?url` form above (with `@rollup/plugin-url`) or the plain worker file path:

```js
import resizeWorker from "quickpix/resize-worker.js";
import pipelineWorker from "quickpix/pipeline-worker.js";
```

You can also pass a function factory to return a Worker instance directly:

```js
import resizeWorkerURL from "quickpix/resize-worker.js?url";

const qp = new QuickPix({
  workerURL: [() => new Worker(resizeWorkerURL, { type: "module" })],
  requireWorker: true,
});
```

`requireWorker: true` gives behavior similar to image-blob-reduce: it throws when worker paths or runtime are unavailable instead of falling back to main-thread processing.

### Stable workerURL combos by bundler

Copy this section as a reference and choose one option per stack.

**1) Next.js (webpack / Turbopack)**

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";

const qp = new QuickPix({ workerURL: resizeWorker, requireWorker: true });
const qpe = new QuickPixEasy({ workerURL: pipelineWorker, requireWorker: true });
```

Alternative (if path rewriting is odd in your setup):

```js
import { QuickPix } from "quickpix";

const qp = new QuickPix({
  workerURL: [() => import("quickpix/resize-worker.js?url").then((m) => new Worker(m.default, { type: "module" }))],
  requireWorker: true,
});
```

**2) Vite**

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js?worker";
import pipelineWorker from "quickpix/pipeline-worker.js?worker";

const qp = new QuickPix({ workerURL: resizeWorker, requireWorker: true });
const qpe = new QuickPixEasy({ workerURL: pipelineWorker, requireWorker: true });
```

Fallback when `?worker` form is not enabled:

```js
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";
```

**3) Rollup**

```js
// rollup.config.js
import url from "@rollup/plugin-url";

export default {
  plugins: [
    url({
      include: [
        /node_modules\/quickpix\/.*(resize-worker|pipeline-worker)\.js$/,
      ],
      limit: 0,
      emitFiles: true,
      fileName: "[name][extname]",
    }),
  ],
};
```

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js";
import pipelineWorker from "quickpix/pipeline-worker.js";

const qp = new QuickPix({ workerURL: resizeWorker, requireWorker: true });
const qpe = new QuickPixEasy({ workerURL: pipelineWorker, requireWorker: true });
```

**4) esbuild**

```js
// esbuild CLI
// Use explicit URL-form import in source. If needed, force worker scripts to file-url output.
esbuild src/index.js --bundle --platform=browser --outdir=dist \
  --loader:.js=file
```

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";

const qp = new QuickPix({ workerURL: resizeWorker, requireWorker: true });
const qpe = new QuickPixEasy({ workerURL: pipelineWorker, requireWorker: true });
```

**5) webpack**

```js
// webpack 5 config (asset-module default)
module.exports = {
  module: {
    rules: [
      {
        test: /quickpix\\/(.*)worker\\.js$/,
        type: "asset/resource",
      },
    ],
  },
};
```

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";

const qp = new QuickPix({ workerURL: resizeWorker, requireWorker: true });
const qpe = new QuickPixEasy({ workerURL: pipelineWorker, requireWorker: true });
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
