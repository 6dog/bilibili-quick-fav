import { DEFAULT_PLAYBACK_RATE } from "../shared/types";
import { isSupportedPlaybackPage, semanticRouteKey } from "./route";

const VIDEO_SELECTOR = [
  ".bpx-player-video-wrap video",
  ".bpx-player-primary-area video",
  "#bilibili-player video",
  ".bilibili-player-video video",
  ".squirtle-video-wrap video",
].join(",");
const SPEED_ITEM_SELECTOR = [
  ".bpx-player-ctrl-playbackrate-menu-item",
  ".bilibili-player-video-btn-speed-menu-list-item",
  "li.squirtle-select-item",
].join(",");

export interface PlaybackSession {
  routeKey: string;
  manualRate: number | null;
  internalUntil: number;
  resetUntil: number;
}

export function parseRate(value: string | null | undefined): number | null {
  const match = String(value ?? "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

export function desiredRate(session: PlaybackSession): number {
  return session.manualRate ?? DEFAULT_PLAYBACK_RATE;
}

function closeEnough(a: number, b: number): boolean {
  return Number.isFinite(a) && Math.abs(a - b) < 0.01;
}

function findMainVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll<HTMLVideoElement>(VIDEO_SELECTOR)];
  return videos.find((video) => video.isConnected && video.getClientRects().length > 0) ?? null;
}

export class PlaybackController {
  #enabled = true;
  #video: HTMLVideoElement | null = null;
  #session: PlaybackSession = {
    routeKey: semanticRouteKey(),
    manualRate: null,
    internalUntil: 0,
    resetUntil: 0,
  };
  #observer = new MutationObserver(() => this.scheduleScan());
  #scanFrame = 0;
  #timers = new Set<number>();

  start(enabled: boolean): void {
    this.#enabled = enabled;
    this.#observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", this.onDocumentClick, true);
    this.scan();
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (enabled) this.scheduleScan();
    else this.clearTimers();
  }

  setRoute(routeKey: string): void {
    if (routeKey === this.#session.routeKey) return;
    this.#session = { routeKey, manualRate: null, internalUntil: 0, resetUntil: 0 };
    this.detachVideo();
    this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.#scanFrame) return;
    this.#scanFrame = requestAnimationFrame(() => {
      this.#scanFrame = 0;
      this.scan();
    });
  }

  private scan(): void {
    if (!this.#enabled || !isSupportedPlaybackPage()) return;
    const video = findMainVideo();
    if (!video) return;
    if (video !== this.#video) this.attachVideo(video);
    this.scheduleApplySequence();
  }

  private attachVideo(video: HTMLVideoElement): void {
    this.detachVideo();
    this.#video = video;
    video.addEventListener("ratechange", this.onRateChange);
    video.addEventListener("loadstart", this.onResetEvent);
    video.addEventListener("emptied", this.onResetEvent);
    video.addEventListener("loadedmetadata", this.onPlayableEvent);
    video.addEventListener("canplay", this.onPlayableEvent);
    video.addEventListener("play", this.onPlayableEvent);
  }

  private detachVideo(): void {
    if (!this.#video) return;
    this.#video.removeEventListener("ratechange", this.onRateChange);
    this.#video.removeEventListener("loadstart", this.onResetEvent);
    this.#video.removeEventListener("emptied", this.onResetEvent);
    this.#video.removeEventListener("loadedmetadata", this.onPlayableEvent);
    this.#video.removeEventListener("canplay", this.onPlayableEvent);
    this.#video.removeEventListener("play", this.onPlayableEvent);
    this.#video = null;
  }

  private applyDesiredRate(): void {
    if (!this.#enabled || !this.#video?.isConnected || !isSupportedPlaybackPage()) return;
    const rate = desiredRate(this.#session);
    if (closeEnough(this.#video.playbackRate, rate)) return;
    this.#session.internalUntil = performance.now() + 250;
    try {
      this.#video.defaultPlaybackRate = rate;
      this.#video.playbackRate = rate;
    } catch {
      // A later bounded retry handles players that are not ready yet.
    }
  }

  private scheduleApplySequence(): void {
    this.clearTimers();
    for (const delay of [0, 80, 250, 750, 1_500]) {
      const timer = window.setTimeout(() => {
        this.#timers.delete(timer);
        this.applyDesiredRate();
      }, delay);
      this.#timers.add(timer);
    }
  }

  private clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  readonly onResetEvent = (): void => {
    this.#session.resetUntil = performance.now() + 1_500;
    this.scheduleApplySequence();
  };

  readonly onPlayableEvent = (): void => this.scheduleApplySequence();

  readonly onRateChange = (): void => {
    if (!this.#video) return;
    const now = performance.now();
    if (now <= this.#session.internalUntil) return;
    if (now <= this.#session.resetUntil) {
      this.scheduleApplySequence();
      return;
    }
    this.#session.manualRate = this.#video.playbackRate;
    this.clearTimers();
  };

  readonly onDocumentClick = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest<HTMLElement>(SPEED_ITEM_SELECTOR);
    if (!item) return;
    const rate = parseRate(item.dataset.value || item.textContent);
    if (rate && rate > 0) {
      this.#session.manualRate = rate;
      this.clearTimers();
    }
  };

  destroy(): void {
    this.clearTimers();
    this.detachVideo();
    this.#observer.disconnect();
    if (this.#scanFrame) cancelAnimationFrame(this.#scanFrame);
    document.removeEventListener("click", this.onDocumentClick, true);
  }
}
