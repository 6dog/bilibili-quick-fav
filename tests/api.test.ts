import { afterEach, describe, expect, it, vi } from "vitest";
import { BiliApi, BiliApiError, favoriteMutationBody } from "../src/content/api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("favoriteMutationBody", () => {
  it("adds only the selected quick folder", () => {
    const body = favoriteMutationBody(100, "200", true, "csrf");
    expect(body.get("add_media_ids")).toBe("200");
    expect(body.has("del_media_ids")).toBe(false);
  });

  it("removes only the selected quick folder", () => {
    const body = favoriteMutationBody(100, "200", false, "csrf");
    expect(body.get("del_media_ids")).toBe("200");
    expect(body.has("add_media_ids")).toBe(false);
  });

  it("times out a stalled request without retrying it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = new BiliApi().getViewerMid();
    const rejection = expect(result).rejects.toMatchObject({ kind: "transport" });
    await vi.advanceTimersByTimeAsync(8_001);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
