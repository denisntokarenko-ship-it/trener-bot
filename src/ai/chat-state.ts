// Стан пропозицій для моделі й запобіжник «обіцянка кнопки без пропозиції» (рев'ю preview 4.2, Д-А і Д-Б).
// Джерело істини — рядки `ai_proposals`, не слова моделі: рішення кнопкою мусять потрапляти в контекст наступного ходу, а текст про
// підтвердження без створеної пропозиції код доповнює чесною приміткою.
import type { ProposalView } from "../db/repo";
import { proposalSummary } from "./proposals";

/** Стан для рядка на початку повідомлення користувача: відкриті пропозиції й рішення кнопкою за вікно історії. */
export function chatStateLine(items: readonly ProposalView[]): string {
  const open = items.filter((p) => p.status === "pending").map((p) => `#${p.id} «${proposalSummary(p.kind, p.payload)}» — чекає кнопки`);
  const decided = items
    .filter((p) => p.status === "accepted" || p.status === "rejected")
    .map((p) => `#${p.id} «${proposalSummary(p.kind, p.payload)}» — ${p.status === "accepted" ? "прийнято кнопкою й застосовано" : "відхилено кнопкою"}`);
  return `Стан пропозицій (з бази, надійніший за твої попередні відповіді): відкриті — ${open.join("; ") || "немає"}; рішення за останні години — ${decided.join("; ") || "немає"}.`;
}

/** Текст обіцяє підтвердження кнопкою («чекає підтвердження», «підтверди кнопкою»). */
const PROMISES_BUTTON = /(?:підтверд\p{L}*[^.\n]{0,60}кнопк|кнопк\p{L}*[^.\n]{0,60}підтверд|чека\p{L}*[^.\n]{0,40}підтверд)/iu;
export const promisesConfirmation = (text: string): boolean => PROMISES_BUTTON.test(text);
