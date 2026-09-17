import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://www.bilibili.com/",
        pretendToBeVisual: true,
      },
    },
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
  },
});
