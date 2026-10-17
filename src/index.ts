// automation-demos Worker: the shared core API (ops feed, stats, dead-letter) and the cron dispatcher.
// Demo routes plug in through src/demos/index.ts.
import { z } from 'zod';
import type { Env } from './env';
import { configured } from './env';
import { sendTelegram } from './core/alerts';
import { dispatch } from './core/cron';
import { listDeadLetter, retryDeadLetter } from './core/deadletter';
import { HttpError, clientIp, errorResponse, isAdmin, json } from './core/http';
import { readJson, takeIpQuota, verifyTurnstile } from './core/guardrails';
import { generateJson } from './core/llm';
import { Run, getRun, getState, listRuns, stats } from './core/runs';
import { demoRoutes } from './demos';

export const VERSION = '0.1.0';

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

const DEMO_NAME = /^[a-z0-9-]{1,40}$/;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'GET' && (path === '/' || path === '/api/health')) {
    const tick = await getState(env, 'cron:last_tick');
    return json({ ok: true, service: 'automation-demos', version: VERSION, last_cron_tick: tick?.value ?? null, configured: configured(env) });
  }

  if (method === 'GET' && path === '/api/runs') {
    const demo = url.searchParams.get('demo') ?? undefined;
    if (demo && !DEMO_NAME.test(demo)) throw new HttpError(400, 'bad_demo', 'Unknown demo name.');
    const limit = Number(url.searchParams.get('limit') ?? '20');
    return json({ runs: await listRuns(env, { demo, limit: Number.isFinite(limit) ? limit : 20 }) });
  }

  const runMatch = path.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
  if (method === 'GET' && runMatch) {
    const run = await getRun(env, runMatch[1]!);
    if (!run) throw new HttpError(404, 'not_found', 'No run with that id.');
    return json({ run });
  }

  if (method === 'GET' && path === '/api/stats') {
    return json(await stats(env), 200, { 'cache-control': 'public, max-age=10' });
  }

  if (method === 'GET' && path === '/api/dead-letter') {
    const demo = url.searchParams.get('demo') ?? undefined;
    if (demo && !DEMO_NAME.test(demo)) throw new HttpError(400, 'bad_demo', 'Unknown demo name.');
    return json({ items: await listDeadLetter(env, { demo }) });
  }

  const retryMatch = path.match(/^\/api\/dead-letter\/([0-9a-f-]{36})\/retry$/);
  if (method === 'POST' && retryMatch) {
    // The retry button: an admin token, or a visitor who passes Turnstile (10 retries per IP per day).
    if (!isAdmin(request, env.ADMIN_TOKEN)) {
      const body = await readJson(request, z.object({ turnstile: z.string().min(1).max(2048) }));
      const ip = clientIp(request);
      if (!(await verifyTurnstile(env, body.turnstile, ip))) throw new HttpError(403, 'turnstile_failed', 'The spam check did not pass.');
      const quota = await takeIpQuota(env, 'retry', ip, 10);
      if (!quota.allowed) throw new HttpError(429, 'daily_limit', 'Retry limit reached for today.');
    }
    return json(await retryDeadLetter(env, retryMatch[1]!));
  }

  // Admin-only live check of the integrations (no visitor data involved).
  if (method === 'POST' && path === '/api/admin/selftest') {
    if (!isAdmin(request, env.ADMIN_TOKEN)) throw new HttpError(401, 'unauthorized', 'Admin token required.');
    const run = await Run.start(env, { demo: 'core', trigger: 'selftest' });
    const out: Record<string, unknown> = { run_id: run.id };
    try {
      if (url.searchParams.get('llm') === '1') {
        const schema = z.object({ ok: z.boolean(), word: z.string().max(20) });
        const r = await run.step('llm', (s) =>
          generateJson(env, { schema, system: 'You are a health check.', prompt: 'Return {"ok": true, "word": "ready"}.', step: s }),
        );
        out.llm = { model: r.model, attempts: r.attempts.map(({ provider, model, ok, ms, error }) => ({ provider, model, ok, ms, error })) };
      }
      if (url.searchParams.get('fallback') === '1') {
        const schema = z.object({ ok: z.boolean(), word: z.string().max(20) });
        const r = await run.step('llm-fallback', (s) =>
          generateJson({ ...env, GEMINI_API_KEY: undefined }, { schema, system: 'You are a health check.', prompt: 'Return {"ok": true, "word": "ready"}.', step: s }),
        );
        out.fallback = { model: r.model, attempts: r.attempts.map(({ provider, model, ok, ms, error }) => ({ provider, model, ok, ms, error })) };
      }
      if (url.searchParams.get('alert') === '1') {
        out.alert = await run.step('telegram', () => sendTelegram(env, 'automation-demos self-test: alerts reach Telegram.'));
      }
      await run.succeed('Self-test passed');
    } catch (err) {
      await run.fail(err, 'Self-test failed');
      out.error = err instanceof Error ? err.message : String(err);
    }
    return json(out);
  }

  for (const r of demoRoutes) {
    if (r.method === method && r.path === path) return r.handle(request, env, ctx);
  }

  throw new HttpError(404, 'not_found', 'No such route.');
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      res = errorResponse(err);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...cors })) out.headers.set(k, v);
    return out;
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(dispatch(env, new Date(controller.scheduledTime)).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
