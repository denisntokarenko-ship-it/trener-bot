import { handleRequest, telegramHandler } from "./app";
import { runCron } from "./cron";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, telegramHandler(env));
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runCron(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
