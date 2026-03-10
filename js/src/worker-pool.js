/**
 * Reusable worker pool with idle timeout and task queuing.
 */

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_IDLE_TIMEOUT = 30000;

export class WorkerPool {
  /**
   * @param {object} options
   * @param {string|URL} options.workerScript - URL to the worker script
   * @param {number} [options.maxWorkers]     - Max concurrent workers
   * @param {number} [options.idleTimeout]    - Auto-terminate idle workers (ms)
   * @param {object} [options.initPayload]    - Payload sent to each worker on init
   */
  constructor(options) {
    this._script = options.workerScript;
    this._maxWorkers =
      options.maxWorkers ||
      (typeof navigator !== "undefined" && navigator.hardwareConcurrency) ||
      DEFAULT_MAX_WORKERS;
    this._idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this._initPayload = options.initPayload || null;

    /** @type {{ worker: Worker, id: number, timer: any }[]} */
    this._idle = [];
    this._active = 0;
    this._totalCreated = 0;
    this._taskId = 0;
    this._destroyed = false;

    /** @type {{ resolve: Function, reject: Function, task: object }[]} */
    this._queue = [];
  }

  /**
   * Run a single task on an available worker.
   * @param {object} task - Task payload (merged with { type, id })
   * @returns {Promise<object>}
   */
  async run(task) {
    if (this._destroyed) {
      throw new Error("WorkerPool has been destroyed");
    }

    const worker = await this._acquire();
    try {
      return await this._execute(worker, task);
    } finally {
      this._release(worker);
    }
  }

  /**
   * Run multiple tasks in parallel, distributing across the pool.
   * @param {object[]} tasks
   * @returns {Promise<object[]>}
   */
  async runBatch(tasks) {
    return Promise.all(tasks.map((task) => this.run(task)));
  }

  /**
   * Terminate all workers and reject pending tasks.
   */
  destroy() {
    this._destroyed = true;

    for (const entry of this._idle) {
      clearTimeout(entry.timer);
      entry.worker.terminate();
    }
    this._idle = [];
    this._active = 0;

    for (const pending of this._queue) {
      pending.reject(new Error("WorkerPool destroyed"));
    }
    this._queue = [];
  }

  get size() {
    return this._idle.length + this._active;
  }

  get pending() {
    return this._queue.length;
  }

  /** @private */
  async _acquire() {
    // Reuse idle worker
    if (this._idle.length > 0) {
      const entry = this._idle.pop();
      clearTimeout(entry.timer);
      this._active += 1;
      return entry;
    }

    // Create new worker if under limit
    if (this._active < this._maxWorkers) {
      this._active += 1;
      const entry = await this._createWorker();
      return entry;
    }

    // Wait in queue
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject, task: null });
    });
  }

  /** @private */
  _release(entry) {
    this._active -= 1;

    // If there are queued tasks, immediately assign this worker
    if (this._queue.length > 0) {
      const pending = this._queue.shift();
      this._active += 1;
      pending.resolve(entry);
      return;
    }

    // Return to idle pool with timeout
    if (!this._destroyed) {
      entry.timer = setTimeout(() => {
        const idx = this._idle.indexOf(entry);
        if (idx !== -1) {
          this._idle.splice(idx, 1);
          entry.worker.terminate();
        }
      }, this._idleTimeout);
      this._idle.push(entry);
    } else {
      entry.worker.terminate();
    }
  }

  /** @private */
  async _createWorker() {
    const worker = new Worker(this._script, { type: "module" });
    const id = (this._totalCreated += 1);

    if (this._initPayload) {
      await this._sendAndWait(worker, {
        type: "init",
        id,
        payload: this._initPayload,
      }, "ready");
    }

    return { worker, id, timer: null };
  }

  /** @private */
  _sendAndWait(worker, message, expectedType) {
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.type === expectedType) {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(msg);
          }
        }
      };

      const onError = (event) => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        reject(new Error(event?.message || "Worker error"));
      };

      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(message);
    });
  }

  /** @private */
  _execute(entry, task) {
    const id = (this._taskId += 1);
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.id !== id) return;

        entry.worker.removeEventListener("message", onMessage);
        entry.worker.removeEventListener("error", onError);

        if (msg.success) {
          resolve(msg);
        } else {
          reject(new Error(msg.error || "Task failed"));
        }
      };

      const onError = () => {
        entry.worker.removeEventListener("message", onMessage);
        entry.worker.removeEventListener("error", onError);
        reject(new Error("Worker runtime error"));
      };

      entry.worker.addEventListener("message", onMessage);
      entry.worker.addEventListener("error", onError);
      entry.worker.postMessage({ ...task, id });
    });
  }
}
