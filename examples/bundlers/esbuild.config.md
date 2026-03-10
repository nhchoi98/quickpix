# esbuild (stable worker URL workflow)

Baseline CLI:

```bash
npx esbuild src/index.js --bundle --platform=browser --outdir=dist
```

If your build breaks `?url` imports, keep `?url` in source and switch worker modules to be copied as assets in your esbuild pipeline (CLI/plugin setting depends on your stack).

```js
// import in code:
import resizeWorker from "quickpix/resize-worker.js?url";
import pipelineWorker from "quickpix/pipeline-worker.js?url";
```

