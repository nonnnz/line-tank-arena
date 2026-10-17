import type { Env } from "./env";
import { issueSession } from "./auth";
import { publicRooms, topPlayers, upsertPlayer } from "./db";
import { handleWebhook } from "./line-bot";
import { ARENA_ROOM } from "../src/shared/protocol";
import { sendMatchResult } from "./service-message";

// Workers global cache (DOM lib types lack `default`).
const edgeCache = () => (caches as unknown as { default: Cache }).default;
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };
const json = (data: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": cache, ...SECURITY_HEADERS } });

export function newRoomId(): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => A[b % 36]).join("");
}

/** Open the MINI App (permanent link) when LIFF_ID is known, else the public web URL. */
export function appLink(env: Env, query: string): string {
  return env.LIFF_ID ? `https://miniapp.line.me/${env.LIFF_ID}?${query}` : `${env.PUBLIC_URL}/?${query}`;
}

export async function handleApi(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const route = `${req.method} ${pathname}`;
  try {
    switch (route) {
      case "POST /webhook": return handleWebhook(req, env);
      case "POST /api/service-message": return sendMatchResult(req, env);
      case "GET /api/config": return json({ liffId: env.LIFF_ID || null, turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
      case "POST /api/guest": {
        // Guests must pass Cloudflare Turnstile; the server picks their name (no user-supplied text).
        const { turnstileToken } = (await req.json().catch(() => ({}))) as { turnstileToken?: unknown };
        if (typeof turnstileToken !== "string" || !turnstileToken || turnstileToken.length > 2048) return json({ error: "turnstileToken required" }, 400);
        const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: turnstileToken, remoteip: req.headers.get("CF-Connecting-IP") ?? "" }),
        });
        const r = (await v.json()) as { success?: boolean; hostname?: string };
        const testKeys = env.TURNSTILE_SECRET.startsWith("1x0000"); // Cloudflare dummy keys (local dev) report a fake hostname
        const okHost = testKeys || r.hostname === new URL(env.PUBLIC_URL).hostname || r.hostname === "localhost";
        if (!r.success || !okHost) return json({ error: "verification failed" }, 403);
        const name = randomGuestName();
        return json({ session: await issueSession(env, { id: "g_" + crypto.randomUUID().slice(0, 12), name, guest: true }), name });
      }
      case "GET /api/leaderboard": {
        // Edge-cache 30s so request floods don't each hit D1.
        const key = new Request(new URL("/api/leaderboard", req.url).toString());
        const hit = await edgeCache().match(key);
        if (hit) return hit;
        const res = json(await topPlayers(env, 20), 200, "public, max-age=30");
        await edgeCache().put(key, res.clone());
        return res;
      }
      case "GET /api/rooms": return json(await publicRooms(env));
      case "POST /api/rooms/quick": {
        return json({ roomId: ARENA_ROOM }); // single public arena
      }
      case "POST /api/session": {
        const { idToken, accessToken } = (await req.json().catch(() => ({}))) as { idToken?: unknown; accessToken?: unknown };
        let v: { sub?: string; name?: string; picture?: string };
        if (typeof idToken === "string" && idToken) {
          // Same checks as line-integration-poc/worker/auth.ts
          const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ id_token: idToken, client_id: env.MINI_APP_CHANNEL_ID }),
          });
          if (!r.ok) return json({ error: "invalid id token" }, 401);
          const t = (await r.json()) as { iss?: string; aud?: string; exp?: number; sub?: string; name?: string; picture?: string };
          if (t.iss !== "https://access.line.me" || t.aud !== env.MINI_APP_CHANNEL_ID || typeof t.sub !== "string" || !t.exp || t.exp <= Date.now() / 1000)
            return json({ error: "invalid id token claims" }, 401);
          v = t;
        } else if (typeof accessToken === "string" && accessToken) {
          // Fallback when openid isn't granted: verify access token belongs to our channel, then read profile.
          const r = await fetch("https://api.line.me/oauth2/v2.1/verify?access_token=" + encodeURIComponent(accessToken));
          if (!r.ok) return json({ error: "invalid access token" }, 401);
          const t = (await r.json()) as { client_id?: string; expires_in?: number; scope?: string };
          if (t.client_id !== env.MINI_APP_CHANNEL_ID || !(Number(t.expires_in) > 0) || !t.scope?.split(" ").includes("profile"))
            return json({ error: "invalid access token claims" }, 401);
          const p = await fetch("https://api.line.me/v2/profile", { headers: { authorization: `Bearer ${accessToken}` } });
          if (!p.ok) return json({ error: "profile fetch failed" }, 401);
          const prof = (await p.json()) as { userId?: string; displayName?: string; pictureUrl?: string };
          if (typeof prof.userId !== "string") return json({ error: "invalid profile" }, 401);
          v = { sub: prof.userId, name: prof.displayName, picture: prof.pictureUrl };
        } else return json({ error: "idToken or accessToken required" }, 400);
        if (!v.sub) return json({ error: "invalid token" }, 401);
        const name = (v.name || "Player").slice(0, 24);
        await upsertPlayer(env, v.sub, name, v.picture);
        return json({ session: await issueSession(env, { id: v.sub, name, avatar: v.picture }), name, avatar: v.picture ?? null });
      }
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("api error", route, (e as Error).message);
    return json({ error: "internal error" }, 500);
  }
}

const ADJ = ["Swift", "Brave", "Mighty", "Turbo", "Lucky", "Fuzzy", "Rocket", "Sunny", "Pixel", "Ninja", "Bouncy", "Spicy"];
const NOUN = ["Tank", "Panda", "Tiger", "Comet", "Mochi", "Falcon", "Otter", "Dragon", "Bean", "Koala", "Blaster", "Gecko"];
export function randomGuestName(): string {
  const r = crypto.getRandomValues(new Uint8Array(3));
  return `${ADJ[r[0] % ADJ.length]}${NOUN[r[1] % NOUN.length]}${10 + (r[2] % 90)}`;
}
