#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const port = process.env.QFAV_BROWSER_PORT || "9333";
const base = `http://127.0.0.1:${port}`;
const injectLocalScript = process.argv.includes("--inject-local-script");
const repoRoot = path.resolve(__dirname, "..");
const userscriptPath = path.join(repoRoot, "bilibili-quick-fav.user.js");

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

  await cdp.send("Page.navigate", { url: "https://t.bilibili.com/" });
  await wait(8000);

  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(
      async () => {
        const nav = await fetch("https://api.bilibili.com/x/web-interface/nav", {
          credentials: "include",
        }).then((r) => r.json()).catch((error) => ({ code: -1, error: String(error) }));

        return {
          url: location.href,
          title: document.title,
          loggedIn: Boolean(nav?.data?.isLogin),
          mid: nav?.data?.mid || null,
          quickFavButtons: document.querySelectorAll(".qfav-btn,.qfav-detail-btn").length,
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

  await cdp.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
  cdp.close();
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
