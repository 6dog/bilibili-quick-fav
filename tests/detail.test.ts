import { describe, expect, it } from "vitest";
import { computeDetailPlacement } from "../src/content/detail";

const player = { top: 100, right: 900, bottom: 600, left: 100, width: 800, height: 500 };
const anchor = { top: 620, right: 500, bottom: 660, left: 200, width: 300, height: 40 };

describe("computeDetailPlacement", () => {
  it("places a confirmed button next to a toolbar below the player", () => {
    expect(computeDetailPlacement(anchor, player, { width: 1200, height: 900 }, false, true)).toEqual({
      visible: true,
      x: 508,
      y: 620,
    });
  });

  it("fails closed for unknown state, fullscreen, overlap, or viewport clipping", () => {
    expect(computeDetailPlacement(anchor, player, { width: 1200, height: 900 }, false, false).visible).toBe(false);
    expect(computeDetailPlacement(anchor, player, { width: 1200, height: 900 }, true, true).visible).toBe(false);
    expect(computeDetailPlacement({ ...anchor, top: 550, bottom: 590 }, player, { width: 1200, height: 900 }, false, true).visible).toBe(false);
    expect(computeDetailPlacement(anchor, player, { width: 520, height: 900 }, false, true).visible).toBe(false);
  });
});
