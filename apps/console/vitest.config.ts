import { defineConfig } from "vitest/config";

// 单元测试只覆盖 app/lib 下的纯逻辑（e2e 走 Playwright，目录为 tests/）。
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
