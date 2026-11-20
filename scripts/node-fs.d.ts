// @types/node у проєкті немає (типи — workers-types); скрипти сиду читають файли через node:fs — оголошуємо лише те, що вживаємо.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function writeFileSync(path: string | URL, data: string): void;
}
