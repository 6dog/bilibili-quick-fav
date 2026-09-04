import type { FavoriteSnapshot, RectLike } from "../shared/types";
import { FavoriteService } from "./favorites";
import { OverlayUi } from "./overlay";

const VIDEO_LINK_SELECTOR = 'a[href*="/video/BV"]';
const MEDIA_SELECTOR = "img,video,canvas";
const HEADER_SELECTOR = "#biliMainHeader,#bili-header-container,.bili-header,.international-header,.mini-header,header";

export interface CoverRecord {
  link: HTMLAnchorElement;
  surface: Element;
  bvid: string;
}

function rectArea(rect: DOMRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function extractBvid(link: HTMLAnchorElement): string | null {
  return link.href.match(/\/(BV[\w]+)/)?.[1] ?? null;
}

export function findVideoCoverSurface(link: HTMLAnchorElement): Element | null {
  if (link.closest(HEADER_SELECTOR)) return null;
  const media = [...link.querySelectorAll(MEDIA_SELECTOR)]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) => rectArea(b.rect) - rectArea(a.rect))[0];
  if (!media) return null;
  if (media.rect.width < 32 || media.rect.height < 18) return null;
  let surface: Element = media.element;
  const mediaArea = rectArea(media.rect);
  for (let candidate = media.element.parentElement; candidate && link.contains(candidate); candidate = candidate.parentElement) {
    const rect = candidate.getBoundingClientRect();
    const area = rectArea(rect);
    if (
      rect.width >= media.rect.width * 0.9 &&
      rect.height >= media.rect.height * 0.9 &&
      area <= mediaArea * 1.2
    ) {
      surface = candidate;
    }
    if (candidate === link) break;
  }
  return surface.closest(HEADER_SELECTOR) ? null : surface;
}

function usableRect(rect: DOMRect): rect is DOMRect & RectLike {
  return rect.width >= 64 && rect.height >= 36 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}

export class CoverController {
  readonly #records = new Map<Element, CoverRecord>();
  readonly #linkRecords = new Map<HTMLAnchorElement, CoverRecord>();
  readonly #observer: MutationObserver;
  readonly #intersection: IntersectionObserver;
  readonly #activeResize: ResizeObserver;
  #active: CoverRecord | null = null;
  #unsubscribe: (() => void) | null = null;
  #scanScheduled = false;

  constructor(
    readonly service: FavoriteService,
    readonly ui: OverlayUi,
  ) {
    this.#observer = new MutationObserver((records) => this.handleMutations(records));
    this.#intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const record = this.#records.get(entry.target);
        if (record) void this.service.load(record.bvid, "normal");
      }
    }, { rootMargin: "200px" });
    this.#activeResize = new ResizeObserver(() => this.positionActive());
  }

  start(): void {
    this.scan(document);
    this.#observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "src"],
    });
    document.addEventListener("pointermove", this.onPointerMove, { capture: true, passive: true });
    document.addEventListener("focusin", this.onFocusIn, true);
    document.addEventListener("load", this.onMediaLoad, true);
    window.addEventListener("scroll", this.clearActive, { capture: true, passive: true });
    window.addEventListener("blur", this.clearActive);
    document.documentElement.addEventListener("pointerleave", this.clearActive, { passive: true });
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private scan(root: ParentNode): void {
    const links: HTMLAnchorElement[] = [];
    if (root instanceof HTMLAnchorElement && root.matches(VIDEO_LINK_SELECTOR)) links.push(root);
    links.push(...root.querySelectorAll<HTMLAnchorElement>(VIDEO_LINK_SELECTOR));
    for (const link of links) this.register(link);
    this.purgeDisconnected();
  }

  private register(link: HTMLAnchorElement): void {
    const bvid = extractBvid(link);
    const surface = findVideoCoverSurface(link);
    const previous = this.#linkRecords.get(link);
    if (!bvid || !surface) {
      if (previous) this.remove(previous);
      return;
    }
    if (previous?.bvid === bvid && previous.surface === surface) return;
    let restoreActive = previous === this.#active;
    if (previous) this.remove(previous);
    const displaced = this.#records.get(surface);
    if (displaced) {
      restoreActive ||= displaced === this.#active;
      this.remove(displaced);
    }
    const record = { link, surface, bvid };
    this.#linkRecords.set(link, record);
    this.#records.set(surface, record);
    this.#intersection.observe(surface);
    if (restoreActive) {
      requestAnimationFrame(() => {
        if (this.#linkRecords.get(link) === record) this.activate(record);
      });
    }
  }

  private remove(record: CoverRecord): void {
    if (this.#active === record) this.clearActive();
    this.#intersection.unobserve(record.surface);
    this.#records.delete(record.surface);
    this.#linkRecords.delete(record.link);
  }

  private purgeDisconnected(): void {
    for (const record of this.#records.values()) {
      if (!record.link.isConnected || !record.surface.isConnected) this.remove(record);
    }
  }

  private handleMutations(records: MutationRecord[]): void {
    for (const mutation of records) {
      if (mutation.type === "attributes") {
        const target = mutation.target;
        const link = target instanceof HTMLAnchorElement
          ? target
          : target instanceof Element
            ? target.closest(VIDEO_LINK_SELECTOR)
            : null;
        if (link instanceof HTMLAnchorElement) this.register(link);
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          const owner = node.closest(VIDEO_LINK_SELECTOR);
          if (owner instanceof HTMLAnchorElement) this.register(owner);
          this.scan(node);
        }
      }
    }
    this.schedulePurge();
  }

  private schedulePurge(): void {
    if (this.#scanScheduled) return;
    this.#scanScheduled = true;
    requestAnimationFrame(() => {
      this.#scanScheduled = false;
      this.purgeDisconnected();
    });
  }

  private recordFromEvent(event: Event): CoverRecord | null {
    const pointer = event instanceof PointerEvent
      ? { x: event.clientX, y: event.clientY }
      : null;
    for (const node of event.composedPath()) {
      if (node instanceof Element) {
        const record = this.#records.get(node);
        if (record) return record;
        if (pointer && node instanceof HTMLAnchorElement) {
          const linked = this.#linkRecords.get(node);
          if (linked) {
            const rect = linked.surface.getBoundingClientRect();
            if (
              pointer.x >= rect.left && pointer.x <= rect.right &&
              pointer.y >= rect.top && pointer.y <= rect.bottom
            ) return linked;
          }
        }
      }
    }
    return null;
  }

  readonly onPointerMove = (event: PointerEvent): void => {
    this.activate(this.recordFromEvent(event));
  };

  readonly onFocusIn = (event: FocusEvent): void => {
    this.activate(this.recordFromEvent(event));
  };

  readonly onMediaLoad = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches(MEDIA_SELECTOR)) return;
    const link = target.closest(VIDEO_LINK_SELECTOR);
    if (link instanceof HTMLAnchorElement) this.register(link);
  };

  private activate(record: CoverRecord | null): void {
    if (!record || !record.surface.isConnected) {
      this.clearActive();
      return;
    }
    if (record === this.#active) {
      this.positionActive();
      return;
    }
    this.clearActive();
    this.#active = record;
    this.#activeResize.observe(record.surface);
    this.#unsubscribe = this.service.subscribe(record.bvid, (snapshot) => {
      if (this.#active === record) this.ui.updateCover(snapshot);
    });
    const rect = record.surface.getBoundingClientRect();
    if (!usableRect(rect)) {
      this.clearActive();
      return;
    }
    this.ui.showCover(rect, this.service.snapshot(record.bvid), () => void this.service.toggle(record.bvid));
    void this.service.load(record.bvid, "high");
  }

  private positionActive(): void {
    if (!this.#active) return;
    const rect = this.#active.surface.getBoundingClientRect();
    if (!usableRect(rect)) {
      this.clearActive();
      return;
    }
    this.ui.showCover(rect, this.service.snapshot(this.#active.bvid), () => void this.service.toggle(this.#active!.bvid));
  }

  readonly clearActive = (): void => {
    if (this.#active) this.#activeResize.unobserve(this.#active.surface);
    this.#active = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.ui.hideCover();
  };

  readonly onVisibilityChange = (): void => {
    if (document.hidden) this.clearActive();
  };

  resetRoute(): void {
    this.clearActive();
    for (const record of [...this.#records.values()]) this.remove(record);
    this.scan(document);
  }

  destroy(): void {
    this.clearActive();
    this.#observer.disconnect();
    this.#intersection.disconnect();
    this.#activeResize.disconnect();
    document.removeEventListener("pointermove", this.onPointerMove, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    document.removeEventListener("load", this.onMediaLoad, true);
    window.removeEventListener("scroll", this.clearActive, true);
    window.removeEventListener("blur", this.clearActive);
    document.documentElement.removeEventListener("pointerleave", this.clearActive);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }
}
