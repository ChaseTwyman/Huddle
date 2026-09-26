import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { z } from 'zod';
import { LLM, extractJson } from '../server/ai/llm';
import { RealClock, VirtualClock } from '../server/room/clock';
import { directorTurn, validateDecision, type DirectorInput } from '../server/director/director';
import { candidatesFor } from '../server/director/scheduler';
import { loadFixture } from '../server/data/loadGame';
import { plainTicker } from '../server/game/ticker';

// A fake OpenAI-compatible server: each test queues how the next responses behave.
type Reply = { status?: number; body?: string; delayMs?: number; rejectFormat?: boolean };
let queue: Reply[] = [];
const requests: { body: { response_format?: unknown; messages: { role: string; content: unknown }[] } }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      requests.push({ body });
      const r = queue.shift() ?? { body: '{}' };
      const send = () => {
        if (r.rejectFormat && body.response_format) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'response_format json_object is not supported with this model' } }));
          return;
        }
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
        if ((r.status ?? 200) !== 200) { res.end(JSON.stringify({ error: { message: r.status === 404 ? 'The model does not exist' : 'error' } })); return; }
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: r.body ?? '{}' } }] }));
      };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => { server.close(); });

const make = () => {
  const llm = new LLM(new RealClock(), { provider: 'openai_compatible', baseURL: base, apiKey: 'test', cache: false, models: { smart: 'smart-m', fast: 'fast-m', vision: 'vis-m' } });
  llm.quiet = true;
  return llm;
};
const Schema = z.object({ answer: z.string() });
const call = (llm: LLM, timeoutMs = 2000, user = 'q') => llm.json({ task: 'beat', model: 'fast', system: 'sys', user, schema: Schema, timeoutMs, fallback: () => ({ answer: 'fallback' }) });

describe('AI client (BUILD_PROMPT 10.1)', () => {
  it('returns validated JSON from the provider with JSON mode on', async () => {
    queue = [{ body: '{"answer":"hi"}' }];
    requests.length = 0;
    const r = await call(make());
    expect(r).toMatchObject({ value: { answer: 'hi' }, source: 'llm' });
    expect(requests[0].body.response_format).toEqual({ type: 'json_object' });
  });

  it('retries once with the zod error when the JSON is invalid', async () => {
    queue = [{ body: '{"wrong":1}' }, { body: '```json\n{"answer":"fixed"}\n```' }];
    requests.length = 0;
    const r = await call(make());
    expect(r.value).toEqual({ answer: 'fixed' });
    expect(requests).toHaveLength(2);
    const last = requests[1].body.messages[requests[1].body.messages.length - 1];
    expect(String(last.content)).toMatch(/not valid/);
  });

  it('falls back after a second invalid reply', async () => {
    queue = [{ body: 'nope' }, { body: '{"answer": 3}' }];
    const r = await call(make());
    expect(r).toMatchObject({ value: { answer: 'fallback' }, source: 'fallback' });
  });

  it('never waits longer than the timeout', async () => {
    queue = [{ body: '{"answer":"late"}', delayMs: 1500 }];
    const t0 = Date.now();
    const r = await call(make(), 300);
    expect(r.source).toBe('fallback');
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('backs off a task for 10 s after HTTP 429', async () => {
    queue = [{ status: 429 }, { body: '{"answer":"ok"}' }];
    requests.length = 0;
    const llm = make();
    expect((await call(llm)).source).toBe('fallback');
    const second = await call(llm);
    expect(second.source).toBe('fallback');
    expect(requests).toHaveLength(1);
    expect(llm.log[llm.log.length - 1].note).toMatch(/backoff/);
  });

  it('logs a model-not-found hint once and falls back', async () => {
    queue = [{ status: 404 }];
    const llm = make();
    const r = await call(llm);
    expect(r.source).toBe('fallback');
    expect(llm.log[0].note).toBe('model not found');
  });

  it('retries without response_format when the provider rejects it', async () => {
    queue = [{ body: '{"answer":"plain"}', rejectFormat: true }, { body: '{"answer":"plain"}' }];
    requests.length = 0;
    const r = await call(make());
    expect(r.value).toEqual({ answer: 'plain' });
    expect(requests[1].body.response_format).toBeUndefined();
  });

  it('mock provider returns the fallback after a short delay and logs it', async () => {
    const clock = new VirtualClock();
    const llm = new LLM(clock, { provider: 'mock' });
    llm.quiet = true;
    const p = llm.json({ task: 'director', model: 'smart', system: 's', user: 'u', schema: Schema, timeoutMs: 4000, fallback: () => ({ answer: 'tpl' }) });
    await clock.run();
    const r = await p;
    expect(r).toMatchObject({ value: { answer: 'tpl' }, source: 'fallback' });
    expect(r.ms).toBeGreaterThanOrEqual(50);
    expect(r.ms).toBeLessThanOrEqual(150);
    expect(llm.log).toHaveLength(1);
  });

  it('extracts the first JSON object from chatty text', () => {
    expect(extractJson('Sure! ```json\n{"a":{"b":"}"}}\n``` hope that helps')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('F6 Director validation', () => {
  const P = loadFixture().timeline.plays;
  const play = P.find((p) => p.playId === 40)!;
  const input: DirectorInput = {
    play, trigger: 'penalty', candidates: candidatesFor(play, [{}], 'penalty'),
    handoffs: { holding_defensive: ['mom'] }, names: { mom: 'Mom' }, playerFacts: [], recentLines: [],
    budget: { remainingThisQuarter: 6, exempt: true }, announced: true,
  };
  const ok = { action: 'explain' as const, conceptId: 'holding_defensive', spoken: 'The defender grabbed Lamb before the ball arrived, so Dallas gets five yards and a fresh set of downs.', card: { title: 'Defensive holding', body: 'Grabbing a receiver without the ball: 5 yards and an automatic first down.' }, cheat: 'He grabbed a guy who did not have the ball.' };

  it('accepts a grounded decision within the limits', () => {
    expect(validateDecision(ok, input)).toMatchObject({ action: 'explain', conceptId: 'holding_defensive', source: 'llm' });
  });
  it('rejects unknown concepts, long lines, and handoffs to non-candidates', () => {
    expect(validateDecision({ ...ok, conceptId: 'face_mask' }, input)).toBeNull();
    expect(validateDecision({ ...ok, spoken: 'word '.repeat(29) }, input)).toBeNull();
    expect(validateDecision({ ...ok, card: { ...ok.card, title: 'x'.repeat(41) } }, input)).toBeNull();
    expect(validateDecision({ ...ok, action: 'handoff', handoffTo: 'dad' }, input)).toBeNull();
    expect(validateDecision({ ...ok, action: 'handoff', handoffTo: 'mom' }, input)).toMatchObject({ action: 'handoff', handoffTo: 'mom' });
  });
  it('uses the template when the model is slow or says silent after a flag', async () => {
    queue = [{ body: JSON.stringify({ action: 'silent' }) }];
    const d = await directorTurn(make(), input, 'DAL', 'NYG');
    expect(d).toMatchObject({ action: 'handoff', conceptId: 'holding_defensive', source: 'fallback' });
    queue = [{ body: JSON.stringify(ok), delayMs: 4500 }];
    const t0 = Date.now();
    const slow = await directorTurn(make(), input, 'DAL', 'NYG');
    expect(slow.source).toBe('fallback');
    expect(Date.now() - t0).toBeLessThan(4400);
  }, 10000);
});

describe('F11 plain-English ticker', () => {
  const P = loadFixture().timeline.plays;
  const byId = (id: number) => P.find((p) => p.playId === id)!;
  it('uses the rewrite when it is short and clean', async () => {
    queue = [{ body: JSON.stringify({ text: "Prescott hits Lamb for 8 yards to Dallas's 37-yard line." }) }];
    requests.length = 0;
    expect(await plainTicker(make(), byId(30), 'DAL', 'NYG')).toBe("Prescott hits Lamb for 8 yards to Dallas's 37-yard line.");
    // The model only ever sees the cleaned text.
    expect(JSON.stringify(requests[0].body.messages[1].content)).not.toMatch(/Shotgun|\(14:25\)/);
  });
  it('never lets a rewrite name a penalty, and keeps "Flag on the play"', async () => {
    const flagged = byId(40);
    expect(JSON.stringify(flagged.publicDesc)).not.toMatch(/holding/i);
    queue = [{ body: JSON.stringify({ text: 'Prescott throws deep to Lamb, incomplete, and a defender was holding.' }) }];
    expect(await plainTicker(make(), flagged, 'DAL', 'NYG')).toBe(flagged.publicDesc);
    queue = [{ body: JSON.stringify({ text: "Prescott's deep pass to Lamb falls incomplete." }) }];
    expect(await plainTicker(make(), flagged, 'DAL', 'NYG')).toBe("Prescott's deep pass to Lamb falls incomplete. Flag on the play.");
  });
});
