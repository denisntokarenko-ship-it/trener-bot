import { handleRequest, telegramHandler } from "./app";
import { runCron } from "./cron";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // N2: робота ШІ (фото їжі) — у ctx.waitUntil, вебхук відповідає 200 одразу.
    return handleRequest(request, env, telegramHandler(env, { waitUntil: (p) => ctx.waitUntil(p) }));
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runCron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
