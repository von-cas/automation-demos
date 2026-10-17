// Bindings, public vars (wrangler.jsonc) and secrets (`wrangler secret put`).
// Secrets are optional here so the Worker still boots and reports what is missing on /api/health.
export interface Env {
  DB: D1Database;
  AI?: Ai;

  ALLOWED_ORIGINS: string;
  GEMINI_MODEL: string;
  WORKERS_AI_MODEL: string;
  GMAIL_FROM_ADDRESS: string;
  GMAIL_FROM_NAME: string;
  DEMO_CALENDAR_ID: string;
  DEMO_TIMEZONE: string;
  IP_DAILY_LIMIT: string;
  DAILY_SEND_CAP: string;
  RETENTION_DAYS: string;

  // secrets
  GEMINI_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  IP_HASH_SALT?: string;
  ADMIN_TOKEN?: string;
}

export type Fetch = typeof fetch;

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Which integrations have their secrets set. Booleans only: never the values. */
export function configured(env: Env) {
  return {
    gemini: Boolean(env.GEMINI_API_KEY),
    workersAi: Boolean(env.AI),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN),
    turnstile: Boolean(env.TURNSTILE_SECRET),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    ipSalt: Boolean(env.IP_HASH_SALT),
    admin: Boolean(env.ADMIN_TOKEN),
  };
}
