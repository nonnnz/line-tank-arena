// LINE MINI App Service Message: confirm a player's own match result, sent only when they tap the button.
// Docs: docs/line-mini-app-service-messages.md
import type { Env } from "./env";
import { verifySession } from "./auth";
import { appLink } from "./api";

const TEMPLATE = "completion_d_en"; // Console: Usage_Completed (English), API name

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Stateless channel access token for the MINI App channel (LINE recommends these for MINI Apps). */
async function miniAppToken(env: Env): Promise<string> {
  const r = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.MINI_APP_CHANNEL_ID, client_secret: env.MINI_APP_CHANNEL_SECRET }),
  });
  if (!r.ok) throw new Error(`mini app token ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

export async function sendMatchResult(req: Request, env: Env): Promise<Response> {
  const session = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const who = session ? await verifySession(env, session) : null;
  if (!who || who.guest) return json({ error: "LINE login required" }, 401);
  const { liffAccessToken } = (await req.json().catch(() => ({}))) as { liffAccessToken?: unknown };
  if (typeof liffAccessToken !== "string" || !liffAccessToken) return json({ error: "liffAccessToken required" }, 400);

  // Only the server-recorded result is sent; the client supplies nothing about the match.
  const m = await env.DB.prepare(
    `SELECT m.match_id, m.score, m.kills, m.rank, (SELECT COUNT(*) FROM matches x WHERE x.match_id = m.match_id) AS players
     FROM matches m WHERE m.player_id = ? ORDER BY m.created_at DESC LIMIT 1`,
  ).bind(who.id).first<{ match_id: string; score: number; kills: number; rank: number; players: number }>();
  if (!m) return json({ error: "Finish a match first" }, 404);

  // Once per match per player.
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO service_messages (match_id, player_id, sent_at) VALUES (?, ?, ?)")
    .bind(m.match_id, who.id, Date.now()).run();
  if (!claim.meta.changes) return json({ error: "Already sent for this match" }, 409);

  try {
    const token = await miniAppToken(env);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const issued = await fetch("https://api.line.me/message/v3/notifier/token", { method: "POST", headers, body: JSON.stringify({ liffAccessToken }) });
    if (!issued.ok) throw new Error(`notifier token ${issued.status}: ${(await issued.text()).slice(0, 160)}`);
    const { notificationToken } = (await issued.json()) as { notificationToken: string };

    const room = m.match_id.split("-")[0];
    const sent = await fetch("https://api.line.me/message/v3/notifier/send?target=service", {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateName: TEMPLATE,
        notificationToken,
        params: {
          order_id: `${room}-${m.match_id.slice(-5)}`,
          shop_name: `Tank Arena · Room ${room}`,
          context: `Rank #${m.rank} of ${m.players} · ${m.score} pts · ${m.kills} kills`,
          btn1_url: appLink(env, "view=rank"),
        },
      }),
    });
    if (!sent.ok) throw new Error(`notifier send ${sent.status}: ${(await sent.text()).slice(0, 160)}`);
    console.log("service message sent", m.match_id, sent.status);
    return json({ ok: true });
  } catch (e) {
    // Release the claim so the player can retry after reopening the MINI App (new LIFF access token).
    await env.DB.prepare("DELETE FROM service_messages WHERE match_id = ? AND player_id = ?").bind(m.match_id, who.id).run();
    console.error("service message failed", (e as Error).message);
    return json({ error: "LINE could not send the message" }, 502); // details stay in server logs
  }
}
