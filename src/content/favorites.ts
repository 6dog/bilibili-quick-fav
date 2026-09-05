import type { ExtensionStatus, FavoriteSnapshot, QuickFolder } from "../shared/types";
import { DEFAULT_PLAYBACK_RATE, EXTENSION_VERSION } from "../shared/types";
import { SettingsRepository } from "../shared/settings";
import { BiliApi, BiliApiError } from "./api";
import { OverlayUi } from "./overlay";
import { TaskQueue } from "./task-queue";

type Subscriber = (snapshot: FavoriteSnapshot) => void;

const INITIAL_SNAPSHOT: FavoriteSnapshot = {
  status: "unknown",
  active: false,
  configured: false,
  folderTitle: null,
};

export class FavoriteService {
  readonly #entries = new Map<string, FavoriteSnapshot>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  readonly #aidCache = new Map<string, number>();
  readonly #stateLoads = new Map<string, Promise<FavoriteSnapshot>>();
  readonly #toggles = new Map<string, Promise<FavoriteSnapshot>>();
  readonly #queue = new TaskQueue(4);
  #midPromise: Promise<string> | null = null;
  #generation = new AbortController();

  constructor(
    readonly api: BiliApi,
    readonly settings: SettingsRepository,
    readonly ui: Pick<OverlayUi, "chooseFolder" | "showNotice">,
  ) {}

  snapshot(bvid: string): FavoriteSnapshot {
    return this.#entries.get(bvid) ?? INITIAL_SNAPSHOT;
  }

  subscribe(bvid: string, subscriber: Subscriber): () => void {
    let group = this.#subscribers.get(bvid);
    if (!group) {
      group = new Set();
      this.#subscribers.set(bvid, group);
    }
    group.add(subscriber);
    subscriber(this.snapshot(bvid));
    return () => {
      group?.delete(subscriber);
      if (group?.size === 0) this.#subscribers.delete(bvid);
    };
  }

  private publish(bvid: string, snapshot: FavoriteSnapshot): FavoriteSnapshot {
    this.#entries.set(bvid, snapshot);
    for (const subscriber of this.#subscribers.get(bvid) ?? []) subscriber(snapshot);
    return snapshot;
  }

  private async mid(): Promise<string> {
    if (!this.#midPromise) {
      this.#midPromise = this.api.getViewerMid(this.#generation.signal).catch((error) => {
        this.#midPromise = null;
        throw error;
      });
    }
    return this.#midPromise;
  }

  private async context(chooseIfMissing: boolean): Promise<{ mid: string; folder: QuickFolder | null }> {
    const mid = await this.mid();
    let folder = await this.settings.getFolder(mid);
    if (!folder && chooseIfMissing) folder = await this.openFolderPicker(mid);
    return { mid, folder };
  }

  async openFolderPicker(knownMid?: string): Promise<QuickFolder | null> {
    const mid = knownMid ?? (await this.mid());
    const folders = await this.api.getFolders(mid, undefined, this.#generation.signal);
    if (folders.length === 0) {
      this.ui.showNotice("你的B站账号还没有收藏夹");
      return null;
    }
    const selected = await this.ui.chooseFolder(folders);
    if (!selected) return null;
    const folder = { id: selected.id, title: selected.title };
    await this.settings.setFolder(mid, folder);
    this.invalidateAll(folder);
    return folder;
  }

  private invalidateAll(folder: QuickFolder | null = null): void {
    this.#entries.clear();
    for (const [bvid, subscribers] of this.#subscribers) {
      const snapshot: FavoriteSnapshot = {
        ...INITIAL_SNAPSHOT,
        configured: folder !== null,
        folderTitle: folder?.title ?? null,
      };
      for (const subscriber of subscribers) subscriber(snapshot);
      if (folder) void this.load(bvid, "high");
    }
  }

  private async aid(bvid: string): Promise<number> {
    const cached = this.#aidCache.get(bvid);
    if (cached) return cached;
    const aid = await this.api.getAid(bvid, this.#generation.signal);
    this.#aidCache.set(bvid, aid);
    return aid;
  }

  async load(bvid: string, priority: "high" | "normal" = "normal"): Promise<FavoriteSnapshot> {
    const current = this.snapshot(bvid);
    if (current.status === "active" || current.status === "inactive") return current;
    const pending = this.#stateLoads.get(bvid);
    if (pending) return pending;

    const promise = this.#queue.add(async () => {
      let viewerMid: string | null = null;
      try {
        const { mid, folder } = await this.context(false);
        viewerMid = mid;
        if (!folder) {
          return this.publish(bvid, {
            status: "inactive",
            active: false,
            configured: false,
            folderTitle: null,
          });
        }
        this.publish(bvid, {
          status: "loading",
          active: current.active,
          configured: true,
          folderTitle: folder.title,
        });
        const aid = await this.aid(bvid);
        const active = await this.api.getFolderState(mid, aid, folder.id, this.#generation.signal);
        return this.publish(bvid, {
          status: active ? "active" : "inactive",
          active,
          configured: true,
          folderTitle: folder.title,
        });
      } catch (error) {
        if (viewerMid && error instanceof BiliApiError && error.kind === "invalid") {
          await this.settings.clearFolder(viewerMid);
          this.invalidateAll(null);
          this.ui.showNotice("快捷收藏夹已失效，请重新选择");
        }
        return this.handleLoadError(bvid, error);
      } finally {
        this.#stateLoads.delete(bvid);
      }
    }, priority);
    this.#stateLoads.set(bvid, promise);
    return promise;
  }

  private handleLoadError(bvid: string, error: unknown): FavoriteSnapshot {
    const message = error instanceof Error ? error.message : "暂时无法读取收藏状态";
    return this.publish(bvid, {
      status: "error",
      active: this.snapshot(bvid).active,
      configured: this.snapshot(bvid).configured,
      folderTitle: this.snapshot(bvid).folderTitle,
      message,
    });
  }

  async toggle(bvid: string): Promise<FavoriteSnapshot> {
    const pending = this.#toggles.get(bvid);
    if (pending) return pending;
    const promise = this.performToggle(bvid).finally(() => this.#toggles.delete(bvid));
    this.#toggles.set(bvid, promise);
    return promise;
  }

  private async performToggle(bvid: string): Promise<FavoriteSnapshot> {
    try {
      const { mid, folder } = await this.context(true);
      if (!folder) return this.snapshot(bvid);
      let previous = await this.load(bvid, "high");
      if (!previous.configured || previous.folderTitle !== folder.title) {
        this.#entries.delete(bvid);
        previous = await this.load(bvid, "high");
      }
      if (previous.status !== "active" && previous.status !== "inactive") {
        this.ui.showNotice(previous.message || "暂时无法确认收藏状态，请稍后重试");
        return previous;
      }
      const desired = !previous.active;
      this.publish(bvid, { ...previous, status: "mutating" });
      const aid = await this.aid(bvid);
      let writeError: unknown = null;
      try {
        await this.api.setFolderState(aid, folder.id, desired, this.#generation.signal);
      } catch (error) {
        writeError = error;
      }

      const reconciled = await this.reconcile(mid, aid, folder, desired);
      if (reconciled !== null) {
        const result = this.publish(bvid, {
          status: reconciled ? "active" : "inactive",
          active: reconciled,
          configured: true,
          folderTitle: folder.title,
          ...(reconciled === desired ? {} : { message: "B站未确认本次操作" }),
        });
        if (reconciled === desired) {
          this.ui.showNotice(desired ? `已收藏到「${folder.title}」` : `已从「${folder.title}」移除`);
        } else {
          this.ui.showNotice("收藏状态没有改变，请稍后重试");
        }
        return result;
      }

      const message = writeError instanceof Error ? writeError.message : "操作结果暂时无法确认";
      this.ui.showNotice(`${message}，没有自动重试写入`);
      return this.publish(bvid, {
        status: "error",
        active: previous.active,
        configured: true,
        folderTitle: folder.title,
        message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "收藏操作失败";
      this.ui.showNotice(message);
      return this.handleLoadError(bvid, error);
    }
  }

  private async reconcile(mid: string, aid: number, folder: QuickFolder, desired: boolean): Promise<boolean | null> {
    for (const delay of [0, 250, 650, 1_200]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      try {
        const active = await this.api.getFolderState(mid, aid, folder.id, this.#generation.signal);
        if (active === desired || delay === 1_200) return active;
      } catch (error) {
        if (error instanceof BiliApiError && error.kind === "invalid") {
          await this.settings.clearFolder(mid);
          this.invalidateAll(null);
          this.ui.showNotice("快捷收藏夹已失效，请重新选择");
          return null;
        }
      }
    }
    return null;
  }

  async getExtensionStatus(playbackEnabled: boolean): Promise<ExtensionStatus> {
    try {
      const { folder } = await this.context(false);
      return {
        version: EXTENSION_VERSION,
        supportedPage: true,
        signedIn: true,
        folder,
        playbackEnabled,
        playbackRate: DEFAULT_PLAYBACK_RATE,
      };
    } catch {
      return {
        version: EXTENSION_VERSION,
        supportedPage: true,
        signedIn: false,
        folder: null,
        playbackEnabled,
        playbackRate: DEFAULT_PLAYBACK_RATE,
      };
    }
  }

  resetRoute(): void {
    this.#generation.abort("route changed");
    this.#generation = new AbortController();
    this.#midPromise = null;
    this.#stateLoads.clear();
    this.#toggles.clear();
    this.invalidateAll(null);
  }
}
