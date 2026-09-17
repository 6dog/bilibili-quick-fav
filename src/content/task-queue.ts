interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  started: boolean;
}

export interface QueuedTaskHandle<T> {
  promise: Promise<T>;
  promote: () => void;
}

export class TaskQueue {
  readonly #high: QueuedTask<unknown>[] = [];
  readonly #normal: QueuedTask<unknown>[] = [];
  #active = 0;

  constructor(readonly concurrency = 4) {}

  get pending(): number { return this.#high.length + this.#normal.length; }

  add<T>(run: () => Promise<T>, priority: "high" | "normal" = "normal"): QueuedTaskHandle<T> {
    let task: QueuedTask<T>;
    const promise = new Promise<T>((resolve, reject) => {
      task = { run, resolve, reject, started: false };
      (priority === "high" ? this.#high : this.#normal).push(task as QueuedTask<unknown>);
      this.drain();
    });
    return {
      promise,
      promote: () => {
        if (task.started) return;
        const index = this.#normal.indexOf(task as QueuedTask<unknown>);
        if (index < 0) return;
        this.#normal.splice(index, 1);
        this.#high.push(task as QueuedTask<unknown>);
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.#active < this.concurrency) {
      const task = this.#high.shift() ?? this.#normal.shift();
      if (!task) return;
      task.started = true;
      this.#active += 1;
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.#active -= 1;
          this.drain();
        });
    }
  }
}
