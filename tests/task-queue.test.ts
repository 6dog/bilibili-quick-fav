import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/content/task-queue";

describe("TaskQueue", () => {
  it("promotes a clicked cover ahead of normal prefetch work", async () => {
    const queue = new TaskQueue(1);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = queue.add(async () => { await gate; order.push("first"); });
    const second = queue.add(async () => { order.push("second"); });
    const clicked = queue.add(async () => { order.push("clicked"); });

    clicked.promote();
    releaseFirst();
    await Promise.all([first.promise, second.promise, clicked.promise]);
    expect(order).toEqual(["first", "clicked", "second"]);
  });
});
