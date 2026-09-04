import { describe, expect, it } from "vitest";
import { BiliApi, BiliApiError } from "../src/content/api";
import { FavoriteService } from "../src/content/favorites";
import { SettingsRepository } from "../src/shared/settings";
import type { BiliFolder, QuickFolder, SettingsV1 } from "../src/shared/types";

class FakeApi extends BiliApi {
  active = false;
  writes: Array<{ aid: number; folderId: string; active: boolean }> = [];
  override async getViewerMid(): Promise<string> { return "10"; }
  override async getAid(): Promise<number> { return 99; }
  override async getFolders(): Promise<BiliFolder[]> {
    return [
      { id: "20", title: "快捷", favorite: this.active, mediaCount: 2 },
      { id: "30", title: "其它", favorite: true, mediaCount: 5 },
    ];
  }
  override async getFolderState(_mid: string, _aid: number, folderId: string): Promise<boolean> {
    if (folderId !== "20") throw new Error("wrong folder");
    return this.active;
  }
  override async setFolderState(aid: number, folderId: string, active: boolean): Promise<void> {
    this.writes.push({ aid, folderId, active });
    this.active = active;
  }
}

class MemorySettings extends SettingsRepository {
  value: SettingsV1 = { schemaVersion: 1, foldersByMid: { "10": { id: "20", title: "快捷" } }, playbackEnabled: true };
  override async load(): Promise<SettingsV1> { return structuredClone(this.value); }
  override async save(value: SettingsV1): Promise<void> { this.value = structuredClone(value); }
  override async getFolder(mid: string): Promise<QuickFolder | null> { return this.value.foldersByMid[mid] ?? null; }
  override async setFolder(mid: string, folder: QuickFolder): Promise<void> { this.value.foldersByMid[mid] = folder; }
  override async clearFolder(mid: string): Promise<void> { delete this.value.foldersByMid[mid]; }
}

describe("FavoriteService", () => {
  it("toggles only the configured quick folder", async () => {
    const api = new FakeApi();
    const notices: string[] = [];
    const service = new FavoriteService(api, new MemorySettings(), {
      chooseFolder: async () => null,
      showNotice: (message) => notices.push(message),
    });
    expect((await service.load("BV1abc", "high")).active).toBe(false);
    expect((await service.toggle("BV1abc")).active).toBe(true);
    expect(api.writes).toEqual([{ aid: 99, folderId: "20", active: true }]);
    expect(notices).toEqual([]);
    expect((await service.toggle("BV1abc")).active).toBe(false);
    expect(api.writes[1]).toEqual({ aid: 99, folderId: "20", active: false });
  });

  it("deduplicates concurrent toggles into one write", async () => {
    const api = new FakeApi();
    const service = new FavoriteService(api, new MemorySettings(), {
      chooseFolder: async () => null,
      showNotice: () => undefined,
    });
    await service.load("BV1abc", "high");
    const [first, second] = await Promise.all([service.toggle("BV1abc"), service.toggle("BV1abc")]);
    expect(first.active).toBe(true);
    expect(second.active).toBe(true);
    expect(api.writes).toHaveLength(1);
  });

  it("reconciles an uncertain write without submitting it twice", async () => {
    class UncertainApi extends FakeApi {
      override async setFolderState(aid: number, folderId: string, active: boolean): Promise<void> {
        this.writes.push({ aid, folderId, active });
        this.active = active;
        throw new BiliApiError("connection lost", "transport");
      }
    }
    const api = new UncertainApi();
    const service = new FavoriteService(api, new MemorySettings(), {
      chooseFolder: async () => null,
      showNotice: () => undefined,
    });
    await service.load("BV1abc", "high");
    expect((await service.toggle("BV1abc")).active).toBe(true);
    expect(api.writes).toHaveLength(1);
  });

  it("clears a deleted quick folder so the next click can choose again", async () => {
    class DeletedFolderApi extends FakeApi {
      override async getFolderState(): Promise<boolean> {
        throw new BiliApiError("快捷收藏夹不存在或已被删除", "invalid");
      }
    }
    const settings = new MemorySettings();
    const notices: string[] = [];
    const service = new FavoriteService(new DeletedFolderApi(), settings, {
      chooseFolder: async () => null,
      showNotice: (message) => notices.push(message),
    });
    const result = await service.load("BV1abc", "high");
    expect(settings.value.foldersByMid["10"]).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(notices).toContain("快捷收藏夹已失效，请重新选择");
  });
});
