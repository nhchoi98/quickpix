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

