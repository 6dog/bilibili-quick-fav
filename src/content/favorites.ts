import type { ExtensionStatus, FavoriteSnapshot, QuickFolder } from "../shared/types";
import { DEFAULT_PLAYBACK_RATE, EXTENSION_VERSION } from "../shared/types";
import { SettingsRepository } from "../shared/settings";
import { BiliApi, BiliApiError } from "./api";
import { OverlayUi } from "./overlay";
import { TaskQueue, type QueuedTaskHandle } from "./task-queue";

type Subscriber = (snapshot: FavoriteSnapshot) => void;
type Context = { mid: string; folder: QuickFolder | null };
const CACHE_MS = 30_000;
const INITIAL_SNAPSHOT: FavoriteSnapshot = { status: "unknown", active: false, configured: false, folderTitle: null };

export class FavoriteService {
  readonly #entries = new Map<string, FavoriteSnapshot>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();
  readonly #aidCache = new Map<string, number>();
  readonly #stateLoads = new Map<string, QueuedTaskHandle<FavoriteSnapshot>>();
  readonly #toggles = new Map<string, Promise<FavoriteSnapshot>>();
  readonly #queue = new TaskQueue(4);
  readonly #ownFolderChanges = new Map<string, string>();
  #midPromise: Promise<string> | null = null;
  #midCheckedAt = 0;
  #generation = new AbortController();
  #epoch = 0;
  #cacheEpoch = 0;

  constructor(
    readonly api: BiliApi,
    readonly settings: SettingsRepository,
    readonly ui: Pick<OverlayUi, "chooseFolder" | "showNotice"> & Partial<Pick<OverlayUi, "cancelFolderPicker">>,
  ) {}

  snapshot(bvid: string): FavoriteSnapshot { return this.#entries.get(bvid) ?? INITIAL_SNAPSHOT; }

  subscribe(bvid: string, subscriber: Subscriber): () => void {
    let group = this.#subscribers.get(bvid);
    if (!group) { group = new Set(); this.#subscribers.set(bvid, group); }
    group.add(subscriber);
    subscriber(this.snapshot(bvid));
    return () => { group?.delete(subscriber); if (group?.size === 0) this.#subscribers.delete(bvid); };
  }

  private publish(bvid: string, snapshot: FavoriteSnapshot): FavoriteSnapshot {
    this.#entries.set(bvid, snapshot);
    for (const subscriber of this.#subscribers.get(bvid) ?? []) subscriber(snapshot);
    return snapshot;
  }

  private current(epoch: number): boolean { return epoch === this.#epoch && !this.#generation.signal.aborted; }
  private publishCurrent(epoch: number, cacheEpoch: number, startedAt: number, bvid: string, snapshot: FavoriteSnapshot): FavoriteSnapshot {
    const latest = this.snapshot(bvid);
    if (!this.current(epoch) || cacheEpoch !== this.#cacheEpoch || latest.status === "mutating" || (latest.checkedAt ?? 0) > startedAt) return latest;
    return this.publish(bvid, snapshot);
  }

  private async mid(force = false): Promise<string> {
    if (force || Date.now() - this.#midCheckedAt > CACHE_MS) this.#midPromise = null;
    if (!this.#midPromise) {
      const controller = this.#generation;
      const promise = this.api.getViewerMid(controller.signal);
      this.#midPromise = promise;
      this.#midCheckedAt = Date.now();
      void promise.catch(() => { if (this.#midPromise === promise) this.#midPromise = null; });
    }
    return this.#midPromise;
  }

  private async context(chooseIfMissing: boolean, epoch: number): Promise<Context> {
    const mid = await this.mid();
    if (!this.current(epoch)) throw new BiliApiError("页面已切换", "cancelled");
    let folder = await this.settings.getFolder(mid);
    if (!this.current(epoch)) throw new BiliApiError("页面已切换", "cancelled");
    if (!folder && chooseIfMissing) folder = await this.openFolderPicker(mid, epoch, true);
    if (!this.current(epoch) && folder) throw new BiliApiError("页面已切换", "cancelled");
    return { mid, folder };
  }

  async openFolderPicker(knownMid?: string, expectedEpoch = this.#epoch, preserveOperation = false): Promise<QuickFolder | null> {
    const mid = knownMid ?? (await this.mid(true));
    if (!this.current(expectedEpoch)) return null;
    const folders = await this.api.getFolders(mid, undefined, this.#generation.signal);
    if (!this.current(expectedEpoch)) return null;
    if (folders.length === 0) { this.ui.showNotice("你的B站账号还没有收藏夹"); return null; }
    const selected = await this.ui.chooseFolder(folders);
    if (!selected || !this.current(expectedEpoch)) return null;
    if (await this.mid(true) !== mid || !this.current(expectedEpoch)) return null;
    const folder = { id: selected.id, title: selected.title };
    if (!preserveOperation) this.invalidateContext();
    this.#ownFolderChanges.set(mid, JSON.stringify(folder));
    await this.settings.setFolder(mid, folder);
    if (!preserveOperation || this.current(expectedEpoch)) this.invalidateAll(folder);
    return folder;
  }

  private invalidateAll(folder: QuickFolder | null = null): void {
    this.#cacheEpoch += 1;
    this.#stateLoads.clear();
    this.#entries.clear();
    for (const [bvid, subscribers] of this.#subscribers) {
      const snapshot: FavoriteSnapshot = { ...INITIAL_SNAPSHOT, configured: folder !== null, folderTitle: folder?.title ?? null, folderId: folder?.id ?? null };
      for (const subscriber of subscribers) subscriber(snapshot);
      if (folder) void this.load(bvid, "high");
    }
  }

  invalidateContext(): void {
    this.#generation.abort("context changed");
    this.ui.cancelFolderPicker?.();
    this.#generation = new AbortController();
    this.#epoch += 1;
    this.#midPromise = null;
    this.#midCheckedAt = 0;
    this.#stateLoads.clear();
    this.#toggles.clear();
    this.invalidateAll();
  }

  private async aid(bvid: string, epoch: number): Promise<number> {
    const cached = this.#aidCache.get(bvid);
    if (cached) return cached;
    const aid = await this.api.getAid(bvid, this.#generation.signal);
    if (!this.current(epoch)) throw new BiliApiError("页面已切换", "cancelled");
    this.#aidCache.set(bvid, aid);
    if (this.#aidCache.size > 300) this.#aidCache.delete(this.#aidCache.keys().next().value!);
    return aid;
  }

  async load(bvid: string, priority: "high" | "normal" = "normal", force = false): Promise<FavoriteSnapshot> {
    const current = this.snapshot(bvid);
    if (!force && (current.status === "active" || current.status === "inactive") && Date.now() - (current.checkedAt ?? 0) < CACHE_MS) return current;
    if (priority === "normal" && this.#queue.pending >= 100) return current;
    const pending = this.#stateLoads.get(bvid);
    if (pending && !force) { if (priority === "high") pending.promote(); return pending.promise; }
    const epoch = this.#epoch;
    const cacheEpoch = this.#cacheEpoch;
    const startedAt = Date.now();
    const stillCurrent = () => this.current(epoch) && cacheEpoch === this.#cacheEpoch;
    const handle = this.#queue.add(async () => {
      let context: Context | null = null;
      try {
        if (!stillCurrent()) return this.snapshot(bvid);
        context = await this.context(false, epoch);
        if (!stillCurrent()) return this.snapshot(bvid);
        if (!context.folder) return this.publishCurrent(epoch, cacheEpoch, startedAt, bvid, { ...INITIAL_SNAPSHOT, status: "inactive", checkedAt: Date.now() });
        const { mid, folder } = context;
        this.publishCurrent(epoch, cacheEpoch, startedAt, bvid, { status: "loading", active: current.active, configured: true, folderTitle: folder.title, folderId: folder.id, mid });
        const aid = await this.aid(bvid, epoch);
        const active = await this.api.getFolderState(mid, aid, folder.id, this.#generation.signal);
        return this.publishCurrent(epoch, cacheEpoch, startedAt, bvid, { status: active ? "active" : "inactive", active, configured: true, folderTitle: folder.title, folderId: folder.id, mid, checkedAt: Date.now() });
      } catch (error) {
        if (!stillCurrent()) return this.snapshot(bvid);
        if (this.snapshot(bvid).status === "mutating" || (this.snapshot(bvid).checkedAt ?? 0) > startedAt) return this.snapshot(bvid);
        if (context?.folder && error instanceof BiliApiError && error.kind === "folder-missing") {
          await this.clearMissingFolder(context.mid, context.folder, epoch);
        }
        return stillCurrent() ? this.handleLoadError(bvid, error, epoch) : this.snapshot(bvid);
      } finally {
        if (this.#stateLoads.get(bvid) === handle) this.#stateLoads.delete(bvid);
      }
    }, priority);
    this.#stateLoads.set(bvid, handle);
    return handle.promise;
  }

  private async clearMissingFolder(mid: string, folder: QuickFolder, epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    const saved = await this.settings.getFolder(mid);
    if (!this.current(epoch) || saved?.id !== folder.id) return;
    this.#ownFolderChanges.set(mid, "null");
    await this.settings.clearFolder(mid);
    if (!this.current(epoch)) return;
    this.invalidateAll(null);
    this.ui.showNotice("快捷收藏夹已失效，请重新选择");
  }

  private handleLoadError(bvid: string, error: unknown, epoch: number): FavoriteSnapshot {
    if (!this.current(epoch)) return this.snapshot(bvid);
    const previous = this.snapshot(bvid);
    const message = error instanceof Error ? error.message : "暂时无法读取收藏状态";
    return this.publish(bvid, { ...previous, status: "error", message });
  }

  async toggle(bvid: string): Promise<FavoriteSnapshot> {
    const pending = this.#toggles.get(bvid);
    if (pending) return pending;
    const epoch = this.#epoch;
    const promise = this.performToggle(bvid, epoch).finally(() => { if (this.#toggles.get(bvid) === promise) this.#toggles.delete(bvid); });
    this.#toggles.set(bvid, promise);
    return promise;
  }

  private async performToggle(bvid: string, epoch: number): Promise<FavoriteSnapshot> {
    let context: Context | null = null;
    try {
      context = await this.context(true, epoch);
      if (!context.folder || !this.current(epoch)) return this.snapshot(bvid);
      const { mid, folder } = context;
      const aid = await this.aid(bvid, epoch);
      // Recheck the account, selected folder and live state immediately before a write.
      const freshMid = await this.mid(true);
      const selected = await this.settings.getFolder(mid);
      if (!this.current(epoch) || freshMid !== mid || selected?.id !== folder.id) return this.snapshot(bvid);
      const active = await this.api.getFolderState(mid, aid, folder.id, this.#generation.signal);
      if (!this.current(epoch)) return this.snapshot(bvid);
      const desired = !active;
      const previous: FavoriteSnapshot = { status: active ? "active" : "inactive", active, configured: true, folderTitle: folder.title, folderId: folder.id, mid, checkedAt: Date.now() };
      this.publish(bvid, { ...previous, status: "mutating", active: desired });
      // Storage can change in another tab while the state request is in flight.
      const latest = await this.settings.getFolder(mid);
      if (!this.current(epoch) || latest?.id !== folder.id) return this.snapshot(bvid);
      try {
        await this.api.setFolderState(aid, folder.id, desired, this.#generation.signal);
      } catch (error) {
        const reconciled = await this.reconcile(mid, aid, folder, desired, epoch);
        if (!this.current(epoch)) return this.snapshot(bvid);
        if (reconciled !== null) {
          if (reconciled === desired) return this.publishConfirmed(bvid, mid, folder, desired, epoch);
          const result = this.publish(bvid, { ...previous, status: reconciled ? "active" : "inactive", active: reconciled, message: "B站未确认本次操作" });
          this.ui.showNotice("收藏状态没有改变，请稍后重试");
          return result;
        }
        const message = error instanceof Error ? error.message : "操作结果暂时无法确认";
        this.ui.showNotice(`${message}，没有自动重试写入`);
        return this.publish(bvid, { ...previous, status: "error", message });
      }
      if (!this.current(epoch)) return this.snapshot(bvid);
      return this.publishConfirmed(bvid, mid, folder, desired, epoch);
    } catch (error) {
      if (!this.current(epoch)) return this.snapshot(bvid);
      if (context?.folder && error instanceof BiliApiError && error.kind === "folder-missing") await this.clearMissingFolder(context.mid, context.folder, epoch);
      const message = error instanceof Error ? error.message : "收藏操作失败";
      this.ui.showNotice(message);
      return this.handleLoadError(bvid, error, epoch);
    }
  }

  private publishConfirmed(bvid: string, mid: string, folder: QuickFolder, active: boolean, epoch: number): FavoriteSnapshot {
    if (!this.current(epoch)) return this.snapshot(bvid);
    const result = this.publish(bvid, { status: active ? "active" : "inactive", active, configured: true, folderTitle: folder.title, folderId: folder.id, mid, checkedAt: Date.now() });
    this.ui.showNotice(active ? `已收藏到「${folder.title}」` : `已从「${folder.title}」移除`);
    return result;
  }

  private async reconcile(mid: string, aid: number, folder: QuickFolder, desired: boolean, epoch: number): Promise<boolean | null> {
    for (const delay of [0, 250, 650, 1_200]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (!this.current(epoch)) return null;
      try {
        const active = await this.api.getFolderState(mid, aid, folder.id, this.#generation.signal);
        if (active === desired || delay === 1_200) return active;
      } catch (error) {
        if (error instanceof BiliApiError && error.kind === "folder-missing") { await this.clearMissingFolder(mid, folder, epoch); return null; }
      }
    }
    return null;
  }

  async getExtensionStatus(playbackEnabled: boolean): Promise<ExtensionStatus> {
    try {
      const mid = await this.mid(true);
      const folder = await this.settings.getFolder(mid);
      return { version: EXTENSION_VERSION, supportedPage: true, signedIn: true, accountStatus: "signed-in", folder, playbackEnabled, playbackRate: DEFAULT_PLAYBACK_RATE };
    } catch (error) {
      const signedOut = error instanceof BiliApiError && error.kind === "auth";
      return { version: EXTENSION_VERSION, supportedPage: true, signedIn: false, accountStatus: signedOut ? "signed-out" : "error", folder: null, playbackEnabled, playbackRate: DEFAULT_PLAYBACK_RATE };
    }
  }

  resetRoute(): void { this.invalidateContext(); }

  isOwnFolderChange(mid: string, value: unknown): boolean {
    if (this.#ownFolderChanges.get(mid) !== JSON.stringify(value)) return false;
    this.#ownFolderChanges.delete(mid);
    return true;
  }
}
