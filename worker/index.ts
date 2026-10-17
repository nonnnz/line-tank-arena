import type { Env } from "./env";
import { handleApi } from "./api";
import { ARENA_ROOM } from "../src/shared/protocol";
export { GameRoom } from "./room";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/ws/")) {
      // One room only: unknown room ids never create a Durable Object (cost + abuse guard).
      if (url.pathname !== `/ws/${ARENA_ROOM}`) return new Response("unknown room", { status: 404 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      // Block other websites from opening sockets with visitors' browsers.
      const origin = req.headers.get("Origin");
      if (origin && !isAllowedOrigin(origin, env)) return new Response("forbidden origin", { status: 403 });
      return env.ROOM.get(env.ROOM.idFromName(ARENA_ROOM)).fetch(req);
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/webhook") return handleApi(req, env);
    return env.ASSETS.fetch(req);
  },
};

function isAllowedOrigin(origin: string, env: Env): boolean {
  try {
    const h = new URL(origin).hostname;
    return origin === env.PUBLIC_URL || h === "localhost" || h === "127.0.0.1";
  } catch { return false; }
}
