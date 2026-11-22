// Нагадування за розкладом (docs/spec/phase-2.md, розділ 4). Порядок «заявити → надіслати → при визначеній недоставці зняти»:
// збій між кроками дає пропущене нагадування, а не подвійне. Тексти — лише з bot/texts.ts, дані — лише через repo.
import { generateWeeklyComment } from "./ai/weekly-comment";
import { prescribeSlot } from "./bot/prescribe";
import { trendKeyboard } from "./bot/trend-flow";
import { WEIGH_REMINDER, dayLabel, recordReps, recordWeight, trainReminderText, trendText, weeklyReportText, type TrainReminderLine, type WeeklyReportTextModel } from "./bot/texts";
import { REPORT_LOCAL_MINUTES, TELEGRAM_SEND_TIMEOUT_MS, TREND_MIN_DAYS, WEEKLY_COMMENT_TIMEOUT_MS } from "./config";
import type { ActiveProgram, ProgramDay, Repo } from "./db/repo";
import type { ReminderKind } from "./db/schema";
import { nextDayCode } from "./domain/progression";
import { formatPace, trendProposal, type Goal, type TrendProposal } from "./domain/nutrition";
import { dueReminders, parseTrainingDays } from "./domain/reminders";
import { addDays, localDate, localDayStartUtc, localTimeUtc } from "./domain/time";
import { buildWeeklyReport } from "./domain/week-report";
import { formatChange, formatKg } from "./domain/weight";

export interface Counters {
  sent: number;
  skipped: number;
  released: number;
  errors: number;
}

export interface ReminderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Ключ Claude для недільного коментаря; немає — звіт без коментаря. */
  anthropicApiKey?: string;
  /** fetch для SDK Anthropic (лише тести). */
  anthropicFetch?: typeof fetch;
  /** Дедлайн виклику коментаря (тести зменшують). */
  commentTimeoutMs?: number;
  /** Білий список Telegram ID (`ALLOWED_TELEGRAM_IDS`): крон лише по них. Не задано — без фільтра (прямі виклики в тестах); `runCron` передає завжди. */
  allowedIds?: ReadonlySet<string>;
}

// blocked — 403 (бот заблокований): заявку лишено, повтору в цей день немає; у лічильниках — «skipped», це не збій системи.
type Outcome = "sent" | "skipped" | "released" | "unknown" | "blocked";

type SendResult = { ok: true; messageId: number | null } | { ok: false; definite: boolean; status: number | null };

/**
 * sendMessage з AbortController. «Визначена» недоставка — Telegram відповів статусом 4xx (429 теж): запит відхилено, повідомлення
 * точно не пішло. 5xx (502/504 від проксі при вже прийнятому запиті), таймаут, обрив мережі, нерозбірне тіло — «невизначена»:
 * Telegram міг прийняти запит, тож повтор дав би дубль (Д2 рев'ю 2.3).
 * У лог не потрапляють ні токен (він в URL), ні текст.
 */
async function sendMessage(token: string, chatId: number, text: string, fetchFn: typeof fetch, timeoutMs: number, markup?: unknown): Promise<SendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) }),
      signal: controller.signal,
    });
    if (res.status >= 500) return { ok: false, definite: false, status: res.status };
    if (res.status >= 400) return { ok: false, definite: true, status: res.status };
    const body = (await res.json()) as { ok?: boolean; result?: { message_id?: unknown } };
    if (body.ok === false) return { ok: false, definite: true, status: res.status };
    const id = body.result?.message_id;
    return { ok: true, messageId: typeof id === "number" && Number.isSafeInteger(id) ? id : null };
  } catch {
    return { ok: false, definite: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

interface PairCtx {
  repo: Repo;
  token: string;
  now: number;
  fetchFn: typeof fetch;
  timeoutMs: number;
  apiKey: string | undefined;
  anthropicFetch: typeof fetch | undefined;
  commentTimeoutMs: number;
}

interface UserRow {
  id: number;
  tz: string;
  trainingDays: string;
}

/** Наступний день активної програми (останнє `done` активної програми → `nextDayCode` → день зі слотами); немає — null. */
async function nextProgramDay(repo: Repo, userId: number, program: ActiveProgram | null): Promise<ProgramDay | null> {
  if (!program || program.days.length === 0) return null;
  return repo.getProgramDay(userId, nextDayCode(await repo.getLastDoneWorkout(userId), program.days));
}

/** Текст нагадування про тренування; null — немає чого показати (програма зникла між перевіркою й побудовою). */
async function buildTrain(repo: Repo, userId: number, program: ActiveProgram | null): Promise<string | null> {
  const day = await nextProgramDay(repo, userId, program);
  if (!day) return null;
  const lines: TrainReminderLine[] = await Promise.all(
    day.slots.map(async (slot) => {
      const p = await prescribeSlot(repo, userId, slot.exercise, slot);
      return { nameUk: slot.exercise.nameUk, bodyweight: slot.exercise.equipment === "bodyweight", weightKg: p.weightKg, targetReps: p.targetReps, calibration: p.reason === "calibration" };
    }),
  );
  return trainReminderText({ dayLabel: dayLabel(day), lines });
}

/** Дані звіту (цифри — з коду): модель тексту без коментаря. */
async function reportModel(repo: Repo, user: UserRow, date: string, program: ActiveProgram | null): Promise<WeeklyReportTextModel> {
  // Межа тижня — момент звіту (Нд 19:00 локально), а не опівніч: звіт іде з першим тіком ≥ 19:00, тож тренування Нд після 19:00
  // не потрапляло б ні в цей звіт, ні в наступний (Д4 рев'ю 2.3). Тепер воно — перше в наступному: вікна змикаються без дір і дублів.
  const fromUtc = localTimeUtc(addDays(date, -7), REPORT_LOCAL_MINUTES, user.tz);
  const toUtc = localTimeUtc(date, REPORT_LOCAL_MINUTES, user.tz);
  const [stats, rows, weights, nextDay] = await Promise.all([
    repo.getWeekStats(user.id, fromUtc, toUtc),
    repo.getProgressSets(user.id),
    repo.getWeights(user.id, addDays(date, -13), date),
    nextProgramDay(repo, user.id, program),
  ]);
  const r = buildWeeklyReport({
    weekEnd: date,
    planned: parseTrainingDays(user.trainingDays)?.length ?? 0,
    stats,
    progressRows: rows,
    fromUtc,
    toUtc,
    weights,
    next: nextDay ? dayLabel(nextDay) : null,
  });
  return {
    weekStart: r.weekStart,
    weekEnd: r.weekEnd,
    workouts: r.workouts,
    planned: r.planned,
    sets: r.sets,
    volumeKg: r.volumeKg,
    records: r.records.map((x) => (x.bodyweight ? recordReps(x.nameUk, x.reps) : recordWeight(x.nameUk, x.weightKg, x.reps))),
    weight: r.weight ? { avg: formatKg(r.weight.avgDg), n: r.weight.n, change: r.weight.changeDg === null ? null : formatChange(r.weight.changeDg) } : null,
    next: r.next,
  };
}

/** Умови даних для kind (розклад уже перевірено): false — нагадування не потрібне й заявки не буде. `program` — активна програма, прочитана один раз на пару. */
async function wanted(repo: Repo, user: UserRow, kind: ReminderKind, date: string, program: ActiveProgram | null): Promise<boolean> {
  if (kind === "weigh") return (await repo.getWeights(user.id, date, date)).length === 0;
  if (kind === "train") {
    if (!program || program.days.length === 0) return false;
    return !(await repo.hasWorkoutBetween(user.id, localDayStartUtc(date, user.tz), localDayStartUtc(addDays(date, 1), user.tz)));
  }
  return repo.hasHistory(user.id); // report: без тренувань і ваги за весь час — мовчки
}

/**
 * Пропозиція корекції норми (спека Фази 3, розділ 4): є чинна норма й `formula`-норма, ціль у профілі, від її `valid_from` і від
 * останньої пропозиції минуло ≥ 14 днів, а вагові дані дають ±100 ккал. Інакше null — тихо, заявки не буде.
 */
async function trendFor(repo: Repo, user: UserRow, date: string): Promise<{ proposal: TrendProposal; oldKcal: number } | null> {
  const target = await repo.getTargetOn(user.id, date);
  if (!target) return null;
  const last = await repo.lastReminderDate(user.id, "trend");
  const base = last !== null && last > target.validFrom ? last : target.validFrom;
  if (date < addDays(base, TREND_MIN_DAYS)) return null;
  const [profile, formula, weights] = await Promise.all([repo.getProfile(user.id), repo.getFormulaTarget(user.id), repo.getWeights(user.id, addDays(date, -13), date)]);
  if (!profile?.goal || !formula) return null;
  const proposal = trendProposal({ weights, goal: profile.goal as Goal, today: date, kcal: target.kcal, carbsG: target.carbsG, formulaKcal: formula.kcal });
  return proposal ? { proposal, oldKcal: target.kcal } : null;
}

async function processPair(c: PairCtx, user: UserRow, kind: ReminderKind, date: string): Promise<Outcome> {
  if (await c.repo.hasReminder(user.id, kind, date)) return "skipped";
  let trend: Awaited<ReturnType<typeof trendFor>> = null;
  if (kind === "trend") {
    trend = await trendFor(c.repo, user, date);
    if (!trend) return "skipped";
  }
  const program = kind === "weigh" || kind === "trend" ? null : await c.repo.getActiveProgram(user.id);
  if (kind !== "trend" && !(await wanted(c.repo, user, kind, date, program))) return "skipped";
  // Недільний звіт: дані й коментар ШІ — ДО заявки, після `wanted` (спека 4.3): виклик не подовжує вікно «заявлено, ще не надіслано».
  // Коментар ніколи не кидає й не блокує звіт: будь-яка відмова → звіт без коментаря. Коли заявку перехопив інший тік, виклик марний (≈ $0,003) — прийнято.
  let report: WeeklyReportTextModel | null = null;
  if (kind === "report") {
    report = await reportModel(c.repo, user, date, program);
    const comment = await generateWeeklyComment({ repo: c.repo, apiKey: c.apiKey, anthropicFetch: c.anthropicFetch, timeoutMs: c.commentTimeoutMs, now: c.now }, user.id, date, report, weeklyReportText(report));
    report = { ...report, comment };
  }
  // 1. Заявка: 0 рядків — інший тік уже взяв.
  if (!(await c.repo.claimReminder(user.id, kind, date, c.now))) return "skipped";
  let text: string | null;
  try {
    text =
      kind === "weigh"
        ? WEIGH_REMINDER
        : kind === "train"
          ? await buildTrain(c.repo, user.id, program)
          : kind === "trend"
            ? trendText({ from: formatKg(trend!.proposal.avg1Dg), to: formatKg(trend!.proposal.avg0Dg), pace: formatPace(trend!.proposal.paceCenti), delta: trend!.proposal.delta, oldKcal: trend!.oldKcal, newKcal: trend!.proposal.newKcal, carbsDeltaG: trend!.proposal.carbsDeltaG })
            : weeklyReportText(report!);
  } catch (e) {
    await c.repo.releaseReminder(user.id, kind, date); // до відправки — недоставка визначена
    throw e;
  }
  if (text === null) {
    await c.repo.releaseReminder(user.id, kind, date);
    return "skipped";
  }
  // 2. Відправка (chat_id приватного чату = Telegram ID користувача).
  const res = await sendMessage(c.token, user.id, text, c.fetchFn, c.timeoutMs, trend ? trendKeyboard(trend.proposal.delta, date) : undefined);
  if (res.ok) {
    if (res.messageId !== null) await c.repo.setReminderMessageId(user.id, kind, date, res.messageId);
    return "sent";
  }
  // 3. 403 — бот заблокований: детермінована відмова, повтор у вікні (до 4 тіків, для звіту — до кінця доби) безглуздий. Заявку лишаємо:
  // день пропущено, рядок у reminders_sent — позначка. Наступної доби спроба буде знову (людина могла розблокувати бота).
  if (res.status === 403) {
    console.warn("reminder not delivered, bot blocked, claim kept", { kind, status: res.status });
    return "blocked";
  }
  // Інша визначена недоставка (4xx) — зняти заявку (наступний тік у вікні повторить); невизначена — лишити, повтору не буде.
  if (res.definite) {
    await c.repo.releaseReminder(user.id, kind, date);
    console.warn("reminder not delivered", { kind, status: res.status });
    return "released";
  }
  console.warn("reminder outcome unknown, claim kept", { kind });
  return "unknown";
}

/** Один тік: для кожного користувача — належні нагадування; пари (користувач, kind) незалежні, помилка однієї не блокує інших. */
export async function runReminders(repo: Repo, token: string | undefined, now: number, opts: ReminderOptions = {}): Promise<Counters> {
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const ctx: PairCtx = {
    repo,
    token,
    now,
    fetchFn: opts.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs: opts.timeoutMs ?? TELEGRAM_SEND_TIMEOUT_MS,
    apiKey: opts.anthropicApiKey,
    anthropicFetch: opts.anthropicFetch,
    commentTimeoutMs: opts.commentTimeoutMs ?? WEEKLY_COMMENT_TIMEOUT_MS,
  };
  const counters: Counters = { sent: 0, skipped: 0, released: 0, errors: 0 };
  const tasks: Promise<Outcome>[] = [];
  for (const user of await repo.getReminderUsers()) {
    // Д7 рев'ю 2.3: прибрали з allow-list — вебхук мовчить, тож і крон не пише (інакше нагадування йшли б «привиду»).
    if (opts.allowedIds && !opts.allowedIds.has(String(user.id))) continue;
    let kinds: ReminderKind[];
    let date: string;
    try {
      kinds = dueReminders(user, now);
      date = localDate(now, user.tz);
    } catch (e) {
      counters.errors++; // некоректний tz: інші користувачі не страждають
      console.error("reminder schedule failed", { error: errorName(e) });
      continue;
    }
    for (const kind of kinds) tasks.push(processPair(ctx, user, kind, date));
  }
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status === "rejected") {
      counters.errors++;
      console.error("reminder failed", { error: errorName(r.reason) });
    } else if (r.value === "unknown") counters.errors++;
    else if (r.value === "blocked") counters.skipped++;
    else counters[r.value]++;
  }
  return counters;
}
