# Bundler templates for quickpix (worker auto-setup)

QuickPix now tries to create workers from internal module-local URLs before giving up, so
`workerURL` import in consumer code is usually unnecessary.

## 1) 기본 사용 (권장)

```js
import { QuickPix, QuickPixEasy } from "quickpix";

const qp = new QuickPix();
const qpe = new QuickPixEasy();
```

`QuickPixEasy` is worker-first but safely falls back to main-thread mode when workers are
unavailable. Set `requireWorker: true` if you want hard-fail behavior.

```js
import { QuickPixEasy } from "quickpix";

const qpe = new QuickPixEasy({ requireWorker: true });
```

If you still need explicit control for a specific environment:

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
      generator: {
        filename: "static/chunks/[name]-[hash][extname]",
      },
    });
    return config;
  },
};
```

With Next + Turbopack, keep the same import style (no `workerURL` required); if you still see worker load failures, set `transpilePackages` and keep `requireWorker: false`.

## 3) vite.config.js (Vite)

```js
import { defineConfig } from "vite";

export default defineConfig({
  worker: {
    format: "es",
  },
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
import resolve from "@rollup/plugin-node-resolve";

export default {
  plugins: [
    resolve({
      preferBuiltins: false,
      browser: true,
    }),
    url({
      include: [/node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/],
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
// npx esbuild src/index.js --bundle --platform=browser --format=esm --outdir=dist
//
// If your build still misses worker files, keep `?url` worker imports in your app and
// force JS workers to file-loader scope:
//   --loader:.js=file
// (or in API form)
//
// If ?url handling is unstable in your stack, keep `?url` imports and
// configure your esbuild file-asset path according to your environment.
```

## 6) webpack.config.js

```js
module.exports = {
  output: {
    publicPath: "/",
  },
  module: {
    rules: [
      {
        test: /node_modules\/quickpix\/.+(?:resize-worker|pipeline-worker)\.js$/,
        type: "asset/resource",
        generator: {
          filename: "assets/[name][ext][query]",
        },
      },
    ],
  },
};
```

## 7) 실전 체크리스트 (quick sanity)

- QuickPix 기본 import:
  - `new QuickPix()`, `new QuickPixEasy()`로 먼저 테스트
- 번들 후 `workers` 요청이 실패하면:
  - `requireWorker: true`인지 확인
  - 브라우저 네트워크 탭에서 `pipeline-worker.js` / `resize-worker.js`가 실제로 200인지 확인
- 그래도 실패하면 위의 수동 주입(섹션 1 하단)로 임시 우회
