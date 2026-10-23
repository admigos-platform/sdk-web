import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    isolate: true,
    bail: process.env.CI ? 1 : 0,
  },
});
