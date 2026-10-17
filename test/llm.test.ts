import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError, generateJson, jsonSchemaFor, parseAndValidate } from '../src/core/llm';
import { fakeFetch, geminiText, jsonResponse, withEnv } from './helpers';

const schema = z.object({ score: z.number().int().min(0).max(100), intent: z.enum(['buy', 'browse']) });
const base = withEnv({ GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-test', WORKERS_AI_MODEL: '@cf/test/model' });

function fakeAi(response: unknown) {
  const calls: unknown[] = [];
  return { calls, ai: { run: async (_m: unknown, input: unknown) => (calls.push(input), { response }) } as never };
}

describe('jsonSchemaFor', () => {
  it('drops $schema and keeps required fields', () => {
    const s = jsonSchemaFor(schema);
    expect(s.$schema).toBeUndefined();
    expect(s.required).toEqual(['score', 'intent']);
  });
});

describe('parseAndValidate', () => {
  it('accepts fenced JSON', () => {
    expect(parseAndValidate(schema, '```json\n{"score": 5, "intent": "buy"}\n```')).toEqual({ ok: true, data: { score: 5, intent: 'buy' } });
  });
  it('reports schema problems by path', () => {
    const r = parseAndValidate(schema, '{"score": 500, "intent": "buy"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('score');
  });
  it('rejects non-JSON', () => {
    expect(parseAndValidate(schema, 'hello').ok).toBe(false);
  });
});

describe('generateJson', () => {
  it('returns Gemini output on the first valid answer and sends the schema + key header', async () => {
    const f = fakeFetch([['generativelanguage', () => geminiText('{"score": 82, "intent": "buy"}')]]);
    const step: { model?: string; note?: string } = {};
    const r = await generateJson(base, { schema, system: 'sys', prompt: 'p', fetch: f.fetch, step });
    expect(r.data).toEqual({ score: 82, intent: 'buy' });
    expect(r.model).toBe('gemini-test');
    expect(step).toEqual({ model: 'gemini-test', note: 'gemini-test' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toContain('/models/gemini-test:generateContent');
    expect(f.calls[0]!.headers['x-goog-api-key']).toBe('test-key');
    expect(f.calls[0]!.url).not.toContain('test-key');
    const body = JSON.parse(f.calls[0]!.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema.properties.score).toBeDefined();
  });

  it('retries once with the validation error, then succeeds', async () => {
    let n = 0;
    const f = fakeFetch([['generativelanguage', () => geminiText(n++ === 0 ? '{"score": 900, "intent": "buy"}' : '{"score": 90, "intent": "buy"}')]]);
    const r = await generateJson(base, { schema, system: 's', prompt: 'p', fetch: f.fetch });
    expect(r.data.score).toBe(90);
    expect(r.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(JSON.parse(f.calls[1]!.body).contents[1].parts[0].text).toContain('rejected');
  });

  it('falls back to Workers AI after two bad Gemini answers', async () => {
    const f = fakeFetch([['generativelanguage', () => geminiText('nope')]]);
    const ai = fakeAi({ score: 40, intent: 'browse' });
    const step: { model?: string; note?: string } = {};
    const r = await generateJson(base, { schema, system: 's', prompt: 'p', fetch: f.fetch, ai: ai.ai, step });
    expect(r.model).toBe('@cf/test/model');
    expect(r.attempts.map((a) => a.provider)).toEqual(['gemini', 'gemini', 'workers-ai']);
    expect(step.note).toBe('@cf/test/model, 3 attempts');
    expect(ai.calls).toHaveLength(1);
  });

  it('skips the Gemini retry on a non-retryable error (missing key)', async () => {
    const f = fakeFetch([]);
    const ai = fakeAi('{"score": 1, "intent": "browse"}');
    const r = await generateJson(withEnv({ ...base, GEMINI_API_KEY: undefined }), { schema, system: 's', prompt: 'p', fetch: f.fetch, ai: ai.ai });
    expect(r.attempts.map((a) => a.provider)).toEqual(['gemini', 'workers-ai']);
    expect(f.calls).toHaveLength(0);
  });

  it('retries a 429 from Gemini', async () => {
    let n = 0;
    const f = fakeFetch([['generativelanguage', () => (n++ === 0 ? jsonResponse({}, 429) : geminiText('{"score": 3, "intent": "buy"}'))]]);
    const r = await generateJson(base, { schema, system: 's', prompt: 'p', fetch: f.fetch });
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]!.error).toContain('429');
  });

  it('throws LlmError when every attempt fails', async () => {
    const f = fakeFetch([['generativelanguage', () => jsonResponse({}, 500)]]);
    const ai = fakeAi('{"score": "x"}');
    await expect(generateJson(base, { schema, system: 's', prompt: 'p', fetch: f.fetch, ai: ai.ai })).rejects.toBeInstanceOf(LlmError);
  });

  it('does not use the text-only fallback when files are attached', async () => {
    const f = fakeFetch([['generativelanguage', () => jsonResponse({}, 503)]]);
    const ai = fakeAi({ score: 1, intent: 'buy' });
    await expect(
      generateJson(base, { schema, system: 's', prompt: 'p', files: [{ mimeType: 'application/pdf', data: 'JVBERg==' }], fetch: f.fetch, ai: ai.ai }),
    ).rejects.toThrow(/cannot read files/);
    expect(ai.calls).toHaveLength(0);
    expect(JSON.parse(f.calls[0]!.body).contents[0].parts[1].inlineData.mimeType).toBe('application/pdf');
  });

  it('ignores thought parts in the Gemini answer', async () => {
    const f = fakeFetch([
      ['generativelanguage', () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"score": 7, "intent": "buy"}' }] } }] })],
    ]);
    const r = await generateJson(base, { schema, system: 's', prompt: 'p', fetch: f.fetch });
    expect(r.data.score).toBe(7);
  });
});
