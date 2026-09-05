#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

const port = process.env.QFAV_BROWSER_PORT || "9333";
const extensionPath = path.resolve(process.env.QFAV_EXTENSION_DIR || "dist/extension");
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => {
  if (!response.ok) throw new Error(`DevTools endpoint returned HTTP ${response.status}`);
  return response.json();
});

const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = () => reject(new Error("Cannot connect to browser DevTools endpoint"));
});

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Extensions.loadUnpacked timed out")), 15_000);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  socket.send(JSON.stringify({
    id: 1,
    method: "Extensions.loadUnpacked",
    params: { path: extensionPath },
  }));
});

socket.close();
if (!result?.id) throw new Error("Chrome did not return an extension id");
console.log(JSON.stringify({ ok: true, version: "2.0.1", loaded: true }));
