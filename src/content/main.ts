import type { PopupRequest, PopupResponse } from "../shared/types";
import { DEFAULT_PLAYBACK_RATE, EXTENSION_VERSION } from "../shared/types";
import { SettingsRepository } from "../shared/settings";
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

  chrome.runtime.onMessage.addListener(
    (request: PopupRequest, _sender, sendResponse: (response: PopupResponse) => void) => {
      void (async () => {
        try {
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
