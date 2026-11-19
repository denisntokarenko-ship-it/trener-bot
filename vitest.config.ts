import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Лише тестові значення; справжні — wrangler secret (N7).
        bindings: {
          TEST_MIGRATIONS: migrations,
          TELEGRAM_BOT_TOKEN: "123:test-token",
          TELEGRAM_WEBHOOK_SECRET: "test-secret-0123456789",
          ALLOWED_TELEGRAM_IDS: "111, 222",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/apply-migrations.ts"] },
});
