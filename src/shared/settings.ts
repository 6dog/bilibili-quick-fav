import type { QuickFolder, SettingsV1 } from "./types";

export const SETTINGS_KEY = "qfav.settings.v1";
export const PLAYBACK_KEY = "qfav.playback.v2";
export const FOLDER_KEY_PREFIX = "qfav.folder.v2.";
export const folderStorageKey = (mid: string): string => `${FOLDER_KEY_PREFIX}${mid}`;

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
    const result = await chrome.storage.local.get(null);
    const settings = normalizeSettings(result[SETTINGS_KEY]);
    if (typeof result[PLAYBACK_KEY] === "boolean") settings.playbackEnabled = result[PLAYBACK_KEY];
    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith(FOLDER_KEY_PREFIX)) continue;
      const mid = key.slice(FOLDER_KEY_PREFIX.length);
      if (!/^\d+$/.test(mid)) continue;
      if (value === null) delete settings.foldersByMid[mid];
      else {
        const normalized = normalizeSettings({ foldersByMid: { [mid]: value } }).foldersByMid[mid];
        if (normalized) settings.foldersByMid[mid] = normalized;
      }
    }
    return settings;
  }

  async save(settings: SettingsV1): Promise<void> {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  async getFolder(mid: string): Promise<QuickFolder | null> {
    if (!/^\d+$/.test(mid)) return null;
    const key = folderStorageKey(mid);
    const result = await chrome.storage.local.get([key, SETTINGS_KEY]);
    if (Object.hasOwn(result, key)) {
      return normalizeSettings({ foldersByMid: { [mid]: result[key] } }).foldersByMid[mid] ?? null;
    }
    return normalizeSettings(result[SETTINGS_KEY]).foldersByMid[mid] ?? null;
  }

  async setFolder(mid: string, folder: QuickFolder): Promise<void> {
    await chrome.storage.local.set({ [folderStorageKey(mid)]: folder });
  }

  async clearFolder(mid: string): Promise<void> {
    await chrome.storage.local.set({ [folderStorageKey(mid)]: null });
  }

  async setPlaybackEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.local.set({ [PLAYBACK_KEY]: enabled });
  }
}
