export interface Env {
  ROOM: DurableObjectNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_URL: string;
  // secrets (wrangler secret put / .dev.vars) — names finalized by Agent C
  MINI_APP_CHANNEL_ID: string;
  MINI_APP_CHANNEL_SECRET: string;
  LINE_OA_CHANNEL_ID: string;
  LINE_OA_CHANNEL_SECRET: string;
  SESSION_SECRET: string;
  LIFF_ID?: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
}
