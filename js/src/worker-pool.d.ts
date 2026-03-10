export interface WorkerPoolOptions {
  workerScript?: string | URL;
  workerFactory?: () => Worker | Promise<Worker>;
  maxWorkers?: number;
  idleTimeout?: number;
  initPayload?: Record<string, unknown>;
}

export class WorkerPool {
  constructor(options: WorkerPoolOptions);

  /** Run a single task on an available worker. */
  run<T extends Record<string, unknown> = Record<string, unknown>>(task: T): Promise<T>;

  /** Run multiple tasks in parallel across the pool. */
  runBatch<T extends Record<string, unknown> = Record<string, unknown>>(tasks: T[]): Promise<T[]>;

  /** Terminate all workers and reject pending tasks. */
  destroy(): void;

  /** Number of workers (idle + active). */
  readonly size: number;

  /** Number of tasks waiting in queue. */
  readonly pending: number;
}
