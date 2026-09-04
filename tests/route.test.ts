import { describe, expect, it } from "vitest";
import { isSupportedPlaybackPage, routeBvid, semanticRouteKey } from "../src/content/route";

describe("route helpers", () => {
  it("ignores tracking noise but keeps semantic video parameters", () => {
    const first = new URL("https://www.bilibili.com/video/BV1abc/?p=2&vd_source=noise");
    const second = new URL("https://www.bilibili.com/video/BV1abc/?p=2&spm_id_from=other");
    expect(semanticRouteKey(first)).toBe(semanticRouteKey(second));
    expect(semanticRouteKey(new URL("https://www.bilibili.com/video/BV1abc/?p=3"))).not.toBe(semanticRouteKey(first));
  });

  it("recognizes supported playback pages and BVID", () => {
    const video = new URL("https://www.bilibili.com/video/BV1abc123/");
    expect(isSupportedPlaybackPage(video)).toBe(true);
    expect(routeBvid(video)).toBe("BV1abc123");
    expect(isSupportedPlaybackPage(new URL("https://www.bilibili.com/"))).toBe(false);
  });
});
