// Команди поточного релізу — для привітання, по одній на рядок.
export const COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "/start", description: "Почати" },
  { command: "/trening", description: "Тренування: почати або продовжити" },
  { command: "/progres", description: "Останні тренування" },
  { command: "/prohrama", description: "Програма й наступне тренування" },
];

export function greeting(firstName: string): string {
  const list = COMMANDS.map((c) => `${c.command} — ${c.description}`).join("\n");
  return `Привіт, ${firstName}! Я записую твої тренування.\n${list}`;
}

export const SOMETHING_WRONG = "Щось пішло не так, спробуй ще раз";

/** Екранування користувацьких рядків для parse_mode HTML (нотатки, імʼя, назви). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Групи мʼязів у підказці складу дня (назва дня + «(ноги, груди, спина)»). Ключі = exercises.muscle_group. */
export const MUSCLE_UK: Record<string, string> = {
  legs: "ноги",
  chest: "груди",
  back: "спина",
  shoulders: "плечі",
  core: "кора",
};

export const NEXT_WORKOUT = "Наступне тренування";
