#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const port = process.env.QFAV_BROWSER_PORT || "9333";
const base = `http://127.0.0.1:${port}`;
const injectLocalScript = process.argv.includes("--inject-local-script");
const repoRoot = path.resolve(__dirname, "..");
const userscriptPath = path.join(repoRoot, "bilibili-quick-fav.user.js");
const testUrl = process.env.QFAV_TEST_URL || "https://t.bilibili.com/";
const screenshotPath = process.env.QFAV_SCREENSHOT_PATH || "";

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
        return;
      }
      this.events.push(message);
    };
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  close() {
    this.ws.close();
  }
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const target = await getJson(`${base}/json/new?about:blank`, {
    method: "PUT",
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  if (injectLocalScript) {
    const source = fs.readFileSync(userscriptPath, "utf8");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  const navigationStartedAt = Date.now();
  await cdp.send("Page.navigate", { url: testUrl });

  let firstQuickFavMs = null;
  while (Date.now() - navigationStartedAt < 8000) {
    const probe = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: 'document.querySelector(".qfav-btn,.qfav-detail-btn") !== null',
    });
    if (probe.result?.result?.value === true) {
      firstQuickFavMs = Date.now() - navigationStartedAt;
      break;
    }
    await wait(25);
  }

  const remainingWait = 8000 - (Date.now() - navigationStartedAt);
  if (remainingWait > 0) await wait(remainingWait);

  let coverHover = null;
  const coverProbe = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const button = [...document.querySelectorAll(".qfav-btn")].find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < innerHeight && rect.left < innerWidth;
      });
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        opacity: getComputedStyle(button).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
      };
    })()`,
  });
  const coverBeforeHover = coverProbe.result?.result?.value || null;
  if (coverBeforeHover) {
    const hoverStartedAt = Date.now();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: coverBeforeHover.x,
      y: coverBeforeHover.y,
    });

    let hoveredOpacity = coverBeforeHover.opacity;
    while (Date.now() - hoverStartedAt < 500) {
      const hoverProbe = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: 'getComputedStyle(document.querySelector(".qfav-btn:hover") || document.querySelector("[data-qfav-card=\\"1\\"]:hover > .qfav-btn")).opacity',
      });
      hoveredOpacity = hoverProbe.result?.result?.value || hoveredOpacity;
      if (Number(hoveredOpacity) >= 0.95) break;
      await wait(10);
    }

    coverHover = {
      defaultOpacity: coverBeforeHover.opacity,
      defaultPointerEvents: coverBeforeHover.pointerEvents,
      hoveredOpacity,
      visibleAfterMs: Date.now() - hoverStartedAt,
    };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  }

  let playerTopHover = null;
  const playerProbe = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const player =
        document.querySelector(".bpx-player-container") ||
        document.querySelector(".bpx-player-video-wrap") ||
        document.querySelector("#bilibili-player");
      const top =
        document.querySelector(".bpx-player-control-top") ||
        document.querySelector(".bpx-player-top-wrap") ||
        document.querySelector(".bilibili-player-video-top") ||
        document.querySelector(".squirtle-video-top");
      if (!player || !top) return null;
      const rect = player.getBoundingClientRect();
      const style = getComputedStyle(top);
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + Math.min(100, rect.height / 3),
        beforeVisibility: style.visibility,
        beforeOpacity: style.opacity,
      };
    })()`,
  });
  const playerBeforeHover = playerProbe.result?.result?.value || null;
  if (playerBeforeHover) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: playerBeforeHover.x,
      y: playerBeforeHover.y,
    });
    await wait(300);
    const playerAfterProbe = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const top =
          document.querySelector(".bpx-player-control-top") ||
          document.querySelector(".bpx-player-top-wrap") ||
          document.querySelector(".bilibili-player-video-top") ||
          document.querySelector(".squirtle-video-top");
        if (!top) return null;
        const style = getComputedStyle(top);
        return { visibility: style.visibility, opacity: style.opacity };
      })()`,
    });
    playerTopHover = {
      beforeVisibility: playerBeforeHover.beforeVisibility,
      beforeOpacity: playerBeforeHover.beforeOpacity,
      after: playerAfterProbe.result?.result?.value || null,
    };
  }

  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(
      async () => {
        const nav = await fetch("https://api.bilibili.com/x/web-interface/nav", {
          credentials: "include",
        }).then((r) => r.json()).catch((error) => ({ code: -1, error: String(error) }));

        const detailButton = document.querySelector(".qfav-detail-btn");
        const detailIcon = detailButton?.querySelector("svg");
        const inspectVisibility = (element) => {
          if (!element) return null;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            selector: element.id
              ? "#" + element.id
              : "." + [...element.classList].join("."),
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            textLength: (element.innerText || "").trim().length,
          };
        };
        const pageHeader =
          document.querySelector("#biliMainHeader") ||
          document.querySelector("#bili-header-container") ||
          document.querySelector(".bili-header");
        const playerTop =
          document.querySelector(".bpx-player-control-top") ||
          document.querySelector(".bpx-player-top-wrap") ||
          document.querySelector(".bilibili-player-video-top") ||
          document.querySelector(".squirtle-video-top");
        return {
          url: location.href,
          title: document.title,
          loggedIn: Boolean(nav?.data?.isLogin),
          mid: nav?.data?.mid || null,
          quickFavButtons: document.querySelectorAll(".qfav-btn,.qfav-detail-btn").length,
          firstQuickFavMs: ${firstQuickFavMs},
          coverHover: ${JSON.stringify(coverHover)},
          pageHeader: inspectVisibility(pageHeader),
          playerTop: inspectVisibility(playerTop),
          playerTopHover: ${JSON.stringify(playerTopHover)},
          detailQuickFav: detailButton
            ? {
                active: detailButton.classList.contains("qfav-active"),
                ready: detailButton.dataset.qfavStateReady || null,
                fill: detailIcon?.getAttribute("fill") || null,
                stroke: detailIcon?.getAttribute("stroke") || null,
              }
            : null,
          hasTampermonkey: Boolean(
            [...document.querySelectorAll("script")].some((script) =>
              /tampermonkey|userscript/i.test(script.src || script.textContent || "")
            )
          ),
          bodyPreview: document.body.innerText.slice(0, 120),
        };
      }
    )()`,
  });

  console.log(JSON.stringify(result.result.result.value, null, 2));

  if (screenshotPath) {
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, "base64"));
  }

  await cdp.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
  cdp.close();
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
