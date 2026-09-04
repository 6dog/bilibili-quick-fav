import type { QuickFolder, SettingsV1 } from "./types";

export const SETTINGS_KEY = "qfav.settings.v1";

export const DEFAULT_SETTINGS: SettingsV1 = {
  schemaVersion: 1,
  foldersByMid: {},
  playbackEnabled: true,
};

export function normalizeSettings(value: unknown): SettingsV1 {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const candidate = value as Partial<SettingsV1>;
  const foldersByMid: Record<string, QuickFolder> = {};
  if (candidate.foldersByMid && typeof candidate.foldersByMid === "object") {
    for (const [mid, folder] of Object.entries(candidate.foldersByMid)) {
      if (
        /^\d+$/.test(mid) &&
        folder &&
        typeof folder === "object" &&
        typeof folder.id === "string" &&
        folder.id.length > 0 &&
        typeof folder.title === "string"
      ) {
        foldersByMid[mid] = { id: folder.id, title: folder.title };
      }
    }
  }
  return {
    schemaVersion: 1,
    foldersByMid,
    playbackEnabled:
      typeof candidate.playbackEnabled === "boolean"
        ? candidate.playbackEnabled
        : true,
  };
}

export class SettingsRepository {
  async load(): Promise<SettingsV1> {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(result[SETTINGS_KEY]);
  }

  async save(settings: SettingsV1): Promise<void> {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async getFolder(mid: string): Promise<QuickFolder | null> {
    const settings = await this.load();
    return settings.foldersByMid[mid] ?? null;
  }

  async setFolder(mid: string, folder: QuickFolder): Promise<void> {
    const settings = await this.load();
    settings.foldersByMid[mid] = folder;
    await this.save(settings);
  }

  async clearFolder(mid: string): Promise<void> {
    const settings = await this.load();
    delete settings.foldersByMid[mid];
    await this.save(settings);
  }

  async setPlaybackEnabled(enabled: boolean): Promise<void> {
    const settings = await this.load();
    settings.playbackEnabled = enabled;
    await this.save(settings);
  }
}
