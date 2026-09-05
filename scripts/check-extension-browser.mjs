#!/usr/bin/env node
import process from "node:process";

const port = process.env.QFAV_BROWSER_PORT || "9333";
const allowFavoriteMutation = process.argv.includes("--toggle-favorite");
const favoriteOnly = process.argv.includes("--favorite-only");
const endpoint = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitFor(cdp, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for: ${expression.slice(0, 90)}`);
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
  const expectedHost = JSON.stringify(new URL(url).hostname);
  await waitFor(cdp, `location.hostname === ${expectedHost} && document.readyState === 'complete'`, 30_000);
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
    assert(base.version === "2.0.1", `${label}: extension version marker missing`);
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
    assert(base.version === "2.0.1" && base.detailButtonCount === 1, "video: extension/detail marker missing");
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

    await evaluate(page.cdp, `(() => { const video = document.querySelector('.bpx-player-video-wrap video,#bilibili-player video'); video.playbackRate = 2; })()`);
    await wait(2_000);
    const retained = await evaluate(page.cdp, `document.querySelector('.bpx-player-video-wrap video,#bilibili-player video').playbackRate`);
    assert(Math.abs(retained - 2) < .01, `video: manual 2x was overridden (${retained})`);

    await evaluate(page.cdp, `document.documentElement.requestFullscreen()`, true);
    await wait(500);
    const fullscreenHidden = await evaluate(page.cdp, `document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.layer').classList.contains('fullscreen-hidden')`);
    assert(fullscreenHidden, "video: extension UI remained visible in fullscreen");
    await evaluate(page.cdp, `document.exitFullscreen()`, true);
    await wait(700);
    return { label: "video", version: base.version, rate: "1.5/pass", manualRate: "2.0/pass", fullscreen: "pass", detail: "pass" };
  } finally {
    await closePage(page);
  }
}

async function reversibleFavoriteTest(url) {
  const page = await createPage(url);
  let snapshot = null;
  try {
    await waitFor(page.cdp, "document.querySelector('#qfav-extension-root')?.shadowRoot?.querySelector('.detail-button.visible')", 30_000);
    snapshot = await evaluate(page.cdp, `(async () => {
      const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(r => r.json());
      const bvid = location.pathname.match(/\\/video\\/(BV[\\w]+)/)?.[1];
      const view = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' }).then(r => r.json());
      const list = await fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + nav.data.mid + '&type=2&rid=' + view.data.aid, { credentials: 'include' }).then(r => r.json());
      return { aid: view.data.aid, states: list.data.list.map(item => [String(item.id), Number(item.fav_state)]), folderCount: list.data.list.length };
    })()`);
    assert(snapshot.folderCount > 0, "favorite: account has no folder to test");
    const buttonPoint = await evaluate(page.cdp, `(() => { const r = document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.detail-button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await clickMouse(page.cdp, buttonPoint.x, buttonPoint.y);
    await waitFor(page.cdp, "document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.folder')", 8_000);
    const folderPoint = await evaluate(page.cdp, `(() => { const r = document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.folder').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await clickMouse(page.cdp, folderPoint.x, folderPoint.y);
    await wait(3_000);
    const afterFirst = await evaluate(page.cdp, `(async () => {
      const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(r => r.json());
      const list = await fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + nav.data.mid + '&type=2&rid=${snapshot.aid}', { credentials: 'include' }).then(r => r.json());
      return list.data.list.map(item => [String(item.id), Number(item.fav_state)]);
    })()`);
    const changed = afterFirst.filter(([id, state]) => snapshot.states.find(([beforeId]) => beforeId === id)?.[1] !== state);
    assert(changed.length === 1, `favorite: expected exactly one folder change, got ${changed.length}`);
    await waitFor(page.cdp, "document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.detail-button.visible:not(:disabled)')", 8_000);
    const secondPoint = await evaluate(page.cdp, `(() => { const r = document.querySelector('#qfav-extension-root').shadowRoot.querySelector('.detail-button').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await clickMouse(page.cdp, secondPoint.x, secondPoint.y);
    await wait(3_000);
    const restored = await evaluate(page.cdp, `(async () => {
      const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(r => r.json());
      const list = await fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + nav.data.mid + '&type=2&rid=${snapshot.aid}', { credentials: 'include' }).then(r => r.json());
      return list.data.list.map(item => [String(item.id), Number(item.fav_state)]);
    })()`);
    assert(JSON.stringify(restored) === JSON.stringify(snapshot.states), "favorite: original folder state was not restored exactly");
    return { label: "favorite", changedFolders: 1, restored: true };
  } finally {
    try {
      if (snapshot) {
        const cleanup = await evaluate(page.cdp, `(async () => {
        const expected = ${JSON.stringify(snapshot?.states ?? [])};
        const aid = ${snapshot?.aid ?? 0};
        const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then(r => r.json());
        const read = async () => fetch('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + nav.data.mid + '&type=2&rid=' + aid, { credentials: 'include' }).then(r => r.json()).then(data => data.data.list.map(item => [String(item.id), Number(item.fav_state)]));
        const current = await read();
        const add = [];
        const remove = [];
        for (const [id, state] of expected) {
          const now = current.find(([currentId]) => currentId === id)?.[1];
          if (now === state) continue;
          (state === 1 ? add : remove).push(id);
        }
        if (add.length || remove.length) {
          const csrf = document.cookie.match(/(?:^|;\\s*)bili_jct=([^;]+)/)?.[1];
          if (!csrf) return false;
          const body = new URLSearchParams({ rid: String(aid), type: '2', csrf: decodeURIComponent(csrf) });
          if (add.length) body.set('add_media_ids', add.join(','));
          if (remove.length) body.set('del_media_ids', remove.join(','));
          const result = await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }).then(r => r.json());
          if (result.code !== 0) return false;
          await new Promise(resolve => setTimeout(resolve, 600));
        }
        return JSON.stringify(await read()) === JSON.stringify(expected);
        })()`);
        assert(cleanup, "favorite: emergency cleanup could not restore the original folder state");
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
  const videoUrl = "https://www.bilibili.com/video/BV11ohV68EP8/";
  if (!favoriteOnly) {
    results.push(await checkCoverPage("home", "https://www.bilibili.com/"));
    results.push(await checkCoverPage("popular", "https://www.bilibili.com/v/popular/all/"));
    results.push(await checkCoverPage("search", "https://search.bilibili.com/all?keyword=Chrome"));
    results.push(await checkCoverPage("dynamic", "https://t.bilibili.com/"));
    results.push(await checkVideoPage(videoUrl));
  }
  if (allowFavoriteMutation) results.push(await reversibleFavoriteTest(videoUrl));
  console.log(JSON.stringify({ ok: true, favoriteMutation: allowFavoriteMutation, results }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
