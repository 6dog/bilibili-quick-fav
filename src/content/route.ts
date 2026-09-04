const PLAYBACK_PREFIXES = ["/video/", "/bangumi/play/", "/medialist/play/", "/list/"];

export function isSupportedPlaybackPage(url: URL = new URL(location.href)): boolean {
  return PLAYBACK_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

export function semanticRouteKey(url: URL = new URL(location.href)): string {
  const relevantParams = ["p", "fid", "ftype", "bvid", "oid", "ep_id"];
  const query = relevantParams
    .filter((key) => url.searchParams.has(key))
    .map((key) => `${key}=${url.searchParams.get(key)}`)
    .join("&");
  return `${url.hostname}${url.pathname}${query ? `?${query}` : ""}`;
}

export function routeBvid(url: URL = new URL(location.href)): string | null {
  return url.pathname.match(/\/video\/(BV[\w]+)/)?.[1] ?? null;
}

type RouteListener = (nextKey: string, previousKey: string) => void;

export class RouteCoordinator {
  #key = semanticRouteKey();
  #listeners = new Set<RouteListener>();
  #observer: MutationObserver | null = null;
  #scheduled = false;
  #navigation: EventTarget | null = null;
  readonly #check = () => this.check();

  get key(): string {
    return this.#key;
  }

  subscribe(listener: RouteListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    window.addEventListener("popstate", this.#check);
    window.addEventListener("hashchange", this.#check);
    window.addEventListener("pageshow", this.#check);
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    if (navigation) {
      this.#navigation = navigation;
      navigation.addEventListener("navigate", this.#check);
    }
    this.#observer = new MutationObserver(() => this.scheduleCheck());
    this.#observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    window.removeEventListener("popstate", this.#check);
    window.removeEventListener("hashchange", this.#check);
    window.removeEventListener("pageshow", this.#check);
    this.#navigation?.removeEventListener("navigate", this.#check);
    this.#navigation = null;
    this.#observer?.disconnect();
    this.#observer = null;
  }

  check(): void {
    const next = semanticRouteKey();
    if (next === this.#key) return;
    const previous = this.#key;
    this.#key = next;
    for (const listener of this.#listeners) listener(next, previous);
  }

  private scheduleCheck(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.check();
    });
  }
}
