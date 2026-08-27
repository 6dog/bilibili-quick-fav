#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const port = process.env.QFAV_BROWSER_PORT || "9333";
const base = `http://127.0.0.1:${port}`;
const injectLocalScript = process.argv.includes("--inject-local-script");
const toggleDetailFavorite = process.argv.includes("--toggle-detail-favorite");
const probeManualRate = process.argv.includes("--probe-manual-rate");
const probeSemanticRoute = process.argv.includes("--probe-semantic-route");
const probeFullscreen = process.argv.includes("--probe-fullscreen");
const probeDetailEdge = process.argv.includes("--probe-detail-edge");
const probeLayoutTimeline =
  process.argv.includes("--probe-layout-timeline") || probeDetailEdge;
const probeStateFailure = process.argv.includes("--probe-state-failure");
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

async function inspectHeader(cdp) {
  const result = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const header =
        document.querySelector("#biliMainHeader") ||
        document.querySelector("#bili-header-container") ||
        document.querySelector(".bili-header");
      return header
        ? {
            textLength: (header.innerText || "").trim().length,
            childCount: header.childElementCount,
            htmlLength: header.innerHTML.length,
          }
        : null;
    })()`,
  });
  return result.result?.result?.value || null;
}

async function clickAt(cdp, point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
}

function collectAssertionFailures(result) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const isVideoPage = /\/video\/BV/.test(result.url || "");

  expect(result.loggedIn === true, "dedicated browser is not logged in");
  expect(result.overlay?.directBodyChild, "overlay is not a direct body child");
  expect(result.overlay?.hasShadowRoot, "overlay Shadow DOM is missing");
  expect(result.quickFavButtons > 0, "no quick-favorite buttons were created");
  expect(result.duplicateTargetButtons === 0, "duplicate cover buttons detected");
  expect(result.nativeQuickFavButtons === 0, "buttons leaked into native DOM");
  expect(result.mutatedNativeCards === 0, "native cards were mutated");
  expect((result.pageHeader?.textLength || 0) > 0, "Bilibili header is empty");
  expect(
    (result.layoutTimeline?.violations?.length || 0) === 0,
    "a visible detail button overlapped or moved above the player",
  );

  if (result.coverHover) {
    if (!probeStateFailure) {
      expect(Number(result.coverHover.defaultOpacity) === 0, "cover button is visible before hover");
      expect(
        result.coverHover.defaultPointerEvents === "none",
        "cover button accepts clicks before hover",
      );
      expect(Number(result.coverHover.hoveredOpacity) >= 0.9, "cover button did not appear on hover");
    }
  }

  if (isVideoPage) {
    expect(result.detailQuickFav?.count === 1, "detail button count is not exactly one");
    expect(result.detailQuickFav?.ready === "1", "detail favorite state was not confirmed");
  }

  if (probeLayoutTimeline) {
    expect(result.viewportLayoutTest?.tested, "viewport layout probe did not run");
    expect(result.viewportLayoutTest?.entries?.length === 4, "viewport matrix is incomplete");
    for (const entry of result.viewportLayoutTest?.entries || []) {
      expect(entry.state, `viewport ${entry.width}x${entry.height} has no detail state`);
      if (entry.state?.visible) {
        expect(!entry.state.overlaps, `detail overlaps player at ${entry.width}x${entry.height}`);
        expect(entry.state.anchorBelow, `detail anchor is above player at ${entry.width}x${entry.height}`);
      }
      expect(entry.state?.detailCount === 1, `detail count changed at ${entry.width}x${entry.height}`);
    }
  }

  if (probeDetailEdge) {
    expect(result.detailEdgeTest?.tested, "detail edge probe did not run");
    expect(result.detailEdgeTest?.shiftedVisibility === "hidden", "offscreen detail remained visible");
    expect(result.detailEdgeTest?.overlappingVisibility === "hidden", "overlapping detail remained visible");
    expect(result.detailEdgeTest?.animatedVisibleOverlaps === 0, "detail flashed during layout animation");
    expect(result.detailEdgeTest?.restoredVisibility === "visible", "detail did not restore after layout settled");
  }

  if (probeFullscreen) {
    expect(result.fullscreenTest?.tested, "fullscreen probe did not run");
    expect(result.fullscreenTest?.during?.overlayVisibility === "hidden", "web fullscreen overlay is visible");
    expect(result.fullscreenTest?.nativeDuring?.overlayVisibility === "hidden", "native fullscreen overlay is visible");
    expect(result.fullscreenTest?.after?.overlayVisibility === "visible", "overlay did not restore after fullscreen");
  }

  if (probeSemanticRoute) {
    const semantic = result.semanticRouteTest;
    expect(semantic?.tested, "semantic route probe did not run");
    expect(
      semantic?.changed?.detailBvid === semantic?.changed?.expectedBvid,
      "detail button retained the previous BVID after SPA navigation",
    );
    expect(semantic?.changed?.detailCount === 1, "SPA navigation created duplicate detail buttons");
  }

  if (probeManualRate) {
    expect(result.manualRateTest?.tested, "manual rate probe did not run");
    expect(result.manualRateTest?.afterManual === 2, "manual 2x rate was not applied");
    expect(result.manualRateTest?.retained === 2, "manual 2x rate was overridden");
    expect(result.manualRateTest?.restored === 1.5, "playback rate was not restored to 1.5x");
  }

  if (toggleDetailFavorite) {
    const live = result.liveFavoriteTest;
    expect(live?.tested, "live favorite probe did not run");
    expect(!live?.error, `live favorite probe failed: ${live?.error || "unknown error"}`);
    expect(live?.firstAny === !live?.originalAny, "first favorite toggle did not change state");
    expect(live?.secondAny === live?.originalAny, "second favorite toggle did not restore state");
    expect(live?.restored === true, "favorite folders were not restored exactly");
  }

  if (probeStateFailure) {
    const stateFailure = result.stateFailureTest;
    expect(stateFailure?.tested, "favorite-state failure probe did not run");
    expect(stateFailure?.before?.ready !== "1", "failed state request was marked confirmed");
    expect(stateFailure?.before?.pending === true, "failed state request did not remain pending");
    expect(stateFailure?.before?.visibility === "hidden", "unconfirmed detail button was visible");
    expect(stateFailure?.after?.ready === "1", "favorite state did not recover after retry");
    expect(stateFailure?.after?.pending === false, "pending state remained after successful retry");
    expect(stateFailure?.after?.visibility === "visible", "detail button did not restore after retry");
  }

  return failures;
}

async function main() {
  const target = await getJson(`${base}/json/new?about:blank`, {
    method: "PUT",
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const layoutMonitorSource = `
    globalThis.__qfavLayoutMonitor = {
      samples: 0,
      visibleSamples: 0,
      violations: [],
    };
    (() => {
      const sample = () => {
        const monitor = globalThis.__qfavLayoutMonitor;
        const host = document.querySelector("#qfav-overlay-host");
        const root = host?.shadowRoot;
        const layer = root?.querySelector(".qfav-layer");
        const button = root?.querySelector(".qfav-detail-btn");
        const player =
          document.querySelector("#bilibili-player") ||
          document.querySelector(".bpx-player-container") ||
          document.querySelector(".bilibili-player-video");
        monitor.samples += 1;
        if (button && player && layer) {
          const buttonRect = button.getBoundingClientRect();
          const playerRect = player.getBoundingClientRect();
          const anchorRect = button.qfavTarget?.getBoundingClientRect();
          const visible =
            getComputedStyle(button).visibility === "visible" &&
            getComputedStyle(layer).visibility === "visible" &&
            buttonRect.width > 0 &&
            buttonRect.height > 0;
          if (visible) {
            monitor.visibleSamples += 1;
            const overlaps = !(
              buttonRect.bottom <= playerRect.top ||
              buttonRect.top >= playerRect.bottom ||
              buttonRect.right <= playerRect.left ||
              buttonRect.left >= playerRect.right
            );
            const anchorBelow = Boolean(anchorRect) && anchorRect.top >= playerRect.bottom;
            if ((overlaps || !anchorBelow) && monitor.violations.length < 20) {
              monitor.violations.push({
                at: Math.round(performance.now()),
                overlaps,
                anchorBelow,
                button: {
                  left: Math.round(buttonRect.left), top: Math.round(buttonRect.top),
                  right: Math.round(buttonRect.right), bottom: Math.round(buttonRect.bottom),
                },
                player: {
                  left: Math.round(playerRect.left), top: Math.round(playerRect.top),
                  right: Math.round(playerRect.right), bottom: Math.round(playerRect.bottom),
                },
              });
            }
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })();
  `;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: layoutMonitorSource,
  });

  if (injectLocalScript) {
    const stateFailureShim = probeStateFailure
      ? `
        globalThis.__qfavFailFavoriteState = true;
        globalThis.__qfavNativeFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = (...args) => {
          const url = String(args[0]?.url || args[0] || "");
          if (globalThis.__qfavFailFavoriteState && url.includes("/x/v2/fav/video/favoured")) {
            return Promise.resolve(new Response("", { status: 503 }));
          }
          return globalThis.__qfavNativeFetch(...args);
        };
      `
      : "";
    const gmTestShim = `
      globalThis.__qfavTestValues = Object.create(null);
      globalThis.GM_getValue = (key, fallback) =>
        Object.prototype.hasOwnProperty.call(globalThis.__qfavTestValues, key)
          ? globalThis.__qfavTestValues[key]
          : fallback;
      globalThis.GM_setValue = (key, value) => {
        globalThis.__qfavTestValues[key] = value;
      };
    `;
    const source = `${stateFailureShim}\n${gmTestShim}\n${fs.readFileSync(userscriptPath, "utf8")}`;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  const navigationStartedAt = Date.now();
  await cdp.send("Page.navigate", { url: testUrl });
  const headerAt3Promise = (async () => {
    await wait(3000);
    return inspectHeader(cdp);
  })();

  let firstQuickFavMs = null;
  while (Date.now() - navigationStartedAt < 8000) {
    const probe = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `Boolean(document.querySelector("#qfav-overlay-host")?.shadowRoot
        ?.querySelector(".qfav-btn,.qfav-detail-btn"))`,
    });
    if (probe.result?.result?.value === true) {
      firstQuickFavMs = Date.now() - navigationStartedAt;
      break;
    }
    await wait(25);
  }

  const remainingWait = 8000 - (Date.now() - navigationStartedAt);
  if (remainingWait > 0) await wait(remainingWait);
  const headerAt3 = await headerAt3Promise;
  const headerAt8 = await inspectHeader(cdp);

  let coverHover = null;
  const coverProbe = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const root = document.querySelector("#qfav-overlay-host")?.shadowRoot;
      const button = [...(root?.querySelectorAll(".qfav-btn") || [])].find((candidate) => {
        const rect = candidate.qfavTarget?.getBoundingClientRect();
        if (!rect) return false;
        const x = rect.left + Math.min(24, rect.width / 2);
        const y = rect.top + Math.min(24, rect.height / 2);
        const pointElement = document.elementFromPoint(x, y);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
          rect.top < innerHeight && rect.left < innerWidth &&
          candidate.qfavTarget.contains(pointElement);
      });
      if (!button) return null;
      const rect = button.qfavTarget.getBoundingClientRect();
      const x = rect.left + Math.min(24, rect.width / 2);
      const y = rect.top + Math.min(24, rect.height / 2);
      const pointElement = document.elementFromPoint(x, y);
      return {
        x,
        y,
        opacity: getComputedStyle(button).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
        targetContainsButton: button.qfavTarget.contains(button),
        targetContainsPoint: button.qfavTarget.contains(pointElement),
        targetClass: button.qfavTarget.className || button.qfavTarget.tagName,
        pointClass: pointElement?.className || pointElement?.tagName || null,
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
        expression: `(() => {
          const root = document.querySelector("#qfav-overlay-host")?.shadowRoot;
          const button = root?.querySelector(".qfav-btn.qfav-visible");
          return button ? getComputedStyle(button).opacity : "0";
        })()`,
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
      targetContainsButton: coverBeforeHover.targetContainsButton,
      targetContainsPoint: coverBeforeHover.targetContainsPoint,
      targetClass: coverBeforeHover.targetClass,
      pointClass: coverBeforeHover.pointClass,
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

  let manualRateTest = { tested: false };

  let viewportLayoutTest = { tested: false };
  if (probeLayoutTimeline) {
    const sizes = [
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
      { width: 1440, height: 879 },
      { width: 1920, height: 936 },
    ];
    const entries = [];
    for (const size of sizes) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await wait(1400);
      const probe = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const root = document.querySelector("#qfav-overlay-host")?.shadowRoot;
          const button = root?.querySelector(".qfav-detail-btn");
          const player =
            document.querySelector("#bilibili-player") ||
            document.querySelector(".bpx-player-container");
          const anchor = button?.qfavTarget;
          if (!button || !player || !anchor) return null;
          const buttonRect = button.getBoundingClientRect();
          const playerRect = player.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const visible = getComputedStyle(button).visibility === "visible";
          const overlaps = !(
            buttonRect.bottom <= playerRect.top ||
            buttonRect.top >= playerRect.bottom ||
            buttonRect.right <= playerRect.left ||
            buttonRect.left >= playerRect.right
          );
          return {
            visible,
            overlaps,
            anchorBelow: anchorRect.top >= playerRect.bottom,
            detailCount: root.querySelectorAll(".qfav-detail-btn").length,
          };
        })()`,
      });
      entries.push({ ...size, state: probe.result?.result?.value || null });
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 879,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await wait(1400);
    viewportLayoutTest = { tested: true, entries };
  }

  let fullscreenTest = { tested: false };
  if (probeFullscreen) {
    const toggleWebFullscreen = () =>
      cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const control = document.querySelector(".bpx-player-ctrl-web");
          if (!control) return false;
          control.click();
          return true;
        })()`,
      });
    const readFullscreenState = async () => {
      const state = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const host = document.querySelector("#qfav-overlay-host");
          const layer = host?.shadowRoot?.querySelector(".qfav-layer");
          const player =
            document.querySelector("#bilibili-player") ||
            document.querySelector(".bpx-player-container");
          const rect = player?.getBoundingClientRect();
          const nativeSideNav = document.querySelector(".fixed-sidenav-storage");
          return {
            overlayVisibility: layer ? getComputedStyle(layer).visibility : null,
            overlayFullscreenState: host?.dataset.qfavPlayerFullscreen || null,
            nativeSideNavDisplay: nativeSideNav
              ? getComputedStyle(nativeSideNav).display
              : null,
            nativeSideNavVisibility: nativeSideNav
              ? getComputedStyle(nativeSideNav).visibility
              : null,
            fullscreenElement: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
            bodyClass: document.body.className,
            playerClass: player?.className || null,
            playerRect: rect ? {
              left: Math.round(rect.left), top: Math.round(rect.top),
              width: Math.round(rect.width), height: Math.round(rect.height),
            } : null,
            viewport: { width: innerWidth, height: innerHeight },
          };
        })()`,
      });
      return state.result?.result?.value || null;
    };
    const probeDirectFullscreenRule = async () => {
      const probe = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const host = document.querySelector("#qfav-overlay-host");
          const nativeSideNav = document.querySelector(".fixed-sidenav-storage");
          if (!host || !nativeSideNav) return null;
          const previous = host.dataset.qfavPlayerFullscreen;
          host.dataset.qfavPlayerFullscreen = "0";
          const result = {
            display: getComputedStyle(nativeSideNav).display,
            visibility: getComputedStyle(nativeSideNav).visibility,
          };
          host.dataset.qfavPlayerFullscreen = previous || "1";
          return result;
        })()`,
      });
      return probe.result?.result?.value || null;
    };

    const entered = await toggleWebFullscreen();
    if (entered.result?.result?.value) {
      await wait(700);
      const during = await readFullscreenState();
      const directRuleDuring = await probeDirectFullscreenRule();
      await toggleWebFullscreen();
      await wait(700);
      const nativeControl = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const control = document.querySelector(".bpx-player-ctrl-full");
          if (!control) return null;
          const rect = control.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
      });
      const nativePoint = nativeControl.result?.result?.value || null;
      let nativeDuring = null;
      let nativeAfter = null;
      if (nativePoint) {
        await clickAt(cdp, nativePoint);
        await wait(700);
        nativeDuring = await readFullscreenState();
        nativeDuring.directRule = await probeDirectFullscreenRule();
        await cdp.send("Runtime.evaluate", {
          expression: `document.exitFullscreen?.() || document.webkitExitFullscreen?.()`,
        });
        await wait(700);
        nativeAfter = await readFullscreenState();
      }
      fullscreenTest = {
        tested: true,
        during,
        directRuleDuring,
        after: await readFullscreenState(),
        nativeDuring,
        nativeAfter,
      };
    } else {
      fullscreenTest = { tested: false, error: "web fullscreen control missing" };
    }
  }

  if (probeManualRate) {
    const getRateControl = () =>
      cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const control =
            document.querySelector(".bpx-player-ctrl-playbackrate-result") ||
            document.querySelector(".bilibili-player-video-btn-speed-name") ||
            document.querySelector(".squirtle-speed-select-current");
          if (!control) return null;
          const rect = control.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
      });
    const getRateItem = (wantedRate) =>
      cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const items = [...document.querySelectorAll(
            ".bpx-player-ctrl-playbackrate-menu-item," +
            ".bilibili-player-video-btn-speed-menu-list-item," +
            "li.squirtle-select-item"
          )];
          const item = items.find((candidate) => {
            const value = parseFloat((candidate.dataset?.value || candidate.textContent || "").replace("x", ""));
            const rect = candidate.getBoundingClientRect();
            return Math.abs(value - ${wantedRate}) < 0.01 && rect.width > 0 && rect.height > 0;
          });
          if (!item) return null;
          const rect = item.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`,
      });
    const readRate = async () => {
      const result = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(
          document.querySelector(".bpx-player-video-wrap video") ||
          document.querySelector("#bilibili-player video") ||
          document.querySelector("video")
        )?.playbackRate || null`,
      });
      return result.result?.result?.value ?? null;
    };

    try {
      const controlResult = await getRateControl();
      const controlPoint = controlResult.result?.result?.value || null;
      if (!controlPoint) throw new Error("rate control missing");
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: controlPoint.x,
        y: controlPoint.y,
      });
      await wait(300);
      const targetResult = await getRateItem(2);
      const targetPoint = targetResult.result?.result?.value || null;
      if (!targetPoint) throw new Error("2x rate item missing");
      await clickAt(cdp, targetPoint);
      await wait(700);
      const afterManual = await readRate();
      await wait(1600);
      const retained = await readRate();

      const restoreControlResult = await getRateControl();
      const restoreControlPoint = restoreControlResult.result?.result?.value || controlPoint;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: restoreControlPoint.x,
        y: restoreControlPoint.y,
      });
      await wait(300);
      const restoreResult = await getRateItem(1.5);
      const restorePoint = restoreResult.result?.result?.value || null;
      if (!restorePoint) throw new Error("1.5x restore item missing");
      await clickAt(cdp, restorePoint);
      await wait(700);
      manualRateTest = {
        tested: true,
        afterManual,
        retained,
        restored: await readRate(),
        error: null,
      };
    } catch (error) {
      manualRateTest = { tested: false, error: String(error) };
    }
  }

  const queryNoiseProbe = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const host = document.querySelector("#qfav-overlay-host");
      const detail = host?.shadowRoot?.querySelector(".qfav-detail-btn") || null;
      window.__qfavNoiseProbe = { host, detail };
      const url = new URL(location.href);
      url.searchParams.set("vd_source", "qfav-regression");
      history.replaceState(history.state, "", url);
      return Boolean(host);
    })()`,
  });
  await wait(800);
  const queryNoiseResult = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const host = document.querySelector("#qfav-overlay-host");
      const detail = host?.shadowRoot?.querySelector(".qfav-detail-btn") || null;
      const header =
        document.querySelector("#biliMainHeader") ||
        document.querySelector("#bili-header-container") ||
        document.querySelector(".bili-header");
      return {
        tested: ${Boolean(queryNoiseProbe.result?.result?.value)},
        sameHost: host === window.__qfavNoiseProbe?.host,
        sameDetailButton: detail === window.__qfavNoiseProbe?.detail,
        headerTextLength: (header?.innerText || "").trim().length,
      };
    })()`,
  });

  let semanticRouteTest = { tested: false };
  if (probeSemanticRoute) {
    const routeSetup = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const host = document.querySelector("#qfav-overlay-host");
        const root = host?.shadowRoot;
        const detail = root?.querySelector(".qfav-detail-btn") || null;
        const originalBvid = location.pathname.match(/\\/video\\/(BV[\\w]+)/)?.[1] || null;
        const alternateBvid = originalBvid === "BV1XPuo6uES8" ? "BV1fxuE66ENC" : "BV1XPuo6uES8";
        const probe = {
          originalUrl: location.href,
          originalBvid,
          alternateBvid,
        };
        history.pushState(history.state, "", "/video/" + alternateBvid + "/?vd_source=qfav-semantic");
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        return host && detail && originalBvid ? probe : null;
      })()`,
    });
    const routeProbeInfo = routeSetup.result?.result?.value || null;
    await wait(2600);
    const routeChanged = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const host = document.querySelector("#qfav-overlay-host");
        const root = host?.shadowRoot;
        const detail = root?.querySelector(".qfav-detail-btn") || null;
        const coverButtons = [...(root?.querySelectorAll(".qfav-btn") || [])];
        return {
          detailBvid: detail?.dataset.qfavBvid || null,
          expectedBvid: ${JSON.stringify(routeProbeInfo?.alternateBvid || null)},
          detailCount: root?.querySelectorAll(".qfav-detail-btn").length || 0,
          duplicateTargetButtons:
            coverButtons.length - new Set(coverButtons.map((button) => button.qfavTarget)).size,
          headerTextLength: (document.querySelector("#biliMainHeader")?.innerText || "").trim().length,
        };
      })()`,
    });
    semanticRouteTest = {
      tested: Boolean(routeProbeInfo),
      changed: routeChanged.result?.result?.value || null,
    };
  }

  let liveFavoriteTest = { tested: false };
  if (toggleDetailFavorite) {
    const liveTestResult = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(
        async () => {
          const root = document.querySelector("#qfav-overlay-host")?.shadowRoot;
          const button = root?.querySelector(".qfav-detail-btn");
          const bvid = location.pathname.match(/\\/video\\/(BV[\\w]+)/)?.[1];
          if (!button || !bvid) {
            return { tested: false, error: "detail button or bvid missing" };
          }

          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const getJson = (url, options) =>
            fetch(url, { credentials: "include", ...options }).then((response) => response.json());
          const view = await getJson(
            "https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid),
          );
          const nav = await getJson("https://api.bilibili.com/x/web-interface/nav");
          const aid = view?.data?.aid;
          const uid = nav?.data?.mid;
          if (!aid || !uid) return { tested: false, error: "aid or uid missing" };

          const readState = async () => {
            const data = await getJson(
              "https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=" +
                uid + "&type=2&rid=" + aid,
            );
            const folders = data?.data?.list || [];
            return {
              folders,
              selected: folders
                .filter((folder) => Number(folder.fav_state) === 1)
                .map((folder) => String(folder.id))
                .sort(),
            };
          };
          const snapshot = await readState();
          if (snapshot.folders.length === 0) {
            return { tested: false, error: "no favorite folders" };
          }

          globalThis.__qfavTestValues.qfav_folder_id = snapshot.folders[0].id;
          globalThis.__qfavTestValues.qfav_folder_name = snapshot.folders[0].title || "test";
          const originalAny = snapshot.selected.length > 0;
          const visualState = () => ({
            active: button.classList.contains("qfav-active"),
            fill: button.querySelector("svg")?.getAttribute("fill") || null,
            loading: button.classList.contains("qfav-loading"),
          });
          const waitForAny = async (expected) => {
            for (let attempt = 0; attempt < 30; attempt++) {
              await sleep(250);
              const state = await readState();
              if ((state.selected.length > 0) === expected && !visualState().loading) {
                return { state, visual: visualState() };
              }
            }
            throw new Error("favorite state did not reach " + expected);
          };
          const postDeal = async (addIds, delIds) => {
            if (addIds.length === 0 && delIds.length === 0) return;
            const csrf = document.cookie.match(/(?:^|; )bili_jct=([^;]+)/)?.[1] || "";
            const body = new URLSearchParams({ rid: String(aid), type: "2", csrf });
            if (addIds.length > 0) body.set("add_media_ids", addIds.join(","));
            if (delIds.length > 0) body.set("del_media_ids", delIds.join(","));
            const result = await getJson(
              "https://api.bilibili.com/x/v3/fav/resource/deal",
              {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
              },
            );
            if (result?.code !== 0) throw new Error("restore failed: " + result?.message);
          };
          const sameIds = (left, right) =>
            left.length === right.length && left.every((value, index) => value === right[index]);

          let first = null;
          let second = null;
          let testError = null;
          try {
            button.click();
            first = await waitForAny(!originalAny);
            button.click();
            second = await waitForAny(originalAny);
          } catch (error) {
            testError = String(error);
          }

          let restored = false;
          let restoredState = null;
          try {
            const current = await readState();
            const originalSet = new Set(snapshot.selected);
            const currentSet = new Set(current.selected);
            const addIds = snapshot.selected.filter((id) => !currentSet.has(id));
            const delIds = current.selected.filter((id) => !originalSet.has(id));
            await postDeal(addIds, delIds);
            for (let attempt = 0; attempt < 20; attempt++) {
              restoredState = await readState();
              if (sameIds(restoredState.selected, snapshot.selected)) {
                restored = true;
                break;
              }
              await sleep(250);
            }
          } catch (error) {
            testError = testError || String(error);
          }

          return {
            tested: true,
            originalAny,
            originalSelectedCount: snapshot.selected.length,
            firstAny: first ? first.state.selected.length > 0 : null,
            firstVisual: first?.visual || null,
            secondAny: second ? second.state.selected.length > 0 : null,
            secondVisual: second?.visual || null,
            restored,
            restoredSelectedCount: restoredState?.selected.length ?? null,
            error: testError,
          };
        }
      )()`,
    });
    liveFavoriteTest = liveTestResult.result?.result?.value || {
      tested: false,
      error: "live test returned no value",
    };
  }

  let detailEdgeTest = { tested: false };
  if (probeDetailEdge) {
    const edgeResult = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const root = document.querySelector("#qfav-overlay-host")?.shadowRoot;
        const button = root?.querySelector(".qfav-detail-btn");
        const anchor = button?.qfavTarget;
        if (!button || !anchor) return { tested: false, error: "detail anchor missing" };
        const waitLayout = () => new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalStyle = anchor.getAttribute("style");
        const originalRect = anchor.getBoundingClientRect();
        const deltaY = innerHeight - 10 - originalRect.top;
        anchor.style.transform = "translateY(" + deltaY + "px)";
        window.dispatchEvent(new Event("resize"));
        await waitLayout();
        const shiftedRect = anchor.getBoundingClientRect();
        const shiftedVisibility = getComputedStyle(button).visibility;

        const player =
          document.querySelector("#bilibili-player") ||
          document.querySelector(".bpx-player-container");
        const playerRect = player?.getBoundingClientRect();
        let overlappingVisibility = null;
        let animatedVisibleOverlaps = 0;
        if (playerRect?.height > 80) {
          const overlapY = playerRect.top + Math.min(80, playerRect.height / 2);
          anchor.style.transition = "transform 300ms linear";
          anchor.style.transform = "translateY(" + (overlapY - originalRect.top) + "px)";
          window.dispatchEvent(new Event("resize"));
          for (let index = 0; index < 10; index++) {
            await sleep(50);
            const buttonRect = button.getBoundingClientRect();
            const currentPlayerRect = player.getBoundingClientRect();
            const overlaps = !(
              buttonRect.bottom <= currentPlayerRect.top ||
              buttonRect.top >= currentPlayerRect.bottom ||
              buttonRect.right <= currentPlayerRect.left ||
              buttonRect.left >= currentPlayerRect.right
            );
            if (getComputedStyle(button).visibility === "visible" && overlaps) {
              animatedVisibleOverlaps += 1;
            }
          }
          overlappingVisibility = getComputedStyle(button).visibility;
        }

        if (originalStyle === null) anchor.removeAttribute("style");
        else anchor.setAttribute("style", originalStyle);
        window.dispatchEvent(new Event("resize"));
        await sleep(1350);
        await waitLayout();
        return {
          tested: true,
          shiftedAnchorTop: Math.round(shiftedRect.top),
          shiftedAnchorBottom: Math.round(shiftedRect.bottom),
          viewportHeight: innerHeight,
          shiftedVisibility,
          overlappingVisibility,
          animatedVisibleOverlaps,
          restoredVisibility: getComputedStyle(button).visibility,
        };
      })()`,
    });
    detailEdgeTest = edgeResult.result?.result?.value || {
      tested: false,
      error: "detail edge test returned no value",
    };
  }

  let stateFailureTest = { tested: false };
  if (probeStateFailure) {
    const beforeResult = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const button = document.querySelector("#qfav-overlay-host")?.shadowRoot
          ?.querySelector(".qfav-detail-btn");
        if (!button) return null;
        return {
          ready: button.dataset.qfavStateReady || null,
          pending: button.classList.contains("qfav-state-pending"),
          visibility: getComputedStyle(button).visibility,
        };
      })()`,
    });
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        globalThis.__qfavFailFavoriteState = false;
        const button = document.querySelector("#qfav-overlay-host")?.shadowRoot
          ?.querySelector(".qfav-detail-btn");
        button?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
      })()`,
    });
    await wait(1600);
    const afterResult = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const button = document.querySelector("#qfav-overlay-host")?.shadowRoot
          ?.querySelector(".qfav-detail-btn");
        if (!button) return null;
        return {
          ready: button.dataset.qfavStateReady || null,
          pending: button.classList.contains("qfav-state-pending"),
          visibility: getComputedStyle(button).visibility,
        };
      })()`,
    });
    stateFailureTest = {
      tested: true,
      before: beforeResult.result?.result?.value || null,
      after: afterResult.result?.result?.value || null,
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

        const qfavHost = document.querySelector("#qfav-overlay-host");
        const qfavRoot = qfavHost?.shadowRoot || null;
        const detailButton = qfavRoot?.querySelector(".qfav-detail-btn") || null;
        const coverButtons = [...(qfavRoot?.querySelectorAll(".qfav-btn") || [])];
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
        const mainVideo =
          document.querySelector(".bpx-player-video-wrap video") ||
          document.querySelector("#bilibili-player video") ||
          document.querySelector("video");
        return {
          url: location.href,
          title: document.title,
          loggedIn: Boolean(nav?.data?.isLogin),
          quickFavButtons: qfavRoot?.querySelectorAll(".qfav-btn,.qfav-detail-btn").length || 0,
          coverQuickFavButtons: coverButtons.length,
          firstCoverBvid: coverButtons[0]?.dataset.qfavBvid || null,
          firstCoverActive: coverButtons[0]?.classList.contains("qfav-active") || false,
          duplicateTargetButtons:
            coverButtons.length - new Set(coverButtons.map((button) => button.qfavTarget)).size,
          nativeQuickFavButtons: document.querySelectorAll(".qfav-btn,.qfav-detail-btn").length,
          mutatedNativeCards: document.querySelectorAll(
            "[data-qfav-processed],[data-qfav-card],[data-qfav-bvid]",
          ).length,
          overlay: qfavHost
            ? {
                directBodyChild: qfavHost.parentElement === document.body,
                hasShadowRoot: Boolean(qfavRoot),
              }
            : null,
          firstQuickFavMs: ${firstQuickFavMs},
          headerTimeline: {
            at3s: ${JSON.stringify(headerAt3)},
            at8s: ${JSON.stringify(headerAt8)},
          },
          queryNoise: ${JSON.stringify(queryNoiseResult.result?.result?.value || null)},
          semanticRouteTest: ${JSON.stringify(semanticRouteTest)},
          liveFavoriteTest: ${JSON.stringify(liveFavoriteTest)},
          stateFailureTest: ${JSON.stringify(stateFailureTest)},
          detailEdgeTest: ${JSON.stringify(detailEdgeTest)},
          viewportLayoutTest: ${JSON.stringify(viewportLayoutTest)},
          layoutTimeline: globalThis.__qfavLayoutMonitor || null,
          coverHover: ${JSON.stringify(coverHover)},
          pageHeader: inspectVisibility(pageHeader),
          playerTop: inspectVisibility(playerTop),
          playerTopHover: ${JSON.stringify(playerTopHover)},
          fullscreenTest: ${JSON.stringify(fullscreenTest)},
          playbackRate: mainVideo?.playbackRate || null,
          manualRateTest: ${JSON.stringify(manualRateTest)},
          detailQuickFav: detailButton
            ? {
                active: detailButton.classList.contains("qfav-active"),
                ready: detailButton.dataset.qfavStateReady || null,
                fill: detailIcon?.getAttribute("fill") || null,
                stroke: detailIcon?.getAttribute("stroke") || null,
                visibility: getComputedStyle(detailButton).visibility,
                count: qfavRoot.querySelectorAll(".qfav-detail-btn").length,
              }
            : null,
        };
      }
    )()`,
  });

  const output = result.result.result.value;
  console.log(JSON.stringify(output, null, 2));

  if (screenshotPath) {
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, "base64"));
  }

  await cdp.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
  cdp.close();

  const failures = collectAssertionFailures(output);
  if (failures.length > 0) {
    throw new Error(`Regression assertions failed:\n- ${failures.join("\n- ")}`);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
