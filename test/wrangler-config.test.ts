import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

// JSONC → JSON: у конфігу лише повнорядкові коментарі `//`, рядки з `//` усередині не чіпаємо.
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
  account_id?: unknown;
  env?: Record<string, { account_id?: unknown }>;
};

// В1 рев'ю Фази 0: без account_id wrangler при двох акаунтах падає в неінтерактивному запуску
// (backup:prod, db:migrate:*, deploy:*), а здогадка першим зі списку б'є не в ту БД.
describe("wrangler.jsonc", () => {
  it("account_id на верхньому рівні — 32 hex", () => {
    expect(config.account_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("env.* не перевизначає account_id іншим акаунтом", () => {
    for (const [name, block] of Object.entries(config.env ?? {})) {
      expect(block.account_id ?? config.account_id, `env.${name}`).toBe(config.account_id);
    }
  });
});

// Рев'ю 2.5, В1: `/health` показує id версії з binding `CF_VERSION_METADATA`; env-блоки bindings не успадковують — потрібен у кожному.
describe("wrangler.jsonc: version_metadata", () => {
  const withMeta = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as { version_metadata?: { binding?: string }; env?: Record<string, { version_metadata?: { binding?: string } }> };
  it("binding CF_VERSION_METADATA — на верхньому рівні й у кожному env", () => {
    expect(withMeta.version_metadata?.binding).toBe("CF_VERSION_METADATA");
    expect(Object.keys(withMeta.env ?? {}).sort()).toEqual(["preview", "production"]);
    for (const [name, block] of Object.entries(withMeta.env ?? {})) expect(block.version_metadata?.binding, `env.${name}`).toBe("CF_VERSION_METADATA");
  });
});
