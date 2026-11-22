// Борг [R-0] Д4: шлях вебхука й ліміт імені — по одному джерелу (`src/constants.ts`).
// «Одне джерело» поведінкою не довести (значення збігаються й зі старим кодом), тож тест читає сирий текст файлів.
import { describe, expect, it } from "vitest";
import appSrc from "../src/app.ts?raw";
import constantsSrc from "../src/constants.ts?raw";
import repoSrc from "../src/db/repo.ts?raw";
import schemaSrc from "../src/db/schema.ts?raw";
import usersMigration from "../migrations/0000_users_processed_updates.sql?raw";
import setWebhookSrc from "../scripts/set-webhook-core.ts?raw";
import { FIRST_NAME_MAX, WEBHOOK_PATH } from "../src/constants";
import { WEBHOOK_PATH as appPath } from "../src/app";

describe("[R-0] Д4: одне джерело для шляху вебхука й ліміту імені", () => {
  it("літерал шляху вебхука є лише в constants.ts; app.ts і скрипт беруть константу", () => {
    expect(constantsSrc).toContain(`"${WEBHOOK_PATH}"`);
    expect(appSrc).not.toContain("/tg/webhook");
    expect(setWebhookSrc).not.toContain("/tg/webhook");
    expect(appSrc).toMatch(/import \{ WEBHOOK_PATH \} from "\.\/constants"/);
    expect(setWebhookSrc).toMatch(/import \{ WEBHOOK_PATH \} from "\.\.\/src\/constants\.ts"/);
    expect(appPath).toBe(WEBHOOK_PATH);
  });

  it("літерал 64 для імені є лише в constants.ts; repo.ts і schema.ts беруть FIRST_NAME_MAX", () => {
    expect(constantsSrc).toMatch(/FIRST_NAME_MAX = 64;/);
    expect(repoSrc).not.toMatch(/FIRST_NAME_MAX\s*=/);
    expect(repoSrc).toContain("FIRST_NAME_MAX");
    expect(schemaSrc).not.toMatch(/first_?[nN]ame[^\n]*\b64\b/);
    expect(schemaSrc).toContain("FIRST_NAME_MAX");
  });

  it("CHECK у міграції 0000 і константа збігаються (інакше схема й код розійдуться мовчки)", () => {
    expect(usersMigration).toContain(`CHECK(length("users"."first_name") <= ${FIRST_NAME_MAX})`);
  });
});
