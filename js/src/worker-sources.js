const WORKER_SUFFIXES = ["", "?worker&module", "?worker", "?url", "?module"];

function makeWorkerFactory(path, suffix) {
  return () => new Worker(new URL(`${path}${suffix}`, import.meta.url), { type: "module" });
}

export function createWorkerFactories(workerFile) {
  return WORKER_SUFFIXES.map((suffix) => makeWorkerFactory(workerFile, suffix));
}

export const DEFAULT_RESIZE_WORKER_FACTORIES = createWorkerFactories("./resize-worker.js");
export const DEFAULT_PIPELINE_WORKER_FACTORIES = createWorkerFactories("./pipeline-worker.js");
