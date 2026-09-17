import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("keeps overlay controls in the viewport layer", () => {
    const ui = new OverlayUi();
    const css = ui.root.querySelector("style")?.textContent ?? "";
    expect(ui.host.style.position).toBe("fixed");
    expect(css).toContain(".cover-button, .detail-button { position: fixed;");
    ui.destroy();
  });

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

  it("closes and settles the picker when cancelled", async () => {
    const ui = new OverlayUi();
    ui.detailButton.focus();
    const selection = ui.chooseFolder([{ id: "20", title: "快捷", favorite: false, mediaCount: 0 }]);
    await vi.waitFor(() => expect(ui.root.activeElement?.classList.contains("folder")).toBe(true));
    const folderButton = ui.root.querySelector<HTMLButtonElement>(".folder")!;
    folderButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, shiftKey: false }));
    expect(ui.root.activeElement?.classList.contains("dialog-close")).toBe(true);
    ui.cancelFolderPicker();
    expect(await selection).toBeNull();
    expect(ui.root.querySelector(".backdrop")).toBeNull();
    expect(ui.root.activeElement).toBe(ui.detailButton);
    ui.destroy();
  });
});
