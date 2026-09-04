import { beforeEach, describe, expect, it } from "vitest";
import { extractBvid, findVideoCoverSurface } from "../src/content/covers";

function rect(width: number, height: number): DOMRect {
  return { x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, width, height, toJSON: () => ({}) };
}

describe("cover discovery", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("selects the largest real media surface instead of a tiny icon", () => {
    const link = document.createElement("a");
    link.href = "https://www.bilibili.com/video/BV1abc123/";
    const wrapper = document.createElement("span");
    const icon = document.createElement("img");
    const cover = document.createElement("img");
    icon.getBoundingClientRect = () => rect(16, 16);
    cover.getBoundingClientRect = () => rect(320, 180);
    wrapper.getBoundingClientRect = () => rect(320, 180);
    wrapper.append(icon, cover);
    link.appendChild(wrapper);
    document.body.appendChild(link);
    expect(extractBvid(link)).toBe("BV1abc123");
    expect(findVideoCoverSurface(link)).toBe(wrapper);
  });

  it("does not bind title-only links or header links", () => {
    const title = document.createElement("a");
    title.href = "https://www.bilibili.com/video/BV1abc123/";
    title.textContent = "title";
    document.body.appendChild(title);
    expect(findVideoCoverSurface(title)).toBeNull();

    const header = document.createElement("header");
    const link = document.createElement("a");
    link.href = title.href;
    const image = document.createElement("img");
    image.getBoundingClientRect = () => rect(320, 180);
    link.appendChild(image);
    header.appendChild(link);
    document.body.appendChild(header);
    expect(findVideoCoverSurface(link)).toBeNull();
  });
});
