// Команди поточного релізу — для привітання, по одній на рядок.
export const COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "/start", description: "привітання й список команд" },
];

export function greeting(firstName: string): string {
  const list = COMMANDS.map((c) => `${c.command} — ${c.description}`).join("\n");
  return `Привіт, ${firstName}! Я записую твої тренування.\n${list}`;
}

export const SOMETHING_WRONG = "Щось пішло не так, спробуй ще раз";
