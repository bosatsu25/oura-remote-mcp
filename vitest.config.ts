import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLIC_BASE_URL: "https://example.workers.dev",
          ALLOWED_GITHUB_USER_ID: "123456",
          ALLOWED_GITHUB_LOGIN: "bosatsu25",
          KILL_SWITCH: "0",
          GITHUB_CLIENT_ID: "gh-id",
          GITHUB_CLIENT_SECRET: "gh-secret",
          OURA_CLIENT_ID: "oura-id",
          OURA_CLIENT_SECRET: "oura-secret",
          // 32 bytes of 0x01, base64 — test only
          TOKEN_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        },
      },
    }),
  ],
  test: {
    include: ["test/workers/**/*.test.ts"],
  },
});
