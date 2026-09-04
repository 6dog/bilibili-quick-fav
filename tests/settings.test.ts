import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";

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
