interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export class TaskQueue {
  readonly #high: QueuedTask<unknown>[] = [];
  readonly #normal: QueuedTask<unknown>[] = [];
  #active = 0;

  constructor(readonly concurrency = 4) {}

  add<T>(run: () => Promise<T>, priority: "high" | "normal" = "normal"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = { run, resolve, reject };
      (priority === "high" ? this.#high : this.#normal).push(task as QueuedTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.#active < this.concurrency) {
      const task = this.#high.shift() ?? this.#normal.shift();
      if (!task) return;
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
