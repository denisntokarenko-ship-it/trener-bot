export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(): Promise<void> {
    // no-op: крон фази 1 (прибирання processed_updates).
  },
} satisfies ExportedHandler;
