import { ARENA_ROOM, MAX_PLAYERS } from "../src/shared/protocol";
import type { Env } from "./env";
import { hmac, safeEqual } from "./auth";
import { topPlayers } from "./db";
import { appLink } from "./api";

// ponytail: per-isolate cache; stateless v3 tokens live 15 min, we refresh after 10.
let cached: { token: string; until: number } | null = null;
async function accessToken(env: Env): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const r = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.LINE_OA_CHANNEL_ID, client_secret: env.LINE_OA_CHANNEL_SECRET }),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = (await r.json()) as { access_token: string };
  cached = { token: j.access_token, until: Date.now() + 10 * 60_000 };
  return j.access_token;
}

const btn = (label: string, uri: string) => ({ type: "button", style: "primary", color: "#16a34a", height: "sm", action: { type: "uri", label, uri } });
const txt = (text: string, extra: object = {}) => ({ type: "text", text, wrap: true, ...extra });
const bubble = (title: string, rows: object[], footer: object[]) => ({
  type: "bubble",
  header: { type: "box", layout: "vertical", backgroundColor: "#111827", contents: [txt(title, { color: "#facc15", weight: "bold", size: "lg" })] },
  body: { type: "box", layout: "vertical", spacing: "sm", contents: rows.length ? rows : [txt("—", { color: "#888888" })] },
  footer: { type: "box", layout: "vertical", spacing: "sm", contents: footer },
});
const flex = (altText: string, contents: object) => ({ type: "flex", altText, contents });

export async function buildReply(env: Env, text: string, userId?: string): Promise<object[]> {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  if (cmd === "/me") {
    // OA and MINI App share a provider, so the OA userId equals the verified MINI App sub.
    const p = userId ? await env.DB.prepare("SELECT name, total_score, wins, kills, matches FROM players WHERE id = ?").bind(userId).first<{ name: string; total_score: number; wins: number; kills: number; matches: number }>() : null;
    if (!p) return [flex("Play Tank Arena", bubble("🎮 No score yet", [txt("Play a match in the MINI App to get ranked!", { size: "sm", wrap: true })], [btn("Play now", appLink(env, ""))]))];
    return [flex(`${p.name}: ${p.total_score} pts`, bubble(`🛡️ ${p.name}`, [txt(`Score ${p.total_score} · Wins ${p.wins} · Kills ${p.kills} · Matches ${p.matches}`, { size: "sm", wrap: true })], [btn("Play now", appLink(env, ""))]))];
  }
  if (cmd === "/rank") {
    const top = await topPlayers(env, 10);
    const rows = top.map((p, i) => ({
      type: "box", layout: "horizontal", contents: [
        txt(`${["🥇", "🥈", "🥉"][i] ?? i + 1 + "."} ${p.name}`, { flex: 5, size: "sm" }),
        txt(String(p.totalScore), { flex: 2, size: "sm", align: "end", weight: "bold" }),
      ],
    }));
    return [flex("Tank Arena top 10", bubble("🏆 Tank Arena Top 10", rows, [btn("Full leaderboard", appLink(env, "view=rank"))]))];
  }
  if (cmd === "/party" || cmd === "/create") {
    // Free-tier deployment: one public arena (12 players). Both commands invite into it.
    const row = await env.DB.prepare("SELECT players FROM rooms WHERE room_id = ? AND updated_at > ?")
      .bind(ARENA_ROOM, Date.now() - 120_000).first<{ players: number }>();
    const n = row?.players ?? 0;
    const status = n >= MAX_PLAYERS ? "Full right now — try again in a minute" : n ? `${n}/${MAX_PLAYERS} players fighting now` : "Empty — be the first in!";
    return [flex("Tank Arena", bubble("⚔️ The Arena", [txt(status, { size: "sm", wrap: true }), txt("Share this message so friends join the same battle.", { size: "xs", color: "#888888", wrap: true })],
      [btn("Join battle", appLink(env, `room=${ARENA_ROOM}`))]))];
  }
  return [{ type: "text", text: "Tank Arena bot 🛡️\n/rank – top 10 players\n/party – join the arena\n/me – your stats" }];
}

export async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const raw = new Uint8Array(await req.arrayBuffer());
  const sig = req.headers.get("x-line-signature") ?? "";
  let given: Uint8Array;
  try { given = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)); } catch { return new Response("bad signature", { status: 401 }); }
  if (!env.LINE_OA_CHANNEL_SECRET || !safeEqual(new Uint8Array(await hmac(env.LINE_OA_CHANNEL_SECRET, raw)), given)) {
    return new Response("bad signature", { status: 401 });
  }
  const { events = [] } = JSON.parse(new TextDecoder().decode(raw)) as { events?: any[] };
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.replyToken) continue;
    const text: string = ev.message.text;
    // In groups only answer explicit commands so the bot isn't noisy.
    if (ev.source?.type !== "user" && !text.trim().startsWith("/")) continue;
    try {
      const r = await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await accessToken(env)}` },
        body: JSON.stringify({ replyToken: ev.replyToken, messages: await buildReply(env, text, ev.source?.userId) }),
      });
      if (!r.ok) console.error("reply failed", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      console.error("reply error", (e as Error).message);
    }
  }
  return new Response("ok");
}
