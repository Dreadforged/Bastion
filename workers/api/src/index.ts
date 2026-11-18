import { Id } from "@bastion/shared";

// Durable Object classes must be exported from the Worker entry.
export { Conversation, Server, UserSession } from "@bastion/durable";

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  FILES: R2Bucket;
  USER_SESSION: DurableObjectNamespace;
  SERVER: DurableObjectNamespace;
  CONVERSATION: DurableObjectNamespace;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT });
    }

    // GET /conversations/:id/socket upgrades into the Conversation object.
    const match = url.pathname.match(/^\/conversations\/([^/]+)\/socket$/);
    if (match) {
      const parsed = Id.safeParse(match[1]);
      if (!parsed.success) return json({ error: "invalid id" }, 400);
      // TODO: authenticate and check VIEW_CHANNEL before upgrading.
      const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(parsed.data));
      return stub.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
