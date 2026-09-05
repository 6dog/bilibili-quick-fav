import type { FavoriteSnapshot, RectLike } from "../shared/types";
import { FavoriteService } from "./favorites";
import { OverlayUi } from "./overlay";
import { routeBvid } from "./route";

const BUTTON_SIZE = 40;
const BUTTON_GAP = 8;

export interface DetailPlacement {
  visible: boolean;
  x: number;
  y: number;
}

function overlaps(a: RectLike, b: RectLike): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function computeDetailPlacement(
  anchor: RectLike,
  player: RectLike,
  viewport: { width: number; height: number },
  fullscreen: boolean,
  stateReady: boolean,
): DetailPlacement {
  const x = Math.round(anchor.right + BUTTON_GAP);
  const y = Math.round(anchor.top + (anchor.height - BUTTON_SIZE) / 2);
  const button = { top: y, right: x + BUTTON_SIZE, bottom: y + BUTTON_SIZE, left: x, width: BUTTON_SIZE, height: BUTTON_SIZE };
  const visible =
    stateReady &&
    !fullscreen &&
    anchor.width > 0 &&
    anchor.height > 0 &&
    player.width > 0 &&
    player.height > 0 &&
    anchor.top >= player.bottom - 2 &&
    x >= 0 &&
    y >= 0 &&
    button.right <= viewport.width &&
    button.bottom <= viewport.height &&
    !overlaps(button, player);
  return { visible, x, y };
}

function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

export function isDarkSurface(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const color = parseRgb(getComputedStyle(current).backgroundColor);
    if (!color || color.a < 0.5) continue;
    return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255 < 0.5;
  }
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function findPlayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "#bilibili-player,.bpx-player-container,.bpx-player-primary-area,.bilibili-player-video",
  );
}

function findAnchor(): HTMLElement | null {
  const toolbar =
    document.querySelector<HTMLElement>(".video-toolbar-left") ??
    document.querySelector<HTMLElement>(".video-toolbar,#toolbar_module,.video-info-detail");
  if (!toolbar || toolbar.closest("header,#biliMainHeader,.bili-header")) return null;
  return toolbar.querySelector<HTMLElement>(".video-toolbar-left") ?? toolbar;
}

function playerFullscreen(player: HTMLElement | null): boolean {
  if (document.fullscreenElement) return true;
  if (document.body.classList.contains("webscreen-fix")) return true;
  if (!player) return false;
  const rect = player.getBoundingClientRect();
  return rect.width >= innerWidth * 0.92 && rect.height >= innerHeight * 0.82 && rect.top <= 8;
}

export class DetailController {
  #bvid: string | null = null;
  #anchor: HTMLElement | null = null;
  #player: HTMLElement | null = null;
  #snapshot: FavoriteSnapshot | null = null;
  #unsubscribe: (() => void) | null = null;
  #resize = new ResizeObserver(() => this.beginStabilization());
  #observer = new MutationObserver(() => this.scheduleRefresh());
  #frame = 0;
  #refreshFrame = 0;
  #settleUntil = 0;
  #stableFrames = 0;
  #lastSignature = "";

  constructor(
    readonly service: FavoriteService,
    readonly ui: OverlayUi,
  ) {}

  start(): void {
    this.#observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize, { passive: true });
    document.addEventListener("fullscreenchange", this.onResize);
    document.addEventListener("webkitfullscreenchange", this.onResize);
    this.refresh();
  }

  private refresh(): void {
    const bvid = routeBvid();
    const anchor = bvid ? findAnchor() : null;
    const player = bvid ? findPlayer() : null;
    if (!bvid || !anchor || !player) {
      this.clearRecord();
      return;
    }
    if (this.#bvid === bvid && this.#anchor === anchor && this.#player === player) {
      this.scheduleLayout();
      return;
    }
    this.clearRecord();
    this.#bvid = bvid;
    this.#anchor = anchor;
    this.#player = player;
    this.#resize.observe(anchor);
    this.#resize.observe(player);
    this.#unsubscribe = this.service.subscribe(bvid, (snapshot) => {
      this.#snapshot = snapshot;
      this.ui.setDetail(snapshot, () => void this.service.toggle(bvid));
      this.scheduleLayout();
    });
    void this.service.load(bvid, "high");
    this.beginStabilization();
  }

  private scheduleRefresh(): void {
    if (this.#refreshFrame) return;
    this.#refreshFrame = requestAnimationFrame(() => {
      this.#refreshFrame = 0;
      this.refresh();
    });
  }

  private signature(): string {
    const key = (rect: DOMRect | undefined) => rect ? [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)).join(":") : "none";
    return `${key(this.#anchor?.getBoundingClientRect())}|${key(this.#player?.getBoundingClientRect())}`;
  }

  private beginStabilization(): void {
    this.#settleUntil = performance.now() + 350;
    this.#stableFrames = 0;
    this.#lastSignature = "";
    this.ui.positionDetail(0, 0, false, false);
    this.scheduleLayout();
  }

  private scheduleLayout(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.layout();
    });
  }

  private layout(): void {
    if (!this.#anchor?.isConnected || !this.#player?.isConnected || !this.#snapshot) {
      this.ui.hideDetail();
      return;
    }
    const fullscreen = playerFullscreen(this.#player);
    this.ui.setFullscreenHidden(fullscreen);
    const signature = this.signature();
    this.#stableFrames = signature === this.#lastSignature ? this.#stableFrames + 1 : 0;
    this.#lastSignature = signature;
    const settling = performance.now() < this.#settleUntil || this.#stableFrames < 4;
    const stateReady = this.#snapshot.status === "active" || this.#snapshot.status === "inactive";
    const placement = computeDetailPlacement(
      this.#anchor.getBoundingClientRect(),
      this.#player.getBoundingClientRect(),
      { width: innerWidth, height: innerHeight },
      fullscreen,
      stateReady && !settling,
    );
    this.ui.positionDetail(placement.x, placement.y, isDarkSurface(this.#anchor), placement.visible);
    if (settling) this.scheduleLayout();
  }

  readonly onScroll = (): void => this.scheduleLayout();
  readonly onResize = (): void => this.beginStabilization();

  private clearRecord(): void {
    if (this.#anchor) this.#resize.unobserve(this.#anchor);
    if (this.#player) this.#resize.unobserve(this.#player);
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#bvid = null;
    this.#anchor = null;
    this.#player = null;
    this.#snapshot = null;
    this.ui.hideDetail();
  }

  resetRoute(): void {
    this.clearRecord();
    window.setTimeout(() => this.refresh(), 0);
  }

  destroy(): void {
    this.clearRecord();
    this.#observer.disconnect();
    this.#resize.disconnect();
    if (this.#frame) cancelAnimationFrame(this.#frame);
    if (this.#refreshFrame) cancelAnimationFrame(this.#refreshFrame);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("fullscreenchange", this.onResize);
    document.removeEventListener("webkitfullscreenchange", this.onResize);
  }
}
