import type { PopupRequest, PopupResponse } from "../shared/types";
import { DEFAULT_PLAYBACK_RATE, EXTENSION_VERSION } from "../shared/types";
import { FOLDER_KEY_PREFIX, PLAYBACK_KEY, SETTINGS_KEY, SettingsRepository } from "../shared/settings";
import { BiliApi } from "./api";
import { CoverController } from "./covers";
import { DetailController } from "./detail";
import { FavoriteService } from "./favorites";
import { OverlayUi } from "./overlay";
import { PlaybackController } from "./playback";
import { RouteCoordinator } from "./route";

async function waitForBody(): Promise<void> {
  if (document.body) return;
  await new Promise<void>((resolve) => {
    document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
  });
}

async function start(): Promise<void> {
  await waitForBody();
  if (document.getElementById("qfav-extension-root")) return;

  const settings = new SettingsRepository();
  const currentSettings = await settings.load();
  const ui = new OverlayUi();
  ui.host.dataset.version = EXTENSION_VERSION;
  ui.host.dataset.runtime = "chrome-extension";
  const service = new FavoriteService(new BiliApi(), settings, ui);
  const covers = new CoverController(service, ui);
  const detail = new DetailController(service, ui);
  const playback = new PlaybackController();
  const routes = new RouteCoordinator();

  playback.start(currentSettings.playbackEnabled);
  covers.start();
  detail.start();
  routes.subscribe((nextKey) => {
    service.resetRoute();
    covers.resetRoute();
    detail.resetRoute();
    playback.setRoute(nextKey);
  });
  routes.start();

  let legacyActive = false;
  const stopIfLegacy = () => {
    if (legacyActive || !document.getElementById("qfav-overlay-host")) return;
    legacyActive = true;
    service.invalidateContext();
    covers.destroy();
    detail.destroy();
    playback.destroy();
    routes.stop();
    legacyObserver.disconnect();
    ui.showNotice("检测到旧版油猴脚本，请先禁用旧版再使用扩展");
  };
  const legacyObserver = new MutationObserver(stopIfLegacy);
  legacyObserver.observe(document.body, { childList: true, subtree: true });
  stopIfLegacy();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PLAYBACK_KEY] || changes[SETTINGS_KEY]) {
      void settings.load().then((value) => playback.setEnabled(value.playbackEnabled));
    }
    if (Object.entries(changes).some(([key, change]) => {
      if (key === SETTINGS_KEY) return true;
      if (!key.startsWith(FOLDER_KEY_PREFIX)) return false;
      return !service.isOwnFolderChange(key.slice(FOLDER_KEY_PREFIX.length), change.newValue);
    })) {
      service.invalidateContext();
    }
  });
  window.addEventListener("focus", () => service.invalidateContext());

  chrome.runtime.onMessage.addListener(
    (request: PopupRequest, _sender, sendResponse: (response: PopupResponse) => void) => {
      void (async () => {
        try {
          if (legacyActive) throw new Error("请先禁用旧版油猴脚本");
          if (request.type === "GET_STATUS") {
            const value = await settings.load();
            sendResponse({ ok: true, status: await service.getExtensionStatus(value.playbackEnabled) });
            return;
          }
          if (request.type === "OPEN_FOLDER_PICKER") {
            await service.openFolderPicker();
            const value = await settings.load();
            sendResponse({ ok: true, status: await service.getExtensionStatus(value.playbackEnabled) });
            return;
          }
          if (request.type === "SET_PLAYBACK_ENABLED") {
            await settings.setPlaybackEnabled(request.enabled);
            playback.setEnabled(request.enabled);
            sendResponse({ ok: true });
          }
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : "操作失败" });
        }
      })();
      return true;
    },
  );

  console.info(`[B站快捷收藏] Chrome 扩展 ${EXTENSION_VERSION} 已启动，默认倍速 ${DEFAULT_PLAYBACK_RATE}x`);
}

void start().catch((error) => console.error("[B站快捷收藏] 扩展启动失败", error));
