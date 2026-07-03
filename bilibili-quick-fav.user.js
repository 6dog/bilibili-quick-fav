// ==UserScript==
// @name         B站一键收藏+默认1.5倍速
// @namespace    bilibili-quick-fav
// @version      1.55
// @description  鼠标悬停视频封面显示收藏按钮，一键收藏/取消收藏到指定收藏夹；默认播放速度 1.5 倍
// @author       jesseyun
// @match        *://*.bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ===== 常量 =====
  const PROCESSED_ATTR = "data-qfav-processed";
  const CARD_HOVER_ATTR = "data-qfav-card";
  const FAV_FOLDER_KEY = "qfav_folder_id";
  const FAV_FOLDER_NAME_KEY = "qfav_folder_name";
  const DEFAULT_PLAYBACK_RATE = 1.5;
  // 诊断中：顶部栏保活 + 播放器 chrome observer 先关掉，排查 header 空白 bug
  const KEEP_TOP_BAR_VISIBLE = false;
  // 诊断开关：true 启用默认倍速功能；false 则只保留一键收藏（v1.0.0 行为）
  const ENABLE_DEFAULT_RATE = true;
  // 诊断开关：延迟启动 DOM 扫描/注入，避开 B 站 SPA 挂载窗口
  const DOM_BOOTSTRAP_DELAY_MS = 1500;
  const FAVORITES_BOOTSTRAP_DELAY_MS = 3000;
  const DOM_SCAN_THROTTLE_MS = 200;
  const FAVORITES_SCAN_THROTTLE_MS = 500;
  const FAVORITES_EXTRA_SCAN_DELAYS = [2000, 5000, 8000];
  const FAVORITES_SIDEBAR_REPAIR_DELAYS = [3500, 7000, 11000];
  const HEADER_MOUNT_RETRY_MS = 250;

  // ===== 收藏状态缓存 =====
  const favCache = new Map();
  const favStateSeq = new Map();
  const pendingToggles = new Map();
  let uidPromise = null;
  let folderPickerPromise = null;

  // SPA 导航保护期截止时间戳（毫秒）；保护期内 MutationObserver 不执行扫描
  let navGuardUntil = 0;

  // ===== 工具函数 =====

  function getCsrf() {
    const match = document.cookie.match(/bili_jct=([^;]+)/);
    return match ? match[1] : "";
  }

  async function apiFetch(url, options = {}) {
    const resp = await fetch(url, {
      credentials: "include",
      ...options,
    });
    if (!resp.ok) return { code: -1, message: `HTTP ${resp.status}` };
    try {
      return await resp.json();
    } catch {
      return { code: -1, message: "invalid JSON response" };
    }
  }

  async function apiPost(url, body) {
    return apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  // ===== B 站 API 封装 =====

  async function getUid() {
    if (!uidPromise) {
      uidPromise = apiFetch("https://api.bilibili.com/x/web-interface/nav")
        .then((data) => {
          if (data.code !== 0) throw new Error("未登录");
          return data.data.mid;
        })
        .catch((error) => {
          uidPromise = null;
          throw error;
        });
    }
    return uidPromise;
  }

  async function getFavFolders(uid) {
    const data = await apiFetch(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${uid}`,
    );
    if (data.code !== 0) throw new Error("获取收藏夹失败");
    return data.data.list || [];
  }

  async function getCreatedFavFolders(upMid) {
    const data = await apiFetch(
      `https://api.bilibili.com/x/v3/fav/folder/created/list?up_mid=${upMid}&pn=1&ps=50`,
    );
    if (data.code !== 0) return [];
    return data.data?.list || [];
  }

  async function bv2aid(bvid) {
    const data = await apiFetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    );
    if (data.code !== 0) return null;
    return data.data.aid;
  }

  async function getFavFolderStates(aid) {
    const folderId = GM_getValue(FAV_FOLDER_KEY, null);
    const uid = await getUid();

    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await apiFetch(
        `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${uid}&type=2&rid=${aid}`,
      );
      if (data.code !== 0 || !data.data?.list) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        return null;
      }

      const folder = data.data.list.find(
        (item) => String(item.id) === String(folderId),
      );
      return {
        targetFaved: folder ? Number(folder.fav_state) === 1 : false,
        selectedFolderIds: data.data.list
          .filter((item) => Number(item.fav_state) === 1)
          .map((item) => item.id),
      };
    }
    return null;
  }

  async function checkAnyFavoured(aid) {
    const data = await apiFetch(
      `https://api.bilibili.com/x/v2/fav/video/favoured?aid=${aid}`,
    );
    if (data.code === 0 && data.data) {
      return !!data.data.favoured;
    }
    return null;
  }

  async function confirmFavState(aid, expectedFaved) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
      }

      const anyFaved = await checkAnyFavoured(aid);
      if (anyFaved !== null) {
        if (anyFaved === expectedFaved || attempt === 3) return anyFaved;
      }
    }
    return null;
  }

  function getFavStateSeq(aid) {
    return favStateSeq.get(aid) || 0;
  }

  function bumpFavStateSeq(aid) {
    const next = getFavStateSeq(aid) + 1;
    favStateSeq.set(aid, next);
    return next;
  }

  function getNativeFavoriteState(root = document) {
    const favButton =
      root.querySelector(".video-toolbar-left .video-fav") ||
      root.querySelector(".video-toolbar .video-fav") ||
      root.querySelector("#toolbar_module .video-fav") ||
      root.querySelector(".video-fav") ||
      root.querySelector('[class*="video-fav"]');
    if (!favButton) return null;

    const pressed = favButton.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;

    if (
      favButton.classList.contains("on") ||
      favButton.classList.contains("active") ||
      favButton.classList.contains("selected") ||
      favButton.classList.contains("checked")
    ) {
      return true;
    }

    const color = getComputedStyle(favButton).color;
    if (
      color === "rgb(0, 174, 236)" ||
      color === "rgb(0, 161, 214)" ||
      color === "rgb(251, 114, 153)"
    ) {
      return true;
    }

    const activeIcon = favButton.querySelector(".on, .active, .selected, .checked");
    if (activeIcon) return true;

    const filledIcon = favButton.querySelector(
      'svg[fill]:not([fill="none"]), path[fill]:not([fill="none"])',
    );
    if (filledIcon) {
      const fill = filledIcon.getAttribute("fill") || "";
      const iconColor =
        fill === "currentColor" ? getComputedStyle(filledIcon).color : fill;
      if (
        iconColor === "rgb(0, 174, 236)" ||
        iconColor === "rgb(0, 161, 214)" ||
        iconColor === "rgb(251, 114, 153)" ||
        /^#?(00aeec|00a1d6|fb7299)$/i.test(iconColor)
      ) {
        return true;
      }
    }

    return false;
  }

  async function addFav(aid, folderId) {
    const csrf = getCsrf();
    return apiPost(
      "https://api.bilibili.com/x/v3/fav/resource/deal",
      `rid=${aid}&type=2&add_media_ids=${folderId}&csrf=${encodeURIComponent(csrf)}`,
    );
  }

  async function delFav(aid, folderId) {
    const csrf = getCsrf();
    return apiPost(
      "https://api.bilibili.com/x/v3/fav/resource/deal",
      `rid=${aid}&type=2&del_media_ids=${folderId}&csrf=${encodeURIComponent(csrf)}`,
    );
  }

  async function delFavFolders(aid, folderIds) {
    const uniqueIds = [...new Set(folderIds.map((id) => String(id)).filter(Boolean))];
    if (uniqueIds.length === 0) return { code: -1, message: "no favorite folders" };
    return delFav(aid, uniqueIds.join(","));
  }

  // ===== 收藏夹选择弹窗 =====

  function showFolderPicker(folders) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100vw",
        height: "100vh",
        background: "rgba(0,0,0,0.5)",
        zIndex: "999999",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      });

      const modal = document.createElement("div");
      Object.assign(modal.style, {
        background: "#fff",
        borderRadius: "12px",
        padding: "24px",
        minWidth: "320px",
        maxWidth: "420px",
        maxHeight: "70vh",
        overflowY: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      });

      const title = document.createElement("h3");
      title.textContent = "选择收藏夹";
      Object.assign(title.style, {
        margin: "0 0 16px 0",
        fontSize: "18px",
        color: "#333",
      });
      modal.appendChild(title);

      const hint = document.createElement("p");
      hint.textContent = "选择一个收藏夹作为快捷收藏目标（可随时更改）";
      Object.assign(hint.style, {
        margin: "0 0 16px 0",
        fontSize: "13px",
        color: "#999",
      });
      modal.appendChild(hint);

      folders.forEach((folder) => {
        const btn = document.createElement("div");
        btn.textContent = `${folder.title}（${folder.media_count} 个视频）`;
        Object.assign(btn.style, {
          padding: "12px 16px",
          margin: "0 0 8px 0",
          borderRadius: "8px",
          cursor: "pointer",
          background: "#f5f5f5",
          fontSize: "14px",
          color: "#333",
          transition: "background 0.2s",
        });
        btn.addEventListener(
          "mouseenter",
          () => (btn.style.background = "#00a1d6"),
        );
        btn.addEventListener("mouseenter", () => (btn.style.color = "#fff"));
        btn.addEventListener(
          "mouseleave",
          () => (btn.style.background = "#f5f5f5"),
        );
        btn.addEventListener("mouseleave", () => (btn.style.color = "#333"));
        btn.addEventListener("click", () => {
          GM_setValue(FAV_FOLDER_KEY, folder.id);
          GM_setValue(FAV_FOLDER_NAME_KEY, folder.title);
          overlay.remove();
          resolve(folder.id);
        });
        modal.appendChild(btn);
      });

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(null);
        }
      });

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    });
  }

  async function ensureFolderId() {
    let folderId = GM_getValue(FAV_FOLDER_KEY, null);
    if (folderId) return folderId;

    // 并发调用时复用同一个 picker，避免打开多个弹窗
    if (folderPickerPromise) return folderPickerPromise;

    folderPickerPromise = (async () => {
      try {
        const uid = await getUid();
        const folders = await getFavFolders(uid);
        if (folders.length === 0) {
          alert("你还没有收藏夹，请先在 B 站创建一个收藏夹。");
          return null;
        }
        return showFolderPicker(folders);
      } finally {
        folderPickerPromise = null;
      }
    })();

    return folderPickerPromise;
  }

  // ===== 按钮 SVG 图标 =====
  // 书签样式，配色靠拢 B 站蓝 (#00aeec)
  // starSvg 这个名字保留不改，避免牵动所有调用点
  function starSvg(filled, dark = false, size = 20) {
    const activeColor = "#00aeec"; // B 站主题蓝
    const idleStroke = dark ? "rgba(24,25,28,0.55)" : "rgba(255,255,255,0.9)";
    const stroke = filled ? activeColor : idleStroke;
    const fill = filled ? activeColor : "none";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/>
    </svg>`;
  }

  function setButtonVisualState(btn, filled, dark = false, size = 20) {
    if (!btn) return;
    btn.innerHTML = starSvg(filled, dark, size);
    btn.classList.toggle("qfav-active", filled);
    btn.classList.remove("qfav-state-pending");
  }

  function syncFavVisualState(aid, faved) {
    favCache.set(aid, faved);
    document
      .querySelectorAll(`.qfav-btn[data-qfav-aid="${aid}"]`)
      .forEach((button) => setButtonVisualState(button, faved));
    document
      .querySelectorAll(`.qfav-detail-btn[data-qfav-aid="${aid}"]`)
      .forEach((button) => setButtonVisualState(button, faved, true, 28));
  }

  function clearFavState(aid) {
    favCache.delete(aid);
  }

  function isFavoritesCollectionPage() {
    return (
      location.pathname.includes("/favlist") ||
      /\/medialist\/play\/ml/.test(location.pathname)
    );
  }

  // ===== 注入 CSS =====
  const COVER_CARD_SELECTORS = [
    ".bili-video-card",
    ".video-card",
    ".small-item",
    ".video-list-item",
    ".fav-video-list .items .item",
    ".feed-card",
    ".bili-feed-card",
    ".bili-dyn-card-video",
  ];
  const LINK_CARD_FALLBACK_SELECTOR = [
    ".bili-dyn-card-video",
    ".bili-feed-card",
    ".feed-card",
    ".bili-video-card",
    ".video-card",
    ".small-item",
    ".video-list-item",
    ".fav-video-list .items .item",
    "article",
    'a[href*="/video/BV"]',
  ].join(",");
  const MEDIA_HINT_SELECTOR = "img, picture, video, canvas";
  const COVER_CARD_SELECTOR = COVER_CARD_SELECTORS.join(",");

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .qfav-btn {
        position: absolute;
        top: 8px;
        left: 8px;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s, transform 0.15s;
        z-index: 10000;
        border: none;
        outline: none;
        padding: 0;
        pointer-events: none;
        -webkit-tap-highlight-color: transparent;
      }
      .qfav-btn:focus,
      .qfav-btn:focus-visible {
        outline: none;
      }
      .qfav-btn:hover {
        transform: scale(1.15);
        background: rgba(0, 0, 0, 0.75);
      }
      .qfav-btn.qfav-active {
        background: rgba(0, 174, 236, 0.22);
      }
      .qfav-btn.qfav-active:hover {
        background: rgba(0, 174, 236, 0.32);
      }
      .qfav-btn.qfav-loading {
        pointer-events: none;
        opacity: 0.5 !important;
      }
      .qfav-btn.qfav-state-pending {
        opacity: 0 !important;
        pointer-events: none;
      }
      /* 卡片 hover 时显示按钮 */
      [data-qfav-card="1"]:hover > .qfav-btn:not(.qfav-state-pending) {
        opacity: 1;
        pointer-events: auto;
      }

      /* 详情页按钮 —— 视频下方工具栏 */
      .qfav-detail-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 46px;
        height: 46px;
        background: transparent;
        cursor: pointer;
        border: none;
        outline: none;
        padding: 0;
        transition: transform 0.15s;
        margin-left: 4px;
        vertical-align: middle;
        -webkit-tap-highlight-color: transparent;
      }
      .qfav-detail-btn:focus,
      .qfav-detail-btn:focus-visible {
        outline: none;
      }
      .qfav-detail-btn:hover {
        transform: scale(1.1);
      }
      .qfav-detail-btn.qfav-active {
        color: #00aeec;
      }
      .qfav-detail-btn.qfav-loading {
        pointer-events: none;
        opacity: 0.5;
      }
      .qfav-detail-btn.qfav-state-pending {
        visibility: hidden;
        pointer-events: none;
      }
      html.qfav-keep-top-bar .bpx-player-control-top,
      html.qfav-keep-top-bar .bpx-player-top-wrap,
      html.qfav-keep-top-bar .bilibili-player-video-top,
      html.qfav-keep-top-bar .squirtle-video-top {
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      html.qfav-keep-top-bar #bili-header-container,
      html.qfav-keep-top-bar #biliMainHeader,
      html.qfav-keep-top-bar .bili-header,
      html.qfav-keep-top-bar .bili-header__bar,
      html.qfav-keep-top-bar .international-header,
      html.qfav-keep-top-bar .z_top_nav,
      html.qfav-keep-top-bar .z_top_nav_wrap,
      html.qfav-keep-top-bar .mini-header,
      html.qfav-keep-top-bar .fixed-header {
        visibility: visible !important;
        opacity: 1 !important;
        transform: none !important;
        pointer-events: auto !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ===== 收藏切换逻辑 =====

  async function toggleFav(aid, btn, updateIcon) {
    // 同一个 aid 正在操作时复用已有 promise，避免竞态
    if (pendingToggles.has(aid)) {
      return pendingToggles.get(aid);
    }

    btn.classList.add("qfav-loading");

    const promise = (async () => {
      const previousVisualFaved =
        btn.classList.contains("qfav-active") ||
        favCache.get(aid) === true ||
        false;
      const nextVisualFaved = !previousVisualFaved;

      try {
        syncFavVisualState(aid, nextVisualFaved);
        updateIcon(nextVisualFaved);

        const folderId = await ensureFolderId();
        if (!folderId) {
          syncFavVisualState(aid, previousVisualFaved);
          updateIcon(previousVisualFaved);
          return previousVisualFaved;
        }

        let result;
        if (nextVisualFaved) {
          result = await addFav(aid, folderId);
        } else {
          const folderStates = await getFavFolderStates(aid);
          const delFolderIds =
            folderStates?.selectedFolderIds?.length > 0
              ? folderStates.selectedFolderIds
              : [folderId];
          result = await delFavFolders(aid, delFolderIds);
        }

        if (result.code === 0) {
          const confirmedVisualFaved =
            (await confirmFavState(aid, nextVisualFaved)) ?? nextVisualFaved;
          syncFavVisualState(aid, confirmedVisualFaved);
          return confirmedVisualFaved;
        } else {
          console.error("[B站一键收藏] 操作失败:", result.message);
          clearFavState(aid);
          syncFavVisualState(aid, previousVisualFaved);
          updateIcon(previousVisualFaved);
          return previousVisualFaved;
        }
      } catch (e) {
        console.error("[B站一键收藏] 错误:", e);
        clearFavState(aid);
        syncFavVisualState(aid, previousVisualFaved);
        updateIcon(previousVisualFaved);
        return previousVisualFaved;
      } finally {
        btn.classList.remove("qfav-loading");
        pendingToggles.delete(aid);
      }
    })();

    pendingToggles.set(aid, promise);
    return promise;
  }

  function stopButtonEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // ===== 提取 BVID =====

  function extractBvid(element) {
    const links = element.querySelectorAll('a[href*="/video/BV"]');
    for (const link of links) {
      const match = link.href.match(/(BV[\w]+)/);
      if (match) return match[1];
    }
    // 也尝试从 element 自身
    if (element.tagName === "A" && element.href) {
      const match = element.href.match(/(BV[\w]+)/);
      if (match) return match[1];
    }
    return null;
  }

  // ===== AID 缓存（BV → AID）=====
  const aidCache = new Map();

  async function getAid(bvid) {
    if (aidCache.has(bvid)) return aidCache.get(bvid);
    const aid = await bv2aid(bvid);
    if (aid) aidCache.set(bvid, aid);
    return aid;
  }

  // ===== 封面按钮注入 =====

  function injectCoverButton(cardEl, bvid) {
    if (cardEl.querySelector(".qfav-btn")) return;
    cardEl.setAttribute(CARD_HOVER_ATTR, "1");

    // 确保卡片有 position relative
    const pos = getComputedStyle(cardEl).position;
    if (pos === "static") cardEl.style.position = "relative";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qfav-btn";
    btn.title = "快捷收藏";
    if (isFavoritesCollectionPage()) {
      setButtonVisualState(btn, true);
    } else {
      setButtonVisualState(btn, false);
    }

    let initialStatePromise = null;
    const loadInitialCoverState = async () => {
      if (isFavoritesCollectionPage() || btn.dataset.qfavStateReady === "1") return;

      if (!initialStatePromise) {
        initialStatePromise = (async () => {
          try {
            const aid = await getAid(bvid);
            if (!aid || !btn.isConnected) return;
            btn.dataset.qfavAid = String(aid);

            if (!favCache.has(aid)) {
              const seq = getFavStateSeq(aid);
              const anyFaved = await checkAnyFavoured(aid);
              if (getFavStateSeq(aid) !== seq || !btn.isConnected) return;
              syncFavVisualState(aid, anyFaved === true);
              btn.dataset.qfavStateReady = "1";
              return;
            }

            setButtonVisualState(btn, favCache.get(aid) === true);
            btn.dataset.qfavStateReady = "1";
          } catch (_) {
            setButtonVisualState(btn, false);
            btn.dataset.qfavStateReady = "1";
          } finally {
            initialStatePromise = null;
          }
        })();
      }

      return initialStatePromise;
    };

    ["pointerdown", "mousedown", "mouseup", "pointerup"].forEach(
      (eventName) => {
        btn.addEventListener(eventName, stopButtonEvent, true);
      },
    );

    // 阻止点击事件冒泡（避免跳转到视频页）
    btn.addEventListener(
      "click",
      async (e) => {
        stopButtonEvent(e);

        try {
          await loadInitialCoverState();
          const aid = await getAid(bvid);
          if (!aid) return;
          btn.dataset.qfavAid = String(aid);

          bumpFavStateSeq(aid);

          await toggleFav(aid, btn, (faved) => {
            setButtonVisualState(btn, faved);
          });
        } catch (err) {
          console.error("[B站一键收藏] 收藏操作出错:", err);
        }
      },
      true,
    );

    cardEl.appendChild(btn);

    if (isFavoritesCollectionPage()) {
      return;
    }

    cardEl.addEventListener("pointerenter", loadInitialCoverState, {
      passive: true,
    });
    cardEl.addEventListener("focusin", loadInitialCoverState);
  }

  // ===== 扫描并注入封面按钮 =====

  // 禁区：以下容器内部的元素一律不动，避免污染 B 站 header 的 SPA 挂载
  const HEADER_GUARD_SELECTOR = [
    "#biliMainHeader",
    "#bili-header-container",
    ".bili-header",
    ".bili-header__bar",
    ".international-header",
    ".z_top_nav",
    ".z_top_nav_wrap",
    ".mini-header",
    ".fixed-header",
    "header",
  ].join(",");

  function isInsideHeader(el) {
    return !!(el && el.closest && el.closest(HEADER_GUARD_SELECTOR));
  }

  function isBiliHeaderMountPending() {
    if (
      location.hostname !== "www.bilibili.com" ||
      !isSupportedPlaybackPage()
    ) {
      return false;
    }

    const header = document.querySelector("#biliMainHeader");
    if (!header) return true;
    return !(header.innerText || "").trim();
  }

  function runWhenBiliHeaderReady(callback) {
    if (isBiliHeaderMountPending()) {
      setTimeout(
        () => runWhenBiliHeaderReady(callback),
        HEADER_MOUNT_RETRY_MS,
      );
      return;
    }

    callback();
  }

  function normalizeVideoCardTarget(target) {
    if (!target || isInsideHeader(target)) return null;

    const nestedCover = target.matches?.(COVER_CARD_SELECTOR)
      ? target
      : target.querySelector?.(COVER_CARD_SELECTOR);
    if (nestedCover && !isInsideHeader(nestedCover)) {
      return nestedCover;
    }

    if (
      target.matches?.(MEDIA_HINT_SELECTOR) ||
      target.querySelector?.(MEDIA_HINT_SELECTOR)
    ) {
      return target;
    }

    return null;
  }

  function collectVideoCardTargets() {
    const targets = new Set();

    document.querySelectorAll(COVER_CARD_SELECTOR).forEach((card) => {
      const target = normalizeVideoCardTarget(card);
      if (target) {
        targets.add(target);
      }
    });

    document.querySelectorAll('a[href*="/video/BV"]').forEach((link) => {
      const card = normalizeVideoCardTarget(
        link.closest(LINK_CARD_FALLBACK_SELECTOR) || link.parentElement || link,
      );
      if (card) {
        targets.add(card);
      }
    });

    const items = Array.from(targets).map((target) => ({
      target,
      bvid: extractBvid(target),
    }));

    return items
      .filter(({ target, bvid }) => {
        if (!bvid) return false;
        return !items.some(
          (other) =>
            other.target !== target &&
            other.bvid === bvid &&
            target.contains(other.target),
        );
      })
      .map(({ target }) => target);
  }

  function scanVideoCards() {
    collectVideoCardTargets().forEach((card) => {
      if (isInsideHeader(card)) return;

      const bvid = extractBvid(card);
      if (!bvid) return; // 骨架屏阶段无 BV ID，不打标记，等内容填入后再处理

      if (card.hasAttribute(PROCESSED_ATTR)) {
        if (card.dataset.qfavBvid === bvid) return;
        card.querySelectorAll(":scope > .qfav-btn").forEach((btn) => btn.remove());
        card.removeAttribute(PROCESSED_ATTR);
        card.removeAttribute(CARD_HOVER_ATTR);
      }

      card.dataset.qfavBvid = bvid;
      card.setAttribute(PROCESSED_ATTR, "1");
      injectCoverButton(card, bvid);
    });
  }

  // ===== 详情页按钮 =====

  let detailBtnInjected = false;

  function findDetailToolbar() {
    return (
      document.querySelector(".video-toolbar-left") ||
      document.querySelector(".video-toolbar") ||
      document.querySelector("#toolbar_module") ||
      document.querySelector(".video-info-detail")
    );
  }

  function injectDetailButton() {
    const match = location.pathname.match(/\/video\/(BV[\w]+)/);
    if (!match) {
      detailBtnInjected = false;
      document.querySelectorAll(".qfav-detail-btn").forEach((btn) => btn.remove());
      return;
    }

    const bvid = match[1];
    const toolbar = findDetailToolbar();
    if (!toolbar) return;
    if (isInsideHeader(toolbar)) return;

    const existingBtn = document.querySelector(".qfav-detail-btn");
    if (existingBtn && existingBtn.isConnected) {
      if (existingBtn.dataset.qfavBvid === bvid && toolbar.contains(existingBtn)) {
        return;
      }
      existingBtn.remove();
    }

    const ICON_SIZE = 28;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qfav-detail-btn";
    btn.title = "快捷收藏";
    btn.dataset.qfavBvid = bvid;
    const nativeFavState = getNativeFavoriteState();
    if (nativeFavState !== null) {
      setButtonVisualState(btn, nativeFavState, true, ICON_SIZE);
      btn.dataset.qfavStateReady = "1";
    } else {
      setButtonVisualState(btn, false, true, ICON_SIZE);
    }

    let initialStatePromise = null;
    const loadInitialDetailState = async () => {
      if (btn.dataset.qfavStateReady === "1") return;

      if (!initialStatePromise) {
        initialStatePromise = (async () => {
          try {
            const aid = await getAid(bvid);
            if (!aid || !btn.isConnected) return;
            btn.dataset.qfavAid = String(aid);

            const seq = getFavStateSeq(aid);
            const anyFaved = await checkAnyFavoured(aid);
            if (getFavStateSeq(aid) !== seq || !btn.isConnected) return;
            const finalState =
              anyFaved !== null
                ? anyFaved
                : getNativeFavoriteState() === true;
            syncFavVisualState(aid, finalState);
            setButtonVisualState(btn, finalState, true, ICON_SIZE);
            btn.dataset.qfavStateReady = "1";
          } catch (_) {
            const fallbackState = getNativeFavoriteState() === true;
            setButtonVisualState(btn, fallbackState, true, ICON_SIZE);
            btn.dataset.qfavStateReady = "1";
          } finally {
            initialStatePromise = null;
          }
        })();
      }

      return initialStatePromise;
    };

    ["pointerdown", "mousedown", "mouseup", "pointerup"].forEach(
      (eventName) => {
        btn.addEventListener(eventName, stopButtonEvent, true);
      },
    );

    btn.addEventListener(
      "click",
      async (e) => {
        stopButtonEvent(e);

        try {
          await loadInitialDetailState();
          const aid = await getAid(bvid);
          if (!aid) return;
          btn.dataset.qfavAid = String(aid);

          bumpFavStateSeq(aid);

          await toggleFav(aid, btn, (faved) => {
            setButtonVisualState(btn, faved, true, ICON_SIZE);
          });
        } catch (err) {
          console.error("[B站一键收藏] 收藏操作出错:", err);
        }
      },
      true,
    );

    toolbar.appendChild(btn);
    detailBtnInjected = true;
    btn.addEventListener("pointerenter", loadInitialDetailState, {
      passive: true,
    });
    btn.addEventListener("focusin", loadInitialDetailState);
  }

  // ===== 默认播放倍速 =====
  // 策略：
  //  - 只接管真正的视频播放页主播放器，避免首页/卡片预览视频被误伤
  //  - 通过点击 B 站官方倍速菜单项切到 1.5x，避免直接改 playbackRate
  //    导致播放器闪一下，或把顶部状态栏/控件状态弄丢
  //  - 若用户手动从速度菜单改了倍速，本页立即放弃接管；下一个视频页再恢复默认
  const USER_CLICK_WINDOW_MS = 1500;
  const FAST_APPLY_WINDOW_MS = 4000;
  const PLAYBACK_PAGE_PREFIXES = [
    "/video/",
    "/bangumi/play/",
    "/medialist/play/",
    "/list/",
  ];
  const MAIN_VIDEO_SELECTOR = [
    ".bpx-player-video-wrap video",
    ".bpx-player-primary-area video",
    "#bilibili-player video",
    ".bilibili-player-video video",
    ".squirtle-video-wrap video",
    "video",
  ].join(",");
  const SPEED_MENU_ITEM_SELECTOR = [
    ".bpx-player-ctrl-playbackrate-menu-item",
    ".bilibili-player-video-btn-speed-menu-list-item",
    "li.squirtle-select-item",
  ].join(",");
  const ACTIVE_SPEED_ITEM_SELECTOR = [
    ".bpx-player-ctrl-playbackrate-menu-item.bpx-state-active",
    ".bilibili-player-video-btn-speed-menu-list-item.bilibili-player-active",
    "li.squirtle-select-item.active",
    "li.squirtle-select-item.squirtle-select-item-active",
  ].join(",");
  const SPEED_RESULT_SELECTOR = [
    ".bpx-player-ctrl-playbackrate-result",
    ".bilibili-player-video-btn-speed-name",
    ".squirtle-speed-select-current",
  ].join(",");
  const videoRateStates = new WeakMap();
  let fastApplyFrame = 0;
  let fastApplyDeadline = 0;
  let chromeVisibilityObserver = null;
  let navigationWatchStarted = false;

  let lastSpeedClickAt = 0;

  function isSupportedPlaybackPage() {
    return PLAYBACK_PAGE_PREFIXES.some((prefix) =>
      location.pathname.startsWith(prefix),
    );
  }

  function syncTopBarVisibilityClass() {
    if (!KEEP_TOP_BAR_VISIBLE) return;
    document.documentElement.classList.toggle(
      "qfav-keep-top-bar",
      isSupportedPlaybackPage(),
    );
  }

  function forceVisibleStyle(el) {
    if (!el || !el.style) return;
    el.style.setProperty("visibility", "visible", "important");
    el.style.setProperty("opacity", "1", "important");
    el.style.setProperty("pointer-events", "auto", "important");
    if (getComputedStyle(el).display === "none") {
      el.style.setProperty("display", "flex", "important");
    }
  }

  function enforcePlayerChromeVisibility() {
    if (!KEEP_TOP_BAR_VISIBLE || !isSupportedPlaybackPage()) return;

    const selectors = [
      ".bpx-player-control-top",
      ".bpx-player-top-wrap",
      ".bilibili-player-video-top",
      ".squirtle-video-top",
      ".bpx-player-control-wrap",
      ".bilibili-player-video-control-wrap",
      ".squirtle-controller-wrap",
    ];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach(forceVisibleStyle);
    });
  }

  function ensureChromeVisibilityObserver() {
    if (!KEEP_TOP_BAR_VISIBLE) return;

    const root = document.documentElement;
    if (!root) return;

    if (!isSupportedPlaybackPage()) {
      if (chromeVisibilityObserver) {
        chromeVisibilityObserver.disconnect();
        chromeVisibilityObserver = null;
      }
      return;
    }

    if (chromeVisibilityObserver) return;

    chromeVisibilityObserver = new MutationObserver(() => {
      enforcePlayerChromeVisibility();
    });

    chromeVisibilityObserver.observe(root, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "hidden"],
    });
  }

  function getPlaybackPageKey() {
    return `${location.pathname}${location.search}`;
  }

  function nearlyEqualRate(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
  }

  function parseRateValue(value) {
    const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  }

  function userJustClickedSpeed() {
    return Date.now() - lastSpeedClickAt < USER_CLICK_WINDOW_MS;
  }

  function isConnectedAndVisible(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0;
  }

  function findMainVideo() {
    const videos = Array.from(document.querySelectorAll(MAIN_VIDEO_SELECTOR));
    return (
      videos.find((video) => {
        const playerRoot = video.closest(
          "#bilibili-player, .bpx-player-container, .bpx-player-video-area, .bilibili-player-video, .squirtle-video-wrap",
        );
        return playerRoot && isConnectedAndVisible(video);
      }) || null
    );
  }

  function getPlayerApi() {
    const player = window.player;
    if (
      player &&
      typeof player.setPlaybackRate === "function" &&
      typeof player.getPlaybackRate === "function"
    ) {
      return player;
    }
    return null;
  }

  function setVideoElementRate(video) {
    if (!video) return false;
    try {
      video.defaultPlaybackRate = DEFAULT_PLAYBACK_RATE;
    } catch (_) {}
    try {
      video.playbackRate = DEFAULT_PLAYBACK_RATE;
      return nearlyEqualRate(video.playbackRate, DEFAULT_PLAYBACK_RATE);
    } catch (_) {
      return false;
    }
  }

  function getCurrentPlayerRate(video) {
    const player = getPlayerApi();
    if (player) {
      try {
        const playerRate = Number(player.getPlaybackRate());
        if (Number.isFinite(playerRate) && playerRate > 0) {
          return playerRate;
        }
      } catch (_) {}
    }

    const activeItem = document.querySelector(ACTIVE_SPEED_ITEM_SELECTOR);
    const activeRate = parseRateValue(
      activeItem?.dataset?.value || activeItem?.textContent,
    );
    if (activeRate !== null) return activeRate;

    const speedResult = document.querySelector(SPEED_RESULT_SELECTOR);
    const resultRate = parseRateValue(speedResult?.textContent);
    if (resultRate !== null) return resultRate;

    return video?.playbackRate || 1;
  }

  function applyRateImmediately(video, state) {
    if (!video || !state?.lockToDefault || userJustClickedSpeed()) return false;

    const currentRate = getCurrentPlayerRate(video);
    if (nearlyEqualRate(currentRate, DEFAULT_PLAYBACK_RATE)) {
      state.initialApplied = true;
      return true;
    }

    const player = getPlayerApi();
    if (player) {
      try {
        player.setPlaybackRate(DEFAULT_PLAYBACK_RATE);
      } catch (_) {}
    }

    const applied = setVideoElementRate(video);
    const nextRate = getCurrentPlayerRate(video);
    if (applied || nearlyEqualRate(nextRate, DEFAULT_PLAYBACK_RATE)) {
      state.initialApplied = true;
      return true;
    }

    return false;
  }

  function bindVideoRateListeners(video, state) {
    const requestApply = (delay = 0) => {
      queueApplyDefaultRate(video, delay);
    };

    video.addEventListener("loadstart", () => requestApply(0));
    video.addEventListener("loadedmetadata", () => requestApply(0));
    video.addEventListener("canplay", () => requestApply(0));
    video.addEventListener("play", () => requestApply(0));
    video.addEventListener("playing", () => requestApply(0));
    video.addEventListener("ratechange", () => {
      const currentRate = getCurrentPlayerRate(video);
      if (nearlyEqualRate(currentRate, DEFAULT_PLAYBACK_RATE)) {
        state.initialApplied = true;
        return;
      }

      if (!state.lockToDefault) return;

      if (userJustClickedSpeed()) {
        state.lockToDefault = false;
        return;
      }

      requestApply(80);
    });
  }

  function getVideoRateState(video) {
    const pageKey = getPlaybackPageKey();
    let state = videoRateStates.get(video);

    if (!state || state.pageKey !== pageKey) {
      if (state?.applyTimer) clearTimeout(state.applyTimer);
      state = {
        pageKey,
        lockToDefault: true,
        initialApplied: false,
        listenersBound: false,
        applyTimer: 0,
      };
      videoRateStates.set(video, state);
    }

    if (!state.listenersBound) {
      state.listenersBound = true;
      bindVideoRateListeners(video, state);
    }

    return state;
  }

  function queueApplyDefaultRate(video, delay = 0) {
    if (!ENABLE_DEFAULT_RATE || !isSupportedPlaybackPage()) return;

    const state = getVideoRateState(video);
    if (!state.lockToDefault) return;

    if (state.applyTimer) clearTimeout(state.applyTimer);
    state.applyTimer = window.setTimeout(() => {
      state.applyTimer = 0;

      if (
        !video.isConnected ||
        !isSupportedPlaybackPage() ||
        getPlaybackPageKey() !== state.pageKey
      ) {
        return;
      }

      if (userJustClickedSpeed()) return;

      applyRateImmediately(video, state);
    }, delay);
  }

  function stopFastRateBootstrap() {
    if (!fastApplyFrame) return;
    cancelAnimationFrame(fastApplyFrame);
    fastApplyFrame = 0;
    fastApplyDeadline = 0;
  }

  function startFastRateBootstrap() {
    if (!ENABLE_DEFAULT_RATE || !isSupportedPlaybackPage()) return;

    fastApplyDeadline = performance.now() + FAST_APPLY_WINDOW_MS;
    if (fastApplyFrame) return;

    const tick = () => {
      fastApplyFrame = 0;

      if (!ENABLE_DEFAULT_RATE || !isSupportedPlaybackPage()) {
        stopFastRateBootstrap();
        return;
      }

      const video = findMainVideo();
      if (video) {
        const state = getVideoRateState(video);
        applyRateImmediately(video, state);

        const rate = getCurrentPlayerRate(video);
        if (
          state.initialApplied &&
          nearlyEqualRate(rate, DEFAULT_PLAYBACK_RATE) &&
          performance.now() >= fastApplyDeadline
        ) {
          stopFastRateBootstrap();
          return;
        }
      }

      if (performance.now() >= fastApplyDeadline) {
        stopFastRateBootstrap();
        return;
      }

      fastApplyFrame = requestAnimationFrame(tick);
    };

    fastApplyFrame = requestAnimationFrame(tick);
  }

  if (ENABLE_DEFAULT_RATE) {
    document.addEventListener(
      "click",
      (e) => {
        if (!e.isTrusted) return;
        const t = e.target;
        if (!t || !t.closest) return;

        const speedItem = t.closest(SPEED_MENU_ITEM_SELECTOR);
        if (!speedItem) return;

        lastSpeedClickAt = Date.now();

        const video = findMainVideo();
        if (!video) return;

        const state = getVideoRateState(video);
        const pickedRate = parseRateValue(
          speedItem.dataset?.value || speedItem.textContent,
        );

        state.lockToDefault = nearlyEqualRate(
          pickedRate,
          DEFAULT_PLAYBACK_RATE,
        );
        state.initialApplied = state.lockToDefault;

        if (!state.lockToDefault && state.applyTimer) {
          clearTimeout(state.applyTimer);
          state.applyTimer = 0;
        }
      },
      true,
    );
  }

  function scanVideos() {
    if (!ENABLE_DEFAULT_RATE || !isSupportedPlaybackPage()) return;
    const video = findMainVideo();
    if (video) {
      queueApplyDefaultRate(video, 0);
    }
    startFastRateBootstrap();
  }

  // ===== MutationObserver 监听 DOM 变化 =====

  function isFavoritesPage() {
    return /space\.bilibili\.com\/\d+\/favlist/.test(location.href);
  }

  function getFavoritesSpaceMid() {
    const match = location.pathname.match(/\/(\d+)\/favlist/);
    return match ? match[1] : null;
  }

  function getCurrentFavoriteFolderId() {
    return new URLSearchParams(location.search).get("fid");
  }

  function makeFavoriteFolderUrl(upMid, folderId) {
    return `https://space.bilibili.com/${upMid}/favlist?fid=${folderId}&ftype=create`;
  }

  function findCreatedFavoritesCollapse() {
    return Array.from(
      document.querySelectorAll(".fav-collapse, .vui_collapse_item"),
    ).find((item) => {
      const header =
        item.querySelector(".vui_collapse_item_header") ||
        item.firstElementChild ||
        item;
      return (header.textContent || "").includes("我创建的收藏夹");
    });
  }

  function getCreatedFavoritesContainer(collapse) {
    return (
      collapse?.querySelector(".fav-collapse-wrap") ||
      collapse?.querySelector(".vui_collapse_item_content") ||
      null
    );
  }

  function hasRenderedFavoriteFolder(folder) {
    const folderTitle = String(folder.title || "").trim();
    return Array.from(
      document.querySelectorAll(".fav-sidebar-item, .vui_sidebar-item, a"),
    ).some((item) => {
      const titleText = (
        item.querySelector(".vui_sidebar-item-title")?.textContent ||
        item.textContent ||
        ""
      ).trim();
      const href = item.href || "";
      return (
        href.includes(`fid=${folder.id}`) ||
        titleText === folderTitle
      );
    });
  }

  function createFavoriteFolderSidebarItem(folder, upMid) {
    const link = document.createElement("a");
    link.className = "fav-sidebar-item qfav-repaired-folder";
    link.href = makeFavoriteFolderUrl(upMid, folder.id);
    link.title = folder.title || "收藏夹";
    link.style.display = "block";
    link.style.textDecoration = "none";

    const row = document.createElement("div");
    row.className = "vui_sidebar-item";
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: "36px",
      padding: "0 12px",
      borderRadius: "6px",
      color: "#18191c",
      boxSizing: "border-box",
    });

    const title = document.createElement("div");
    title.className = "vui_sidebar-item-title vui_ellipsis multi-mode";
    title.textContent = folder.title || "收藏夹";
    Object.assign(title.style, {
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });

    const count = document.createElement("span");
    count.textContent = String(folder.media_count ?? "");
    Object.assign(count.style, {
      marginLeft: "8px",
      color: "#9499a0",
      fontSize: "12px",
      flex: "0 0 auto",
    });

    row.append(title, count);
    link.appendChild(row);
    return link;
  }

  async function repairFavoritesSidebar() {
    if (!isFavoritesPage()) return;

    const upMid = getFavoritesSpaceMid();
    if (!upMid) return;

    const folders = (await getCreatedFavFolders(upMid)).filter(
      (folder) => folder?.id && folder?.title,
    );
    if (folders.length === 0) return;

    const collapse = findCreatedFavoritesCollapse();
    const container = getCreatedFavoritesContainer(collapse);
    if (!container) return;

    const missingFolders = folders.filter((folder) => !hasRenderedFavoriteFolder(folder));
    if (missingFolders.length > 0) {
      const createButton = container.querySelector(".fav-collapse-create");
      missingFolders.forEach((folder) => {
        container.insertBefore(
          createFavoriteFolderSidebarItem(folder, upMid),
          createButton || null,
        );
      });
    }

    const titleText = document.querySelector(".favlist-info-detail__title-row");
    const appearsOnBrokenDefault =
      !getCurrentFavoriteFolderId() &&
      titleText &&
      (titleText.textContent || "").includes("未命名收藏夹");
    if (appearsOnBrokenDefault) {
      location.replace(makeFavoriteFolderUrl(upMid, folders[0].id));
    }
  }

  function getScanDelay() {
    return isFavoritesPage() ? FAVORITES_BOOTSTRAP_DELAY_MS : DOM_BOOTSTRAP_DELAY_MS;
  }

  function startObserver() {
    const runDomScan = () => {
      if (isBiliHeaderMountPending()) return;
      syncTopBarVisibilityClass();
      scanVideoCards();
      if (!isFavoritesPage()) {
        injectDetailButton();
        scanVideos();
      }
    };

    let scanTimer = null;

    const observer = new MutationObserver(() => {
      // 收藏夹页面内容是异步瀑布流，低频补扫即可，避免错过晚加载的卡片
      if (scanTimer) return;
      const throttle = isFavoritesPage()
        ? FAVORITES_SCAN_THROTTLE_MS
        : DOM_SCAN_THROTTLE_MS;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        // SPA 导航保护期内跳过，避免在 Vue 挂载过程中干扰渲染
        if (Date.now() < navGuardUntil) return;
        runDomScan();
      }, throttle);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // startObserver 本身已经由 bootstrap 延迟启动，这里不要再叠加一轮延迟
    runDomScan();
    repairFavoritesSidebar();

    if (isFavoritesPage()) {
      FAVORITES_EXTRA_SCAN_DELAYS.forEach((delay) => {
        setTimeout(runDomScan, delay);
      });
      FAVORITES_SIDEBAR_REPAIR_DELAYS.forEach((delay) => {
        setTimeout(repairFavoritesSidebar, delay);
      });
    }
  }

  // ===== 监听 SPA 路由变化 =====

  function watchNavigation() {
    if (navigationWatchStarted) return;
    navigationWatchStarted = true;

    let lastUrl = location.href;
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        detailBtnInjected = false;
        favCache.clear();
        const scanDelay = getScanDelay();
        navGuardUntil = Date.now() + scanDelay; // 保护期：屏蔽 Observer 在挂载窗口内的扫描
        syncTopBarVisibilityClass();
        ensureChromeVisibilityObserver();
        enforcePlayerChromeVisibility();
        stopFastRateBootstrap();
        startFastRateBootstrap();
        // 路由变化后重新扫描，收藏夹页面给更长时间等 B站渲染完成
        setTimeout(() => {
          if (isBiliHeaderMountPending()) return;
          syncTopBarVisibilityClass();
          ensureChromeVisibilityObserver();
          enforcePlayerChromeVisibility();
          scanVideoCards();
          injectDetailButton();
          scanVideos();
          repairFavoritesSidebar();
        }, scanDelay);
      }
    };

    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    window.setInterval(check, 500);
  }

  // ===== 启动 =====

  function bootstrapDomFeatures() {
    injectStyles();
    watchNavigation();
    startFastRateBootstrap();
    ensureChromeVisibilityObserver();
    enforcePlayerChromeVisibility();
    // 延迟 DOM 扫描/注入，避免在 B 站 SPA 初始挂载期间干扰框架
    // 收藏夹页面给更长时间（3s），避免干扰 B站空间页面渲染
    setTimeout(() => runWhenBiliHeaderReady(startObserver), getScanDelay());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapDomFeatures, {
      once: true,
    });
  } else {
    bootstrapDomFeatures();
  }
})();
