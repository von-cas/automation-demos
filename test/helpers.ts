import { env as testEnv } from 'cloudflare:test';
import type { Env, Fetch } from '../src/env';

export const env = testEnv as unknown as Env;

export function withEnv(overrides: Partial<Env>): Env {
  return { ...env, ...overrides };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (call: Call) => Response | Promise<Response>;

/** A fetch stand-in: routes by URL substring, records every call, fails loudly on anything unexpected. */
export function fakeFetch(routes: [string | RegExp, Responder][]) {
  const calls: Call[] = [];
  const fn: Fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init as RequestInit);
    const call: Call = {
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
      body: req.body ? new TextDecoder().decode(await req.arrayBuffer()) : '',
    };
    calls.push(call);
    const hit = routes.find(([m]) => (typeof m === 'string' ? call.url.includes(m) : m.test(call.url)));
    if (!hit) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
    return hit[1](call);
  };
  return { fetch: fn as Fetch, calls };
}

export const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export function geminiText(text: string) {
  return jsonResponse({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
}
