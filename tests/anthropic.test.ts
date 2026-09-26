import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { z } from 'zod';
import { LLM } from '../server/ai/llm';
import { RealClock } from '../server/room/clock';

// Fake Anthropic Messages API: each test queues the next replies.
type Reply = { text?: string; stop?: string; status?: number };
let queue: Reply[] = [];
const reqs: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => {
      reqs.push({ headers: req.headers, body: JSON.parse(d || '{}') });
      const r = queue.shift() ?? { text: '{}' };
      if (r.status) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: r.stop === 'refusal' ? [] : [{ type: 'text', text: r.text ?? '{}' }],
        stop_reason: r.stop ?? 'end_turn', stop_sequence: null,
        stop_details: r.stop === 'refusal' ? { type: 'refusal', category: 'cyber', explanation: 'x' } : null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); });

const make = () => {
  const llm = new LLM(new RealClock(), {
    provider: 'anthropic', apiKey: 'sk-test', baseURL: base, cache: false, effort: 'low',
    models: { smart: 'claude-opus-5', fast: 'claude-opus-5', vision: 'claude-opus-5' },
  });
  llm.quiet = true;
  return llm;
};
const Schema = z.object({ answer: z.string() });
const call = (llm: LLM, images?: string[]) => llm.json({
  task: 'director', model: 'smart', system: 'Return JSON only.', user: 'q', images, schema: Schema, timeoutMs: 3000, temperature: 0.4,
  fallback: () => ({ answer: 'template' }),
});

describe('Claude provider (LLM_PROVIDER=anthropic)', () => {
  it('calls the Messages API with the key, low effort, refusal fallback, and no sampling params', async () => {
    queue = [{ text: '```json\n{"answer":"from claude"}\n```' }];
    reqs.length = 0;
    const r = await call(make());
    expect(r).toMatchObject({ value: { answer: 'from claude' }, source: 'llm' });
    const { headers, body } = reqs[0];
    expect(headers['x-api-key']).toBe('sk-test');
    expect(String(headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({ model: 'claude-opus-5', system: 'Return JSON only.', output_config: { effort: 'low' }, fallbacks: 'default' });
    expect(body.temperature).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('retries once with the validation error, then falls back', async () => {
    queue = [{ text: '{"nope":1}' }, { text: '{"answer":"fixed"}' }];
    reqs.length = 0;
    expect((await call(make())).value).toEqual({ answer: 'fixed' });
    const msgs = reqs[1].body.messages as { role: string }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    queue = [{ text: 'no json' }, { text: 'still no json' }];
    expect(await call(make())).toMatchObject({ value: { answer: 'template' }, source: 'fallback' });
  });

  it('treats a refusal and a missing model as a fallback', async () => {
    queue = [{ stop: 'refusal' }];
    const r = await call(make());
    expect(r.source).toBe('fallback');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    queue = [{ status: 404 }];
    const llm = make();
    expect((await call(llm)).source).toBe('fallback');
    expect(llm.log[0].note).toBe('model not found');
  });

  it('sends images as base64 image blocks', async () => {
    queue = [{ text: '{"answer":"seen"}' }];
    reqs.length = 0;
    await call(make(), ['data:image/jpeg;base64,AAAA']);
    const first = (reqs[0].body.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0].content;
    expect(first[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
    expect(first[1]).toEqual({ type: 'text', text: 'q' });
  });
});
