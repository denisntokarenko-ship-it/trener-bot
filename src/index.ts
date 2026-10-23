import { handleRequest, telegramHandler } from "./app";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, telegramHandler(env));
  },

  async scheduled(): Promise<void> {
    // no-op: крон фази 1 (прибирання processed_updates).
  },
} satisfies ExportedHandler<Env>;
