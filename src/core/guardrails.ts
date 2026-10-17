// Guardrails for public demo forms: body size limits, Turnstile, 3 runs per IP per day, and a
// global daily email cap. When the email cap is hit the demo shows the email on the page instead.
import { z } from 'zod';
import type { Env, Fetch } from '../env';
import { intVar } from '../env';
import { HttpError, clientIp } from './http';
import { bumpCounter, dayKey, readCounter } from './runs';

export const LIMITS = {
  formBytes: 8 * 1024,
  uploadBytes: 5 * 1024 * 1024,
};

/** Reads the body as text, refusing anything over `maxBytes` (checks the header and the real length). */
export async function readBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'too_large', `Request body is over ${maxBytes} bytes.`);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'too_large', `Request body is over ${maxBytes} bytes.`);
  return new TextDecoder().decode(buf);
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes = LIMITS.formBytes): Promise<T> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_type', 'Send JSON.');
  const text = await readBody(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))];
    throw new HttpError(400, 'invalid_input', 'Some fields are missing or too long.', { fields });
  }
  return parsed.data;
}

/** Common bounded fields for demo forms. */
export const field = {
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  short: z.string().trim().max(120),
  text: z.string().trim().max(2000),
  turnstile: z.string().min(1).max(2048),
};

export async function verifyTurnstile(env: Env, token: string, ip: string, fetchFn: Fetch = fetch): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) throw new HttpError(503, 'not_configured', 'Spam check is not set up yet.');
  const res = await fetchFn('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new HttpError(503, 'turnstile_unavailable', 'Spam check is unavailable. Try again in a minute.');
  const body = (await res.json()) as { success: boolean };
  return body.success === true;
}

export async function hashKey(env: Env, parts: string[]): Promise<string> {
  if (!env.IP_HASH_SALT) throw new HttpError(503, 'not_configured', 'Rate limiting is not set up yet.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IP_HASH_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.join('|')));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Counts one use for this IP in `bucket` today. Allowed while the count is within the limit. */
export async function takeIpQuota(env: Env, bucket: string, ip: string, limit = intVar(env.IP_DAILY_LIMIT, 3), now = Date.now()) {
  const day = dayKey(now);
  const key = await hashKey(env, [bucket, day, ip]);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, day, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING count`,
  )
    .bind(key, day)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, used: count, limit, remaining: Math.max(0, limit - count) };
}

/**
 * Takes one email from the global daily cap. Returns false when the cap is reached; the demo then
 * shows the email on the page instead of sending it.
 */
export async function takeSendQuota(env: Env, now = Date.now()): Promise<{ allowed: boolean; sentToday: number; cap: number }> {
  const cap = intVar(env.DAILY_SEND_CAP, 60);
  if ((await readCounter(env, 'emails_sent', now)) >= cap) return { allowed: false, sentToday: cap, cap };
  const count = await bumpCounter(env, 'emails_sent', 1, now);
  if (count > cap) {
    await bumpCounter(env, 'emails_sent', -1, now); // lost a race; give the slot back
    return { allowed: false, sentToday: cap, cap };
  }
  return { allowed: true, sentToday: count, cap };
}

export interface GuardOptions<T> {
  bucket: string;
  schema: z.ZodType<T & { turnstile: string }>;
  maxBytes?: number;
  limit?: number;
  fetch?: Fetch;
}

/** The full check for a public form: size → JSON schema → Turnstile → per-IP cap. */
export async function guardForm<T>(request: Request, env: Env, opts: GuardOptions<T>) {
  const body = await readJson(request, opts.schema, opts.maxBytes);
  const ip = clientIp(request);
  if (!(await verifyTurnstile(env, body.turnstile, ip, opts.fetch))) {
    throw new HttpError(403, 'turnstile_failed', 'The spam check did not pass. Reload the page and try again.');
  }
  const quota = await takeIpQuota(env, opts.bucket, ip, opts.limit);
  if (!quota.allowed) {
    throw new HttpError(429, 'daily_limit', `This demo runs ${quota.limit} times per visitor per day. Try again tomorrow.`, { limit: quota.limit });
  }
  return { body, ip, quota };
}
