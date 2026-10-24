import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": root } },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["lib/**/*.test.{ts,tsx}", "components/**/*.test.{ts,tsx}", "app/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        resolve: { alias: { "server-only": fileURLToPath(new URL("./tests/server-only-stub.ts", import.meta.url)) } },
        test: {
          name: "server",
          environment: "node",
          include: ["server/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
          setupFiles: ["./tests/server-setup.ts"],
          globalSetup: ["./tests/global-setup.ts"],
          // Integration tests share one database: run files one after another.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
