export const EXTENSION_VERSION = "2.0.5";
export const DEFAULT_PLAYBACK_RATE = 1.5;

export interface QuickFolder {
  id: string;
  title: string;
}

export interface SettingsV1 {
  schemaVersion: 1;
  foldersByMid: Record<string, QuickFolder>;
  playbackEnabled: boolean;
}

export type FavoriteStatus =
  | "unknown"
  | "loading"
  | "inactive"
  | "active"
  | "mutating"
  | "error";

export interface FavoriteSnapshot {
  status: FavoriteStatus;
  active: boolean;
  configured: boolean;
  folderTitle: string | null;
  folderId?: string | null;
  mid?: string | null;
  checkedAt?: number;
  message?: string;
}

export interface ExtensionStatus {
  version: string;
  supportedPage: boolean;
  signedIn: boolean;
  accountStatus?: "signed-in" | "signed-out" | "error";
  folder: QuickFolder | null;
  playbackEnabled: boolean;
  playbackRate: number;
}

export type PopupRequest =
  | { type: "GET_STATUS" }
  | { type: "OPEN_FOLDER_PICKER" }
  | { type: "SET_PLAYBACK_ENABLED"; enabled: boolean };

export type PopupResponse =
  | { ok: true; status?: ExtensionStatus }
  | { ok: false; error: string };

export interface BiliFolder extends QuickFolder {
  favorite: boolean;
  mediaCount: number;
}

export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}
