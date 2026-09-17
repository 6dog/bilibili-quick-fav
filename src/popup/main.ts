import type { ExtensionStatus, PopupRequest, PopupResponse } from "../shared/types";

const folder = document.querySelector<HTMLElement>("#folder")!;
const version = document.querySelector<HTMLElement>("#version")!;
const message = document.querySelector<HTMLElement>("#message")!;
const chooseButton = document.querySelector<HTMLButtonElement>("#choose-folder")!;
const playbackToggle = document.querySelector<HTMLInputElement>("#playback-enabled")!;

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("请先打开一个B站页面");
  return tab.id;
}

async function send(request: PopupRequest): Promise<PopupResponse> {
  try {
    return await chrome.tabs.sendMessage(await activeTabId(), request) as PopupResponse;
  } catch {
    throw new Error("请在B站页面中使用这个扩展");
  }
}

function render(status: ExtensionStatus): void {
  version.textContent = `版本 ${status.version} · ${status.accountStatus === "error" ? "账号读取失败" : status.signedIn ? "已登录" : "未登录"}`;
  folder.textContent = status.folder?.title ?? "尚未选择";
  playbackToggle.checked = status.playbackEnabled;
  chooseButton.disabled = !status.signedIn;
}

async function refresh(): Promise<void> {
  message.textContent = "";
  const response = await send({ type: "GET_STATUS" });
  if (!response.ok || !response.status) throw new Error(response.ok ? "无法读取状态" : response.error);
  render(response.status);
}

chooseButton.addEventListener("click", async () => {
  chooseButton.disabled = true;
  try {
    const response = await send({ type: "OPEN_FOLDER_PICKER" });
    if (!response.ok) throw new Error(response.error);
    window.close();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : "操作失败";
    chooseButton.disabled = false;
  }
});

playbackToggle.addEventListener("change", async () => {
  playbackToggle.disabled = true;
  try {
    const response = await send({ type: "SET_PLAYBACK_ENABLED", enabled: playbackToggle.checked });
    if (!response.ok) throw new Error(response.error);
  } catch (error) {
    playbackToggle.checked = !playbackToggle.checked;
    message.textContent = error instanceof Error ? error.message : "操作失败";
  } finally {
    playbackToggle.disabled = false;
  }
});

void refresh().catch((error) => {
  folder.textContent = "不可用";
  chooseButton.disabled = true;
  playbackToggle.disabled = true;
  version.textContent = "未连接B站页面";
  message.textContent = error instanceof Error ? error.message : "连接失败";
});
