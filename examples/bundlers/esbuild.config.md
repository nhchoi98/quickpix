# esbuild (optional manual worker URL workflow)

Baseline CLI (default fast path, usually no manual worker imports):

```bash
npx esbuild src/index.js --bundle --platform=browser --format=esm --outdir=dist
```

If your build breaks `?url` imports, keep `?url` in source and switch worker modules to be copied as assets in your esbuild pipeline (CLI/plugin setting depends on your stack).

```js
// import in code:
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";
```
