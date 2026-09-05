import type { BiliFolder, FavoriteSnapshot, RectLike } from "../shared/types";

const HOST_ID = "qfav-extension-root";

function bookmarkSvg(active: boolean, size = 20): string {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${active ? "#00aeec" : "none"}" stroke="${active ? "#00aeec" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/></svg>`;
}

export class OverlayUi {
  readonly host: HTMLDivElement;
  readonly root: ShadowRoot;
  readonly layer: HTMLDivElement;
  readonly coverButton: HTMLButtonElement;
  readonly detailButton: HTMLButtonElement;
  #coverAction: (() => void) | null = null;
  #detailAction: (() => void) | null = null;
  #pickerPromise: Promise<BiliFolder | null> | null = null;

  constructor() {
    document.getElementById(HOST_ID)?.remove();
    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    Object.assign(this.host.style, {
      all: "initial",
      position: "fixed",
      inset: "0",
      width: "0",
      height: "0",
      zIndex: "2147483000",
      pointerEvents: "none",
    });
    document.body.appendChild(this.host);
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.appendChild(this.createStyle());
    this.layer = document.createElement("div");
    this.layer.className = "layer";
    this.coverButton = this.createButton("cover-button", 20);
    this.detailButton = this.createButton("detail-button", 28);
    this.coverButton.addEventListener("click", (event) => {
      this.stopEvent(event);
      this.#coverAction?.();
    });
    this.detailButton.addEventListener("click", (event) => {
      this.stopEvent(event);
      this.#detailAction?.();
    });
    for (const button of [this.coverButton, this.detailButton]) {
      for (const name of ["pointerdown", "mousedown", "mouseup", "pointerup"]) {
        button.addEventListener(name, (event) => this.stopEvent(event), true);
      }
    }
    this.layer.append(this.coverButton, this.detailButton);
    this.root.appendChild(this.layer);
  }

  private createStyle(): HTMLStyleElement {
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .layer { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; contain: layout style; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .layer.fullscreen-hidden .cover-button, .layer.fullscreen-hidden .detail-button { display: none !important; }
      button { font: inherit; }
      .cover-button, .detail-button { position: fixed; top: 0; left: 0; display: flex; align-items: center; justify-content: center; margin: 0; padding: 0; border: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      .cover-button { width: 32px; height: 32px; border-radius: 50%; color: rgba(255,255,255,.96); background: rgba(0,0,0,.58); box-shadow: 0 2px 8px rgba(0,0,0,.28); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .08s, transform .15s, background .15s; }
      .cover-button.visible { opacity: 1; visibility: visible; pointer-events: auto; }
      .cover-button:hover { transform: scale(1.12); background: rgba(0,0,0,.78); }
      .cover-button.active { color: #00aeec; background: rgba(0,174,236,.26); }
      .cover-button.loading svg, .detail-button.loading svg { animation: pulse .75s ease-in-out infinite alternate; }
      .cover-button:disabled, .detail-button:disabled { cursor: progress; opacity: .62; }
      .detail-button { width: 28px; height: 28px; min-width: 28px; min-height: 28px; color: rgba(24,25,28,.9); background: transparent; border-radius: 50%; visibility: hidden; pointer-events: none; transition: transform .15s, background .15s; }
      .detail-button.visible { visibility: visible; pointer-events: auto; }
      .detail-button:hover { transform: scale(1.1); background: rgba(24,25,28,.08); }
      .detail-button.dark { color: rgba(255,255,255,.96); filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      .detail-button.active { color: #00aeec; filter: none; }
      .notice { position: fixed; left: 50%; top: 72px; transform: translateX(-50%); max-width: min(430px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 9px; color: #fff; background: rgba(24,25,28,.94); box-shadow: 0 4px 16px rgba(0,0,0,.22); font-size: 14px; line-height: 20px; pointer-events: none; }
      .backdrop { position: fixed; inset: 0; display: grid; place-items: center; width: 100vw; height: 100vh; padding: 20px; background: rgba(0,0,0,.5); pointer-events: auto; }
      .dialog { width: min(420px, 100%); max-height: 72vh; overflow: auto; padding: 22px; border-radius: 14px; color: #18191c; background: #fff; box-shadow: 0 16px 50px rgba(0,0,0,.3); }
      .dialog h2 { margin: 0 0 7px; font-size: 19px; }
      .dialog p { margin: 0 0 16px; color: #70737a; font-size: 13px; }
      .folder { display: block; width: 100%; margin: 0 0 8px; padding: 12px 14px; border: 0; border-radius: 9px; color: #18191c; background: #f1f2f3; text-align: left; cursor: pointer; }
      .folder:hover, .folder:focus-visible { color: #fff; background: #00a1d6; outline: none; }
      @keyframes pulse { from { opacity: .35; } to { opacity: 1; } }
    `;
    return style;
  }

  private createButton(className: string, size: number): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.iconSize = String(size);
    button.innerHTML = bookmarkSvg(false, size);
    return button;
  }

  private stopEvent(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  private renderButton(button: HTMLButtonElement, snapshot: FavoriteSnapshot): void {
    const size = Number(button.dataset.iconSize) || 20;
    button.innerHTML = bookmarkSvg(snapshot.active, size);
    button.classList.toggle("active", snapshot.active);
    button.classList.toggle("loading", snapshot.status === "loading" || snapshot.status === "mutating");
    button.disabled = snapshot.status === "mutating";
    button.setAttribute("aria-busy", String(snapshot.status === "loading" || snapshot.status === "mutating"));
    const action = snapshot.active ? "从" : "收藏到";
    button.title = snapshot.configured
      ? `${action}「${snapshot.folderTitle || "快捷收藏夹"}」`
      : "选择快捷收藏夹";
    button.setAttribute("aria-label", button.title);
  }

  showCover(rect: RectLike, snapshot: FavoriteSnapshot, action: () => void): void {
    this.#coverAction = action;
    this.coverButton.style.left = `${Math.round(rect.left + 8)}px`;
    this.coverButton.style.top = `${Math.round(rect.top + 8)}px`;
    this.renderButton(this.coverButton, snapshot);
    this.coverButton.classList.add("visible");
  }

  updateCover(snapshot: FavoriteSnapshot): void {
    this.renderButton(this.coverButton, snapshot);
  }

  hideCover(): void {
    this.#coverAction = null;
    this.coverButton.classList.remove("visible");
  }

  setDetail(snapshot: FavoriteSnapshot, action: () => void): void {
    this.#detailAction = action;
    this.renderButton(this.detailButton, snapshot);
  }

  positionDetail(x: number, y: number, dark: boolean, visible: boolean): void {
    this.detailButton.style.left = `${Math.round(x)}px`;
    this.detailButton.style.top = `${Math.round(y)}px`;
    this.detailButton.classList.toggle("dark", dark);
    this.detailButton.classList.toggle("visible", visible);
  }

  hideDetail(): void {
    this.#detailAction = null;
    this.detailButton.classList.remove("visible");
  }

  setFullscreenHidden(hidden: boolean): void {
    this.layer.classList.toggle("fullscreen-hidden", hidden);
    if (hidden) this.hideCover();
  }

  showNotice(message: string): void {
    this.root.querySelector(".notice")?.remove();
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.setAttribute("role", "status");
    notice.textContent = message;
    this.layer.appendChild(notice);
    window.setTimeout(() => notice.remove(), 3200);
  }

  chooseFolder(folders: BiliFolder[]): Promise<BiliFolder | null> {
    if (this.#pickerPromise) return this.#pickerPromise;
    this.#pickerPromise = new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "backdrop";
      const dialog = document.createElement("section");
      dialog.className = "dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "选择快捷收藏夹");
      const title = document.createElement("h2");
      title.textContent = "选择快捷收藏夹";
      const hint = document.createElement("p");
      hint.textContent = "以后点击封面按钮只会加入或移出这个收藏夹。";
      dialog.append(title, hint);

      let settled = false;
      const close = (folder: BiliFolder | null) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown, true);
        backdrop.remove();
        this.#pickerPromise = null;
        resolve(folder);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") close(null);
      };
      document.addEventListener("keydown", onKeyDown, true);

      for (const [index, folder] of folders.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "folder";
        button.textContent = `${folder.title}（${folder.mediaCount} 个视频）`;
        button.addEventListener("click", () => close(folder));
        dialog.appendChild(button);
        if (index === 0) window.setTimeout(() => button.focus(), 0);
      }
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) close(null);
      });
      backdrop.appendChild(dialog);
      this.layer.appendChild(backdrop);
    });
    return this.#pickerPromise;
  }

  destroy(): void {
    this.host.remove();
  }
}
