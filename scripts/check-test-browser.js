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

async function main() {
  const target = await getJson(`${base}/json/new?about:blank`, {
    method: "PUT",
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  if (injectLocalScript) {
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
    const source = `${gmTestShim}\n${fs.readFileSync(userscriptPath, "utf8")}`;
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
          mid: nav?.data?.mid || null,
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
          coverHover: ${JSON.stringify(coverHover)},
          pageHeader: inspectVisibility(pageHeader),
          playerTop: inspectVisibility(playerTop),
          playerTopHover: ${JSON.stringify(playerTopHover)},
          playbackRate: mainVideo?.playbackRate || null,
          manualRateTest: ${JSON.stringify(manualRateTest)},
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
