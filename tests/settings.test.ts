import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, folderStorageKey, normalizeSettings, PLAYBACK_KEY, SETTINGS_KEY, SettingsRepository } from "../src/shared/settings";

describe("normalizeSettings", () => {
  it("returns safe defaults for invalid input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid account folders and rejects malformed records", () => {
    expect(normalizeSettings({
      schemaVersion: 99,
      playbackEnabled: false,
      foldersByMid: {
        "123": { id: "456", title: "稍后看" },
        bad: { id: "1", title: "bad" },
        "999": { id: 1, title: "bad" },
      },
    })).toEqual({
      schemaVersion: 1,
      playbackEnabled: false,
      foldersByMid: { "123": { id: "456", title: "稍后看" } },
    });
  });
});

describe("SettingsRepository", () => {
  it("preserves independent changes written concurrently and reads legacy settings", async () => {
    const values: Record<string, unknown> = {
      [SETTINGS_KEY]: { schemaVersion: 1, playbackEnabled: true, foldersByMid: { "10": { id: "20", title: "旧收藏夹" } } },
    };
    vi.stubGlobal("chrome", { storage: { local: {
      get: async (keys: string[] | string | null) => {
        if (keys === null) return { ...values };
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]));
      },
      set: async (changes: Record<string, unknown>) => { Object.assign(values, changes); },
    } } });
    const settings = new SettingsRepository();
    expect(await settings.getFolder("10")).toEqual({ id: "20", title: "旧收藏夹" });
    await Promise.all([
      settings.setFolder("10", { id: "30", title: "新收藏夹" }),
      settings.setPlaybackEnabled(false),
    ]);
    expect(values[folderStorageKey("10")]).toEqual({ id: "30", title: "新收藏夹" });
    expect(values[PLAYBACK_KEY]).toBe(false);
    expect(await settings.load()).toMatchObject({ playbackEnabled: false, foldersByMid: { "10": { id: "30" } } });
    await settings.clearFolder("10");
    expect(await settings.getFolder("10")).toBeNull();
    vi.unstubAllGlobals();
  });
});
