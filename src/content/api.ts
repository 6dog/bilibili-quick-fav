import type { BiliFolder } from "../shared/types";

const API_ROOT = "https://api.bilibili.com";
const API_TIMEOUT_MS = 8_000;

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

export class BiliApiError extends Error {
  constructor(
    message: string,
    readonly kind: "transport" | "response" | "auth" | "invalid" | "folder-missing" | "cancelled",
    readonly code?: number,
  ) {
    super(message);
  }
}

function asEnvelope<T>(value: unknown): ApiEnvelope<T> {
  if (!value || typeof value !== "object" || typeof (value as { code?: unknown }).code !== "number") {
    throw new BiliApiError("B站接口返回了无法识别的数据", "invalid");
  }
  return value as ApiEnvelope<T>;
}

async function request<T>(path: string, init: RequestInit = {}, parentSignal?: AbortSignal): Promise<T> {
  if (!path.startsWith("/x/")) throw new BiliApiError("拒绝未知接口", "invalid");
  if (parentSignal?.aborted) throw new BiliApiError("请求已取消", "cancelled");
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(() => controller.abort("timeout"), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      credentials: "include",
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new BiliApiError(`HTTP ${response.status}`, "transport", response.status);
    }
    const envelope = asEnvelope<T>(await response.json());
    if (envelope.code !== 0) {
      const kind = envelope.code === -101 ? "auth" : "response";
      throw new BiliApiError(envelope.message || `B站接口错误 ${envelope.code}`, kind, envelope.code);
    }
    if (envelope.data === undefined) throw new BiliApiError("B站接口缺少数据", "invalid");
    return envelope.data;
  } catch (error) {
    if (error instanceof BiliApiError) throw error;
    if (controller.signal.aborted) {
      throw new BiliApiError(parentSignal?.aborted ? "请求已取消" : "请求超时", parentSignal?.aborted ? "cancelled" : "transport");
    }
    throw new BiliApiError("网络请求失败", "transport");
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function readCsrf(): string {
  const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
  if (!match?.[1]) throw new BiliApiError("未找到登录凭据，请刷新页面或重新登录", "auth");
  return decodeURIComponent(match[1]);
}

export function favoriteMutationBody(aid: number, folderId: string, active: boolean, csrf: string): URLSearchParams {
  const body = new URLSearchParams({ rid: String(aid), type: "2", csrf });
  body.set(active ? "add_media_ids" : "del_media_ids", folderId);
  return body;
}

export class BiliApi {
  async getViewerMid(signal?: AbortSignal): Promise<string> {
    const data = await request<{ mid?: number }>("/x/web-interface/nav", {}, signal);
    if (!Number.isFinite(data.mid) || Number(data.mid) <= 0) {
      throw new BiliApiError("尚未登录B站", "auth");
    }
    return String(data.mid);
  }

  async getAid(bvid: string, signal?: AbortSignal): Promise<number> {
    const data = await request<{ aid?: number }>(
      `/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      {},
      signal,
    );
    if (!Number.isFinite(data.aid) || Number(data.aid) <= 0) {
      throw new BiliApiError("无法识别视频编号", "invalid");
    }
    return Number(data.aid);
  }

  async getFolders(mid: string, aid?: number, signal?: AbortSignal): Promise<BiliFolder[]> {
    const query = new URLSearchParams({ up_mid: mid });
    if (aid) {
      query.set("type", "2");
      query.set("rid", String(aid));
    }
    const data = await request<{ list?: unknown[] }>(
      `/x/v3/fav/folder/created/list-all?${query}`,
      {},
      signal,
    );
    if (!Array.isArray(data.list)) throw new BiliApiError("收藏夹列表无效", "invalid");
    return data.list.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (!Number.isFinite(Number(row.id)) || typeof row.title !== "string") return [];
      return [{
        id: String(row.id),
        title: row.title,
        favorite: row.fav_state === 1,
        mediaCount: Number.isFinite(Number(row.media_count)) ? Number(row.media_count) : 0,
      }];
    });
  }

  async getFolderState(mid: string, aid: number, folderId: string, signal?: AbortSignal): Promise<boolean> {
    const query = new URLSearchParams({ up_mid: mid, type: "2", rid: String(aid) });
    const data = await request<{ list?: unknown[] }>(`/x/v3/fav/folder/created/list-all?${query}`, {}, signal);
    if (!Array.isArray(data.list)) throw new BiliApiError("收藏夹列表无效", "invalid");
    const folders = data.list.map((item) => {
      if (!item || typeof item !== "object") throw new BiliApiError("收藏夹数据无效", "invalid");
      const row = item as Record<string, unknown>;
      if (!/^\d+$/.test(String(row.id)) || Number(row.id) <= 0 || typeof row.title !== "string") {
        throw new BiliApiError("收藏夹数据无效", "invalid");
      }
      return row;
    });
    const folder = folders.find((item) => String(item.id) === folderId);
    if (!folder) throw new BiliApiError("快捷收藏夹不存在或已被删除", "folder-missing");
    if (![0, 1, "0", "1"].includes(folder.fav_state as string | number)) throw new BiliApiError("无法确认收藏状态", "invalid");
    return Number(folder.fav_state) === 1;
  }

  async setFolderState(aid: number, folderId: string, active: boolean, signal?: AbortSignal): Promise<void> {
    const csrf = readCsrf();
    const body = favoriteMutationBody(aid, folderId, active, csrf);
    await request<unknown>(
      "/x/v3/fav/resource/deal",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      signal,
    );
  }
}
