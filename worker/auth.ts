import type { Env } from "./env";
export interface Identity { id: string; name: string; avatar?: string; guest?: boolean }

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function hmac(secret: string, data: string | Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, typeof data === "string" ? enc.encode(data) : data);
}

/** Constant-time compare of two byte arrays. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const TTL_S = 12 * 3600;

/** Issue a compact token: base64url(json).base64url(hmac). */
export async function issueSession(env: Env, id: Identity): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify({ id: id.id, name: id.name, avatar: id.avatar, guest: !!id.guest, exp: Math.floor(Date.now() / 1000) + TTL_S })));
  return `${body}.${b64u(await hmac(env.SESSION_SECRET, body))}`;
}

/** Verify a game session token issued by POST /api/session. Returns null if invalid. */
export async function verifySession(env: Env, token: string): Promise<Identity | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig || !env.SESSION_SECRET) return null;
    if (!safeEqual(new Uint8Array(await hmac(env.SESSION_SECRET, body)), unb64u(sig))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (typeof p.id !== "string" || typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
    return { id: p.id, name: String(p.name ?? "Player"), avatar: p.avatar, guest: p.guest === true };
  } catch {
    return null;
  }
}
