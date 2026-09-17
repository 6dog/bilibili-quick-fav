#!/usr/bin/env node
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const port = process.env.QFAV_BROWSER_PORT || "9333";
const allowFavoriteMutation = process.argv.includes("--toggle-favorite");
const favoriteOnly = process.argv.includes("--favorite-only");
const videoOnly = process.argv.includes("--video-only");
const captureStoreScreenshot = process.argv.includes("--capture-store-screenshot");
const captureStoreAssets = process.argv.includes("--capture-store-assets");
const endpoint = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expectedVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error("CDP WebSocket connection failed"));
    });
  }

  send(method, params = {}, timeoutMs = 12_000) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP closed"));
    }
    this.pending.clear();
    this.socket.close();
  }
}

async function evaluate(cdp, expression, userGesture = false) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture,
  }, 30_000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result?.value;
}

async function moveMouse(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function clickMouse(cdp, x, y) {
  await moveMouse(cdp, x, y);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x, y });
}

async function saveStoreScreenshot(cdp, filename) {
  const directory = new URL("../dist/store-assets/", import.meta.url);
  await mkdir(directory, { recursive: true });
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: 40, y: 150, width: 1280, height: 800, scale: 1 },
  });
  await writeFile(new URL(filename, directory), Buffer.from(screenshot.data, "base64"));
}

async function waitFor(cdp, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for: ${expression.slice(0, 90)}`);
}

async function waitForFavoriteUi(cdp, expectedActive, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  const history = [];
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, `(() => {
      const root = document.querySelector('#qfav-extension-root')?.shadowRoot;
      const button = root?.querySelector('.detail-button');
      return {
        active: button?.classList.contains('active'),
        busy: button?.getAttribute('aria-busy'),
        title: button?.title,
        notice: root?.querySelector('.notice')?.textContent || null,
        visible: button ? getComputedStyle(button).visibility : null,
      };
    })()`);
    const serialized = JSON.stringify(state);
    if (history.at(-1) !== serialized) history.push(serialized);
    if (state.busy === "false" && state.active === expectedActive) return;
    await wait(100);
  }
  throw new Error(`favorite: ${label} did not settle after one click (${history.join(" -> ")})`);
}

async function createPage(url) {
  const response = await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Cannot create browser tab: HTTP ${response.status}`);
  const target = await response.json();
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await cdp.send("Page.navigate", { url });
  await cdp.send("Page.bringToFront");
  const expectedHost = JSON.stringify(new URL(url).hostname);
  await waitFor(cdp, `location.hostname === ${expectedHost} && document.readyState !== 'loading'`, 30_000);
  return { cdp, target };
}

async function closePage(page) {
  page.cdp.close();
  await fetch(`${endpoint}/json/close/${page.target.id}`).catch(() => {});
}

const coverProbeExpression = `(() => {
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const links = [...document.querySelectorAll('a[href*="/video/BV"]')];
  const results = [];
  for (const link of links) {
    if (link.closest('header,#biliMainHeader,#bili-header-container,.bili-header,.international-header,.mini-header')) continue;
    const candidates = [...link.querySelectorAll('img,video,canvas')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 64 && rect.height >= 36 && rect.bottom > 0 && rect.top < innerHeight)
      .sort((a, b) => area(b.rect) - area(a.rect));
    const primary = candidates[0];
    if (!primary) continue;
    let surface = primary.element;
    const mediaArea = area(primary.rect);
    for (let node = primary.element.parentElement; node && link.contains(node); node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= primary.rect.width * .9 && rect.height >= primary.rect.height * .9 && area(rect) <= mediaArea * 1.2) surface = node;
      if (node === link) break;
    }
    const rect = surface.getBoundingClientRect();
    results.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } });
    if (results.length >= 12) break;
  }
  return results;
})()`;

async function inspectBase(cdp) {
  return evaluate(cdp, `(() => {
    const host = document.querySelector('#qfav-extension-root');
    const root = host?.shadowRoot;
    const header = document.querySelector('#biliMainHeader,#bili-header-container,.bili-header');
    return {
      version: host?.dataset.version || null,
      runtime: host?.dataset.runtime || null,
      directBodyChild: host?.parentElement === document.body,
      shadow: Boolean(root),
      coverButtonCount: root?.querySelectorAll('.cover-button').length || 0,
      detailButtonCount: root?.querySelectorAll('.detail-button').length || 0,
      headerText: (header?.textContent || '').trim().length,
      oldUserscriptPresent: Boolean(document.querySelector('#qfav-overlay-host')),
    };
  })()`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkCoverPage(label, url) {
  const page = await createPage(url);
  try {
    await waitFor(page.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot");
    await wait(3_000);
    const base = await inspectBase(page.cdp);
    assert(base.version === expectedVersion, `${label}: extension version marker missing`);
    assert(base.runtime === "chrome-extension", `${label}: wrong runtime`);
    assert(base.directBodyChild && base.shadow, `${label}: Shadow DOM isolation missing`);
    assert(base.coverButtonCount === 1, `${label}: expected one reusable cover button`);
    assert(!base.oldUserscriptPresent, `${label}: old userscript is also active`);
    const covers = await evaluate(page.cdp, coverProbeExpression);
    assert(covers.length > 0, `${label}: no visible BVID cover found`);
    let cover = null;
    let hovered = null;
    for (const candidate of covers) {
      const stillVideo = await evaluate(page.cdp, `Boolean(document.elementFromPoint(${candidate.x}, ${candidate.y})?.closest?.('a[href*="/video/BV"]'))`);
      if (!stillVideo) continue;
      await moveMouse(page.cdp, candidate.x, candidate.y);
      await wait(350);
      const state = await evaluate(page.cdp, `(() => {
      const button = document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.cover-button');
      const style = button ? getComputedStyle(button) : null;
      const rect = button?.getBoundingClientRect();
      const hit = document.elementFromPoint(${candidate.x}, ${candidate.y});
      return {
        visible: style?.visibility === 'visible' && Number(style.opacity) > .2,
        visibility: style?.visibility || null,
        opacity: Number(style?.opacity || 0),
        disabled: Boolean(button?.disabled),
        left: rect?.left,
        top: rect?.top,
        hitTag: hit?.tagName || null,
        hitInsideVideoLink: Boolean(hit?.closest?.('a[href*="/video/BV"]')),
      };
      })()`);
      if (state.visible && state.hitInsideVideoLink) {
        cover = candidate;
        hovered = state;
        break;
      }
      await moveMouse(page.cdp, 2, 2);
      await wait(80);
    }
    assert(cover && hovered, `${label}: no stable BVID cover produced a hover button (${JSON.stringify(hovered)})`);
    assert(hovered.visible, `${label}: cover button did not appear on hover (${JSON.stringify(hovered)})`);
    assert(!hovered.disabled, `${label}: first cover click would be swallowed while state loads`);
    assert(hovered.left >= cover.rect.left && hovered.left < cover.rect.right, `${label}: button escaped cover horizontally`);
    assert(hovered.top >= cover.rect.top && hovered.top < cover.rect.bottom, `${label}: button escaped cover vertically`);
    const buttonPoint = await evaluate(page.cdp, `(() => {
      const rect = document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.cover-button')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    assert(buttonPoint, `${label}: cover button has no hit target`);
    await moveMouse(page.cdp, buttonPoint.x, buttonPoint.y);
    await wait(180);
    const buttonHoverVisible = await evaluate(page.cdp, `(() => {
      const button = document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.cover-button');
      const style = button ? getComputedStyle(button) : null;
      return style?.visibility === 'visible' && Number(style.opacity) > .2 && button?.matches(':hover');
    })()`);
    assert(buttonHoverVisible, `${label}: cover button flickered or disappeared while pointer was over it`);
    if (captureStoreAssets && label === "home") {
      await saveStoreScreenshot(page.cdp, "cover-1280x800.png");
      await clickMouse(page.cdp, buttonPoint.x, buttonPoint.y);
      await waitFor(page.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.folder')", 10_000);
      await saveStoreScreenshot(page.cdp, "picker-1280x800.png");
      return { label, version: base.version, cover: "pass", picker: "pass", screenshots: "captured" };
    }
    await moveMouse(page.cdp, 2, 2);
    await wait(200);
    const outsideVisible = await evaluate(page.cdp, `getComputedStyle(document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.cover-button')).visibility === 'visible'`);
    assert(!outsideVisible, `${label}: button remained after leaving cover`);

    await moveMouse(page.cdp, cover.x, cover.y);
    const scroll = await evaluate(page.cdp, `(() => { const before = scrollY; scrollBy(0, Math.min(500, Math.max(100, document.documentElement.scrollHeight - innerHeight))); return { before, after: scrollY }; })()`);
    await wait(250);
    if (scroll.after !== scroll.before) {
      const scrollVisible = await evaluate(page.cdp, `getComputedStyle(document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.cover-button')).visibility === 'visible'`);
      assert(!scrollVisible, `${label}: button remained visible while scrolling`);
    }
    return { label, version: base.version, cover: "pass", scroll: scroll.after !== scroll.before ? "pass" : "not-scrollable" };
  } finally {
    await closePage(page);
  }
}

async function checkVideoPage(url) {
  const page = await createPage(url);
  try {
    await waitFor(page.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot");
    await waitFor(page.cdp, "document.querySelector('.bpx-player-video-wrap video,#bilibili-player video')", 30_000);
    await wait(4_500);
    const base = await inspectBase(page.cdp);
    assert(base.version === expectedVersion && base.detailButtonCount === 1, "video: extension/detail marker missing");
    assert(!base.oldUserscriptPresent, "video: old userscript is also active");
    const initial = await evaluate(page.cdp, `(() => {
      const video = document.querySelector('.bpx-player-video-wrap video,#bilibili-player video');
      const button = document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.detail-button');
      const rect = button.getBoundingClientRect();
      const player = document.querySelector('#bilibili-player,.bpx-player-container')?.getBoundingClientRect();
      return { rate: video?.playbackRate, visible: getComputedStyle(button).visibility === 'visible', button: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, player: player && { left: player.left, top: player.top, right: player.right, bottom: player.bottom } };
    })()`);
    assert(Math.abs(initial.rate - 1.5) < .01, `video: expected 1.5x, got ${initial.rate}`);
    assert(initial.visible, "video: detail button is not safely visible");
    assert(initial.player && initial.button.top >= initial.player.bottom - 2, "video: detail button is not below player");
    if (process.argv.includes("--speed-diagnostics")) {
      const candidates = await evaluate(page.cdp, `(() => [...document.querySelectorAll('[class*="playbackrate"],[class*="speed"]')]
        .map(element => ({ className: String(element.className).slice(0, 90), text: (element.textContent || '').trim().slice(0, 45), rect: element.getBoundingClientRect() }))
        .filter(item => item.rect.width > 0 && item.rect.height > 0)
        .slice(0, 30).map(({ className, text, rect }) => ({ className, text, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })))()`);
      console.log(JSON.stringify({ speedCandidates: candidates }));
    }
    if (captureStoreScreenshot) {
      const screenshot = await page.cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 40, y: 160, width: 1280, height: 800, scale: 1 },
      });
      await writeFile(new URL("../dist/store-assets/screenshot-1280x800.png", import.meta.url), Buffer.from(screenshot.data, "base64"));
    }

    await waitFor(page.cdp, `document.documentElement.scrollHeight > innerHeight + 800`, 30_000);
    const scrollSamples = [];
    let toolbarLeftViewport = false;
    for (let index = 0; index < 24; index += 1) {
      const sample = await evaluate(page.cdp, `(() => {
        const before = scrollY;
        scrollTo({ top: before + 120, behavior: 'instant' });
        return { before, after: scrollY };
      })()`);
      const frame = await evaluate(page.cdp, `(async () => {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const root = document.querySelector('#qfav-extension-root')?.shadowRoot;
        const button = root?.querySelector('.detail-button');
        const anchor = document.querySelector('.video-toolbar-left')?.getBoundingClientRect();
        const player = document.querySelector('#bilibili-player,.bpx-player-container')?.getBoundingClientRect();
        const rect = button?.getBoundingClientRect();
        return {
          scrollY,
          viewportHeight: innerHeight,
          anchor: anchor && { top: anchor.top, bottom: anchor.bottom, right: anchor.right },
          player: player && { left: player.left, top: player.top, right: player.right, bottom: player.bottom },
          button: rect && { top: rect.top, bottom: rect.bottom, left: rect.left },
          visible: button ? getComputedStyle(button).visibility === 'visible' : false,
        };
      })()`);
      const frameSafe = frame.anchor && frame.button && frame.player && frame.anchor.top >= 2 && frame.button.top >= 0 && frame.button.bottom <= frame.viewportHeight && frame.anchor.top >= frame.player.bottom - 2 && frame.button.top >= frame.player.bottom && frame.anchor.bottom <= frame.viewportHeight;
      if (frameSafe) {
        const expectedTop = frame.anchor.top + (frame.anchor.bottom - frame.anchor.top - 40) / 2;
        assert(frame.visible, `video: detail button flickered off during safe scroll (${JSON.stringify(frame)})`);
        assert(Math.abs(frame.button.top - expectedTop) <= 1 && Math.abs(frame.button.left - (frame.anchor.right + 8)) <= 1,
          `video: detail button lagged behind toolbar during scroll (${JSON.stringify(frame)})`);
      }
      await wait(70);
      const rendered = await evaluate(page.cdp, `(() => {
        const root = document.querySelector('#qfav-extension-root')?.shadowRoot;
        const button = root?.querySelector('.detail-button');
        const anchor = document.querySelector('.video-toolbar-left')?.getBoundingClientRect();
        const player = document.querySelector('#bilibili-player,.bpx-player-container')?.getBoundingClientRect();
        const rect = button?.getBoundingClientRect();
        return {
          scrollY,
          anchor: anchor && { top: anchor.top, bottom: anchor.bottom, right: anchor.right },
          player: player && { left: player.left, top: player.top, right: player.right, bottom: player.bottom },
          button: rect && { top: rect.top, bottom: rect.bottom, left: rect.left },
          visible: button ? getComputedStyle(button).visibility === 'visible' : false,
        };
      })()`);
      const renderedSafe = rendered.anchor && rendered.button && rendered.player && rendered.anchor.top >= 2 && rendered.button.top >= 0 && rendered.button.bottom <= frame.viewportHeight && rendered.anchor.top >= rendered.player.bottom - 2 && rendered.button.top >= rendered.player.bottom && rendered.anchor.bottom <= frame.viewportHeight;
      if (renderedSafe) {
        assert(rendered.visible, `video: detail button flickered after scroll (${JSON.stringify(rendered)})`);
      }
      scrollSamples.push({ frame, settled: rendered });
      if (rendered.anchor?.bottom <= 0) {
        toolbarLeftViewport = true;
        assert(!rendered.visible, `video: detail button remained visible after toolbar left viewport (${JSON.stringify(scrollSamples)})`);
        break;
      }
      if (sample.after === sample.before) break;
    }
    if (!toolbarLeftViewport) {
      const scrollContainers = await evaluate(page.cdp, `(() => [...document.querySelectorAll('*')]
        .filter(element => element.scrollHeight > element.clientHeight + 100)
        .map(element => { const style = getComputedStyle(element); return { tag: element.tagName, id: element.id, className: String(element.className).slice(0, 100), overflowY: style.overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop }; })
        .filter(item => item.overflowY === 'auto' || item.overflowY === 'scroll')
        .slice(0, 12))()`);
      throw new Error(`video: could not scroll toolbar out of viewport (${JSON.stringify({ scrollSamples, scrollContainers })})`);
    }
    await evaluate(page.cdp, `scrollTo(0, 0)`);
    await waitFor(page.cdp, `document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.detail-button.visible')`, 5_000);

    const speedControl = await evaluate(page.cdp, `(() => {
      const rect = document.querySelector('.bpx-player-ctrl-playbackrate')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    assert(speedControl, 'video: speed menu control not found');
    await moveMouse(page.cdp, speedControl.x, speedControl.y);
    await wait(350);
    const speedItem = await evaluate(page.cdp, `(() => {
      const item = [...document.querySelectorAll('.bpx-player-ctrl-playbackrate-menu-item')]
        .find(element => /(^|\\D)2(?:\\.0)?\\s*[x倍]/i.test((element.textContent || '').trim()));
      const rect = item?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    assert(speedItem, 'video: actual 2x menu item not visible');
    await clickMouse(page.cdp, speedItem.x, speedItem.y);
    await wait(2_000);
    const retained = await evaluate(page.cdp, `document.querySelector('.bpx-player-video-wrap video,#bilibili-player video').playbackRate`);
    assert(Math.abs(retained - 2) < .01, `video: manual 2x was overridden (${retained})`);

    await evaluate(page.cdp, `(() => {
      const next = new URL(location.href);
      next.searchParams.set('p', next.searchParams.get('p') === '2' ? '3' : '2');
      history.pushState({}, '', next);
    })()`);
    await waitFor(page.cdp, `Math.abs(document.querySelector('.bpx-player-video-wrap video,#bilibili-player video')?.playbackRate - 1.5) < .01`, 8_000);

    await evaluate(page.cdp, `document.documentElement.requestFullscreen()`, true);
    await wait(500);
    const fullscreenHidden = await evaluate(page.cdp, `document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.layer').classList.contains('fullscreen-hidden')`);
    assert(fullscreenHidden, "video: extension UI remained visible in fullscreen");
    await evaluate(page.cdp, `document.exitFullscreen()`, true);
    await wait(700);
    return { label: "video", version: base.version, rate: "1.5/pass", manualRate: "2.0/pass", semanticRoute: "pass", fullscreen: "pass", detail: "pass" };
  } finally {
    await closePage(page);
  }
}

async function checkCrossTabSync(url) {
  const extensionId = process.env.QFAV_EXTENSION_ID;
  assert(extensionId, "cross-tab: loaded extension id is missing");
  let first = null;
  let second = null;
  let popup = null;
  let initialEnabled = null;
  let senderTabId = null;
  try {
    popup = await createPage(`chrome-extension://${extensionId}/popup/index.html`);
    const existingTabs = await evaluate(popup.cdp, `(async () => (await chrome.tabs.query({})).map(tab => tab.id).filter(Boolean))()`);
    first = await createPage(url);
    await waitFor(first.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot");
    second = await createPage(url);
    await waitFor(second.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot");
    const tabs = await evaluate(popup.cdp, `(async () => {
      const tabs = await chrome.tabs.query({});
      const active = [];
      for (const tab of tabs) {
        if (!tab.id || ${JSON.stringify(existingTabs)}.includes(tab.id)) continue;
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
          if (response?.ok && response.status?.version === ${JSON.stringify(expectedVersion)} && response.status.supportedPage) active.push(tab.id);
        } catch { /* Non-Bilibili tabs have no content script. */ }
      }
      return active;
    })()`);
    assert(tabs.length === 2, `cross-tab: expected exactly two Bilibili tabs, got ${tabs.length}`);
    senderTabId = tabs[0];
    const receiverTabId = tabs[1];
    const status = async (tabId) => evaluate(popup.cdp, `(async () => {
      const result = await chrome.tabs.sendMessage(${tabId}, { type: 'GET_STATUS' });
      return result?.ok ? { enabled: result.status?.playbackEnabled, rate: result.status?.playbackRate } : null;
    })()`);
    const setEnabled = async (enabled) => evaluate(popup.cdp, `(async () => {
      const result = await chrome.tabs.sendMessage(${senderTabId}, { type: 'SET_PLAYBACK_ENABLED', enabled: ${enabled} });
      return result?.ok === true;
    })()`);
    initialEnabled = (await status(senderTabId))?.enabled;
    assert(typeof initialEnabled === "boolean", "cross-tab: cannot read initial setting");
    assert(await setEnabled(!initialEnabled), "cross-tab: setting change failed");
    await waitFor(popup.cdp, `(async () => {
      const result = await chrome.tabs.sendMessage(${receiverTabId}, { type: 'GET_STATUS' });
      return result?.ok && result.status?.playbackEnabled === ${!initialEnabled};
    })()`, 10_000);
    assert(await setEnabled(initialEnabled), "cross-tab: setting restore failed");
    await waitFor(popup.cdp, `(async () => {
      const result = await chrome.tabs.sendMessage(${receiverTabId}, { type: 'GET_STATUS' });
      return result?.ok && result.status?.playbackEnabled === ${initialEnabled};
    })()`, 10_000);
    return { label: "cross-tab", settingSync: "pass", restored: true };
  } finally {
    if (popup && senderTabId !== null && initialEnabled !== null) {
      await evaluate(popup.cdp, `(async () => {
        const result = await chrome.tabs.sendMessage(${senderTabId}, { type: 'SET_PLAYBACK_ENABLED', enabled: ${initialEnabled} });
        return result?.ok === true;
      })()`).catch(() => {});
    }
    if (popup) await closePage(popup);
    if (second) await closePage(second);
    if (first) await closePage(first);
  }
}

async function reversibleFavoriteTest(url) {
  const page = await createPage(url);
  let baseline = null;
  let target = null;
  let writeAttempted = false;
  let restored = false;
  const readStates = async (aid, expectedMid) => evaluate(page.cdp, `(async () => {
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(r => r.json());
    if (nav.code !== 0 || String(nav.data?.mid) !== ${JSON.stringify(expectedMid)}) throw new Error('favorite: account changed during test');
    const list = await fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + nav.data.mid + '&type=2&rid=${aid}', { credentials: 'include' }).then(r => r.json());
    if (list.code !== 0 || !Array.isArray(list.data?.list)) throw new Error('favorite: folder state read failed');
    return list.data.list.map(item => ({ id: String(item.id), title: String(item.title), active: Number(item.fav_state) }));
  })()`);
  const buttonPoint = () => evaluate(page.cdp, `(() => {
    const button = document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.detail-button.visible');
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  const assertOnlyTargetChanged = (before, after, expectedActive) => {
    assert(before.length === after.length, 'favorite: folder list changed during test');
    for (const folder of before) {
      const current = after.find(item => item.id === folder.id);
      assert(current, 'favorite: a folder disappeared during test');
      assert(current.active === (folder.id === target.id ? expectedActive : folder.active),
        `favorite: unexpected state change in folder ${folder.id}`);
    }
  };
  try {
    await waitFor(page.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.detail-button.visible')", 30_000);
    const identity = await evaluate(page.cdp, `(async () => {
      const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(r => r.json());
      const bvid = location.pathname.split('/').find(part => part.startsWith('BV'));
      const view = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' }).then(r => r.json());
      if (nav.code !== 0 || !nav.data?.mid || view.code !== 0 || !view.data?.aid) throw new Error('favorite: login or video lookup failed');
      return { mid: String(nav.data.mid), aid: view.data.aid };
    })()`);
    baseline = { ...identity, states: await readStates(identity.aid, identity.mid) };
    assert(baseline.states.length > 0, 'favorite: account has no folder to test');
    assert(baseline.states.every(item => item.active === 0 || item.active === 1), 'favorite: state is not confirmed');
    const title = await evaluate(page.cdp, `document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.detail-button').title`);
    const firstUse = title === '选择快捷收藏夹';
    const requestedId = process.env.QFAV_TEST_FOLDER_ID || 'auto';
    if (firstUse) {
      target = baseline.states.find(item => item.active === 0 && (requestedId === 'auto' || item.id === requestedId));
    } else {
      const selectedTitle = title.match(/「(.+)」/)?.[1];
      const matches = baseline.states.filter(item => item.title === selectedTitle);
      assert(matches.length === 1, 'favorite: existing selection is ambiguous; choose a unique test folder first');
      target = matches[0];
      assert(requestedId === 'auto' || target.id === requestedId, 'favorite: configured folder differs from QFAV_TEST_FOLDER_ID');
    }
    assert(target, 'favorite: no eligible target folder');
    assert(target.active === 0, 'favorite: target already contains this video; choose another test video');
    const firstStartedAt = Date.now();
    if (firstUse) {
      const point = await buttonPoint();
      assert(point, 'favorite: detail button disappeared before selection');
      const hit = await evaluate(page.cdp, `(() => {
        const button = document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.detail-button');
        const rect = button.getBoundingClientRect();
        const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const inner = button.getRootNode().elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { hitTag: element?.tagName, hitClass: String(element?.className || '').slice(0, 80), innerTag: inner?.tagName, innerClass: String(inner?.className || '').slice(0, 80), inExtension: inner === button || button.contains(inner) };
      })()`);
      assert(hit.inExtension, `favorite: detail button is covered (${JSON.stringify(hit)})`);
      await clickMouse(page.cdp, point.x, point.y);
      try {
        await waitFor(page.cdp, "document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.folder')", 10_000);
      } catch {
        const state = await evaluate(page.cdp, `(() => {
          const root = document.querySelector('#qfav-extension-root')?.shadowRoot;
          return { notice: root?.querySelector('.notice')?.textContent || null, dialog: Boolean(root?.querySelector('.dialog')), busy: root?.querySelector('.detail-button')?.getAttribute('aria-busy') };
        })()`);
        throw new Error(`favorite: folder picker did not open (${JSON.stringify(state)})`);
      }
      const index = baseline.states.findIndex(item => item.id === target.id);
      const selectionPoint = await evaluate(page.cdp, `(() => {
        const buttons = [...document.querySelector('#qfav-extension-root').shadowRoot.querySelectorAll('.folder')];
        if (buttons.length !== ${baseline.states.length}) return null;
        const r = buttons[${index}]?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      })()`);
      assert(selectionPoint, 'favorite: folder picker differs from the preflight list');
      writeAttempted = true;
      await clickMouse(page.cdp, selectionPoint.x, selectionPoint.y);
    } else {
      const point = await buttonPoint();
      assert(point, 'favorite: detail button disappeared before write');
      writeAttempted = true;
      await clickMouse(page.cdp, point.x, point.y);
    }
    await waitForFavoriteUi(page.cdp, true, 'add operation');
    const firstClickMs = Date.now() - firstStartedAt;
    const afterAdd = await readStates(baseline.aid, baseline.mid);
    assertOnlyTargetChanged(baseline.states, afterAdd, 1);
    const point = await buttonPoint();
    assert(point, 'favorite: detail button disappeared before restore');
    const secondStartedAt = Date.now();
    await clickMouse(page.cdp, point.x, point.y);
    await waitForFavoriteUi(page.cdp, false, 'remove operation');
    const secondClickMs = Date.now() - secondStartedAt;
    const afterRemove = await readStates(baseline.aid, baseline.mid);
    assertOnlyTargetChanged(baseline.states, afterRemove, 0);
    restored = true;
    return { label: 'favorite', targetFolderId: target.id, changedFolders: 1, restored: true, firstClickMs, secondClickMs };
  } finally {
    try {
      if (writeAttempted && !restored && baseline && target) {
        const current = await readStates(baseline.aid, baseline.mid);
        const state = current.find(item => item.id === target.id)?.active;
        if (state === 1) {
          const point = await buttonPoint();
          assert(point, 'favorite: target changed but restore button is unavailable');
          await clickMouse(page.cdp, point.x, point.y);
          await waitForFavoriteUi(page.cdp, false, 'emergency restore');
          const after = await readStates(baseline.aid, baseline.mid);
          assert(after.find(item => item.id === target.id)?.active === 0, 'favorite: target folder was not restored');
        } else {
          assert(state === 0, 'favorite: target state is unknown; manual verification required');
        }
      }
    } finally {
      await closePage(page);
    }
  }
}

async function main() {
  const version = await fetch(`${endpoint}/json/version`).then((response) => response.json()).catch(() => null);
  if (!version) throw new Error(`No Chrome DevTools endpoint on port ${port}`);
  const results = [];
  const videoUrl = "https://www.bilibili.com/video/BV1AxtJ6NEFR/";
  if (!favoriteOnly && !videoOnly) {
    results.push(await checkCoverPage("home", "https://www.bilibili.com/"));
    results.push(await checkCoverPage("popular", "https://www.bilibili.com/v/popular/all/"));
    results.push(await checkCoverPage("search", "https://search.bilibili.com/all?keyword=Chrome"));
    results.push(await checkCoverPage("dynamic", "https://t.bilibili.com/"));
  }
  if (!favoriteOnly) {
    results.push(await checkVideoPage(videoUrl));
    if (!videoOnly) results.push(await checkCrossTabSync(videoUrl));
  }
  if (allowFavoriteMutation) results.push(await reversibleFavoriteTest(videoUrl));
  console.log(JSON.stringify({ ok: true, favoriteMutation: allowFavoriteMutation, results }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
