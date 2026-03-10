# Bundler templates for quickpix worker URLs

QuickPix uses worker files from package exports.  
If your bundler does not reliably rewrite worker URLs, use these templates.

## 1) shared usage

```js
import { QuickPix, QuickPixEasy } from "quickpix";
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";

export const qp = new QuickPix({
  workerURL: resizeWorker,
  requireWorker: true,
});

export const qpe = new QuickPixEasy({
  workerURL: pipelineWorker,
  requireWorker: true,
});
```

If you must force a worker factory, use:

```js
import { QuickPix } from "quickpix";

export const qp = new QuickPix({
  workerURL: [
    async () => new Worker((await import("quickpix/resize-worker.js?url")).default, { type: "module" }),
  ],
  requireWorker: true,
});
```

## 2) next.config.js (Next.js webpack)

```js
/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ["quickpix"],
  webpack(config) {
    config.module.rules.push({
      test: /node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/,
      type: "asset/resource",
    });
    return config;
  },
};
```

With Next + Turbopack, keep the same import style with `?url`; no additional bundler transform is usually needed.

## 3) vite.config.js (Vite)

```js
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
```

## 4) rollup.config.js (Rollup)

```js
import url from "@rollup/plugin-url";

export default {
  plugins: [
    url({
      include: [/node_modules\/quickpix\/.*(?:resize|pipeline)-worker\.js$/],
      limit: 0,
      emitFiles: true,
      fileName: "[name]-[hash][extname]",
    }),
  ],
};
```

## 5) esbuild.config.mjs

```js
// Baseline:
// npx esbuild src/index.js --bundle --platform=browser --outdir=dist
//
// If ?url handling is unstable in your stack, keep `?url` imports and
// configure your esbuild file-asset path according to your environment.
```

## 6) webpack.config.js

```js
module.exports = {
  module: {
    rules: [
      {
        test: /node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/,
        type: "asset/resource",
      },
    ],
  },
};
```
