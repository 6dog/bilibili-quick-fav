import { afterEach, describe, expect, it, vi } from "vitest";
import { desiredRate, parseRate, PlaybackController, type PlaybackSession } from "../src/content/playback";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
});

describe("playback session", () => {
  it("defaults to 1.5 and preserves a manual rate for the semantic video", () => {
    const session: PlaybackSession = { routeKey: "video-a", manualRate: null, internalUntil: 0, resetUntil: 0 };
    expect(desiredRate(session)).toBe(1.5);
    session.manualRate = 2;
    expect(desiredRate(session)).toBe(2);
  });

  it("parses Bilibili speed labels", () => {
    expect(parseRate("2.0x")).toBe(2);
    expect(parseRate("1.5 倍")).toBe(1.5);
    expect(parseRate("自动")).toBeNull();
  });

  it("applies 1.5 when the setting is enabled after page load", async () => {
    vi.useFakeTimers();
    history.replaceState({}, "", "/video/BV1abc123/");
    const wrap = document.createElement("div");
    wrap.className = "bpx-player-video-wrap";
    const video = document.createElement("video");
    video.getClientRects = () => ({ 0: video.getBoundingClientRect(), length: 1, item: () => video.getBoundingClientRect(), [Symbol.iterator]: function* () { yield this[0]; } }) as DOMRectList;
    wrap.appendChild(video);
    document.body.appendChild(wrap);
    const controller = new PlaybackController();
    controller.start(false);
    expect(video.playbackRate).toBe(1);
    controller.setEnabled(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(video.playbackRate).toBe(1.5);
    controller.destroy();
  });
});
