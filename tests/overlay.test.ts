import { beforeEach, describe, expect, it } from "vitest";
import { OverlayUi } from "../src/content/overlay";
import type { FavoriteSnapshot } from "../src/shared/types";

function snapshot(status: FavoriteSnapshot["status"]): FavoriteSnapshot {
  return {
    status,
    active: false,
    configured: true,
    folderTitle: "快捷",
  };
}

describe("favorite button responsiveness", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("accepts clicks without switching the pointer to a waiting cursor", () => {
    let actions = 0;
    const ui = new OverlayUi();
    ui.showCover({ left: 10, top: 10, right: 210, bottom: 130, width: 200, height: 120 }, snapshot("loading"), () => { actions += 1; });
    expect(ui.coverButton.disabled).toBe(false);
    expect(ui.coverButton.getAttribute("aria-busy")).toBe("true");

    ui.coverButton.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(actions).toBe(1);
    expect(ui.coverButton.classList.contains("pressed")).toBe(true);

    ui.updateCover(snapshot("mutating"));
    expect(ui.coverButton.disabled).toBe(false);
    expect(ui.root.querySelector("style")?.textContent).not.toContain("cursor: progress");
    ui.destroy();
  });
});
