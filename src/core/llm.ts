// LLM wrapper: Gemini Flash with JSON-schema output, validated with zod, one retry,
// then a Workers AI fallback. Every attempt is reported so the run log shows which model answered.
import { z } from 'zod';
import type { Env, Fetch } from '../env';
import type { StepHandle } from './runs';

export interface InlineFile {
  mimeType: string; // e.g. application/pdf, image/png
  data: string; // base64
}

export interface GenerateOptions<T> {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /** Files Gemini reads directly (PDFs, images). The text-only fallback cannot read them. */
  files?: InlineFile[];
  temperature?: number;
  timeoutMs?: number;
  /** When given, the step's model and note are filled in (e.g. "gemini-3.8-flash, 2 attempts"). */
  step?: StepHandle;
  fetch?: Fetch;
  /** Test hook for the Workers AI binding. */
  ai?: Pick<Ai, 'run'>;
}

export interface Attempt {
  provider: 'gemini' | 'workers-ai';
  model: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface GenerateResult<T> {
  data: T;
  model: string;
  attempts: Attempt[];
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[],
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** JSON Schema for the provider. `$schema` is dropped: neither API needs it. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

/** Parses model text as JSON (tolerating a ```json fence) and validates it. */
export function parseAndValidate<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; data: T } | { ok: false; error: string } {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try {
      value = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Response was not valid JSON.' };
    }
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `Schema check failed: ${issues}` };
}

class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function callGemini(
  env: Env,
  opts: GenerateOptions<unknown>,
  schemaJson: Record<string, unknown>,
  correction: string | null,
): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new ProviderError('GEMINI_API_KEY is not set', false);
  const fetchFn = opts.fetch ?? fetch;
  const parts: Record<string, unknown>[] = [{ text: opts.prompt }];
  for (const f of opts.files ?? []) parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
  const contents: Record<string, unknown>[] = [{ role: 'user', parts }];
  if (correction) {
    contents.push({ role: 'user', parts: [{ text: `Your last answer was rejected: ${correction} Reply again with JSON that matches the schema exactly.` }] });
  }
  let res: Response;
  try {
    res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: schemaJson,
          temperature: opts.temperature ?? 0.2,
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
  } catch (err) {
    throw new ProviderError(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`Gemini HTTP ${res.status}`, retryable);
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  };
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (!text) throw new ProviderError(`Gemini returned no text (finishReason ${cand?.finishReason ?? 'none'})`, true);
  return text;
}

async function callWorkersAi(env: Env, opts: GenerateOptions<unknown>, schemaJson: Record<string, unknown>): Promise<unknown> {
  const ai = opts.ai ?? env.AI;
  if (!ai) throw new ProviderError('Workers AI binding is missing', false);
  const out = (await ai.run(env.WORKERS_AI_MODEL as Parameters<Ai['run']>[0], {
    messages: [
      { role: 'system', content: `${opts.system}\nReply with JSON only, matching this schema: ${JSON.stringify(schemaJson)}` },
      { role: 'user', content: opts.prompt },
    ],
    response_format: { type: 'json_schema', json_schema: schemaJson },
    temperature: opts.temperature ?? 0.2,
  } as never)) as { response?: unknown };
  if (out?.response == null) throw new ProviderError('Workers AI returned no response', true);
  return out.response;
}

/**
 * Generate JSON that matches `schema`.
 * Order: Gemini → (invalid or failed) Gemini once more → Workers AI → LlmError.
 * A non-retryable Gemini error (missing key, 4xx) skips the retry and goes to the fallback.
 * With files attached there is no text-only fallback, so the error is raised after Gemini.
 */
export async function generateJson<T>(env: Env, opts: GenerateOptions<T>): Promise<GenerateResult<T>> {
  const schemaJson = jsonSchemaFor(opts.schema);
  const attempts: Attempt[] = [];
  const o = opts as GenerateOptions<unknown>;
  let correction: string | null = null;

  const done = (data: T, model: string): GenerateResult<T> => {
    if (opts.step) {
      opts.step.model = model;
      opts.step.note = attempts.length > 1 ? `${model}, ${attempts.length} attempts` : model;
    }
    return { data, model, attempts };
  };

  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    try {
      const text = await callGemini(env, o, schemaJson, correction);
      const checked = parseAndValidate(opts.schema, text);
      attempts.push({ provider: 'gemini', model: env.GEMINI_MODEL, ok: checked.ok, ms: Date.now() - t0, error: checked.ok ? undefined : checked.error });
      if (checked.ok) return done(checked.data, env.GEMINI_MODEL);
      correction = checked.error;
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err), true);
      attempts.push({ provider: 'gemini', model: env.GEMINI_MODEL, ok: false, ms: Date.now() - t0, error: e.message });
      if (!e.retryable) break;
    }
  }

  if (opts.files?.length) {
    throw new LlmError('Gemini failed and the fallback model cannot read files.', attempts);
  }

  const t0 = Date.now();
  try {
    const raw = await callWorkersAi(env, o, schemaJson);
    const checked = parseAndValidate(opts.schema, raw);
    attempts.push({ provider: 'workers-ai', model: env.WORKERS_AI_MODEL, ok: checked.ok, ms: Date.now() - t0, error: checked.ok ? undefined : checked.error });
    if (checked.ok) return done(checked.data, env.WORKERS_AI_MODEL);
  } catch (err) {
    attempts.push({ provider: 'workers-ai', model: env.WORKERS_AI_MODEL, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
  }
  if (opts.step) opts.step.note = `all ${attempts.length} LLM attempts failed`;
  throw new LlmError(`All LLM attempts failed: ${attempts.map((a) => `${a.model}: ${a.error}`).join(' | ')}`, attempts);
}
