import { ARENA_ROOM } from "../shared/protocol";
import type { Liff } from "@line/liff";

export interface LineIdentity { loggedIn: boolean; name: string; avatar?: string; session?: string; roomId: string; liffAvailable: boolean; view?: string }

let liff: Liff | null = null;
let liffId: string | null = null;
let session: string | null = null;
let turnstileSiteKey: string | null = null;


/** Read a query param from the URL, or from LIFF's `liff.state` (deep-link query before redirect). */
function param(name: string): string | null {
  const q = new URLSearchParams(location.search);
  const direct = q.get(name);
  if (direct) return direct;
  const state = q.get("liff.state");
  if (!state) return null;
  const i = state.indexOf("?");
  return new URLSearchParams(i >= 0 ? state.slice(i + 1) : state).get(name);
}

// Free-tier deployment runs a single public arena; old ?room= links all land there.
async function resolveRoom(): Promise<string> { return ARENA_ROOM; }

const guestName = () => "Guest-" + Math.floor(Math.random() * 9000 + 1000);

/** Init LIFF (if configured), login, exchange ID token for game session, resolve room from URL (?room=) or quick-join. */
export async function initLine(): Promise<LineIdentity> {
  let ident: Omit<LineIdentity, "roomId"> = { loggedIn: false, name: guestName(), liffAvailable: false };
  try {
    const cfg = (await (await fetch("/api/config")).json()) as { liffId: string | null; turnstileSiteKey: string | null };
    liffId = cfg.liffId; turnstileSiteKey = cfg.turnstileSiteKey;
    if (liffId) {
      liff = (await import("@line/liff")).default;
      await liff.init({ liffId });
      ident.liffAvailable = true;
      if (!liff.isLoggedIn() && param("login") === "1") { // explicit "Login with LINE" choice
        liff.login({ redirectUri: location.href });
        await new Promise(() => {}); // page is navigating away
      }
      const idToken = liff.isLoggedIn() ? liff.getIDToken() : null;
      const accessToken = liff.isLoggedIn() ? liff.getAccessToken() : null;
      if (idToken || accessToken) {
        const r = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken, accessToken }) });
        if (!r.ok) console.warn("LINE session rejected", r.status);
        if (r.ok) {
          const s = (await r.json()) as { session: string; name: string; avatar: string | null };
          ident = { ...ident, loggedIn: true, name: s.name, avatar: s.avatar ?? undefined, session: s.session };
          session = s.session;
        }
      }
    }
  } catch (e) {
    console.warn("LINE init failed, playing as guest", e);
  }
  return { ...ident, view: param("view") ?? undefined, roomId: await resolveRoom() };
}

export function inviteUrl(roomId: string): string {
  return liffId ? `https://miniapp.line.me/${liffId}?room=${roomId}` : `${location.origin}/?room=${roomId}`;
}

/** Share invite via shareTargetPicker; falls back to Web Share / clipboard. */
export async function shareInvite(roomId: string): Promise<"shared" | "copied" | "cancelled"> {
  const url = inviteUrl(roomId);
  const text = `Join my tank battle! Room ${roomId}`;
  try {
    if (liff?.isLoggedIn() && liff.isApiAvailable("shareTargetPicker")) {
      const res = await liff.shareTargetPicker([{
        type: "flex", altText: text,
        contents: {
          type: "bubble",
          body: { type: "box", layout: "vertical", contents: [
            { type: "text", text: "⚔️ Tank Arena 3D", weight: "bold", size: "lg" },
            { type: "text", text, wrap: true, size: "sm" },
          ] },
          footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#16a34a", action: { type: "uri", label: "Join battle", uri: url } }] },
        },
      }]);
      return res ? "shared" : "cancelled";
    }
  } catch (e) {
    console.warn("shareTargetPicker failed", e);
  }
  if (navigator.share) {
    try { await navigator.share({ title: "Tank Arena 3D", text, url }); return "shared"; } catch { /* fall through to copy */ }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; } catch { return "cancelled"; }
}

export interface RankRow { name: string; avatar?: string; totalScore: number; wins: number; kills: number }
export async function fetchLeaderboard(): Promise<RankRow[]> {
  try {
    const rows = (await (await fetch("/api/leaderboard")).json()) as RankRow[];
    return rows.map((r) => ({ name: r.name, avatar: r.avatar, totalScore: r.totalScore, wins: r.wins, kills: r.kills }));
  } catch { return []; }
}

/** WebSocket URL for a room using identity (LINE or Turnstile guest session). */
export function wsUrl(id: LineIdentity): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${id.roomId}?session=${encodeURIComponent(id.session ?? "")}`;
}

/** LINE MINI App Service Message: the server sends this player's last recorded match result to their LINE. */
export async function sendResultToLine(): Promise<{ ok: boolean; message: string }> {
  const liffAccessToken = liff?.isLoggedIn() ? liff.getAccessToken() : null;
  if (!session || !liffAccessToken) return { ok: false, message: "Log in with LINE to receive results" };
  try {
    const r = await fetch("/api/service-message", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
      body: JSON.stringify({ liffAccessToken }),
    });
    if (r.ok) return { ok: true, message: "Result sent to your LINE ✅" };
    const e = ((await r.json().catch(() => ({}))) as { error?: string }).error;
    return { ok: false, message: r.status === 409 ? "Already sent for this match" : r.status === 404 ? "Result still saving — try again" : `Couldn't send (${e ?? r.status})` };
  } catch { return { ok: false, message: "Couldn't reach the server" }; }
}

/** Start LINE Login (returns here with ?login=1 so the room and choice survive the redirect). */
export function loginWithLine(): boolean {
  if (!liff || !liffId) return false;
  const u = new URL(location.href); u.searchParams.set("login", "1");
  liff.login({ redirectUri: u.toString() });
  return true;
}

/** Guest mode: pass Cloudflare Turnstile, server returns a signed guest session with a random name. */
export async function playAsGuest(container: HTMLElement): Promise<LineIdentity> {
  if (!turnstileSiteKey) throw new Error("Guest mode unavailable");
  const ts = await loadTurnstile();
  const token = await new Promise<string>((resolve, reject) => {
    ts.render(container, { sitekey: turnstileSiteKey!, callback: resolve, "error-callback": () => reject(new Error("Verification failed")), theme: "light" });
  });
  const r = await fetch("/api/guest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnstileToken: token }) });
  if (!r.ok) throw new Error("Verification failed");
  const g = (await r.json()) as { session: string; name: string };
  session = null; // guests can't use LINE-only features (Service Message)
  return { loggedIn: false, name: g.name, session: g.session, roomId: ARENA_ROOM, liffAvailable: !!liffId };
}

type Turnstile = { render: (el: HTMLElement, o: Record<string, unknown>) => string };
function loadTurnstile(): Promise<Turnstile> {
  const w = window as unknown as { turnstile?: Turnstile };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("Turnstile failed to load")));
    s.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.appendChild(s);
  });
}
