import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { AiLogEntry } from '../../shared/types';
import type { Clock } from '../room/clock';
import { sleep } from '../room/clock';
import { LlmCache, sha1 } from './cache';
import { Limiter } from './limiter';

export type TaskName = 'storylines' | 'callit' | 'director' | 'beat' | 'recap' | 'ticker' | 'scorebug';
export type ModelRole = 'smart' | 'fast' | 'vision';
export type Source = 'llm' | 'cache' | 'fallback';

export type JsonOpts<T> = {
  task: TaskName; model: ModelRole;
  system: string; user: string; images?: string[];
  schema: z.ZodType<T>; timeoutMs: number; temperature?: number; fallback: () => T;
};

export type LlmCallRecord = { task: TaskName; model: ModelRole; system: string; user: string; at: number };

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type LlmConfig = {
  provider: 'mock' | 'openai_compatible' | 'anthropic';
  baseURL: string; apiKey: string;
  models: Record<ModelRole, string>;
  cache: boolean; maxConcurrency: number;
  /** Anthropic only: effort for these short, latency-bound JSON jobs. */
  effort: Effort;
  /**
   * OpenAI-compatible reasoning models only (sent as `reasoning_effort`). Meta's muse-spark-1.3 reasons ~7 s per
   * call at its default, longer than every job's time limit, so every call fell back to templates; "minimal"
   * answers in ~2 s. Empty = don't send the parameter.
   */
  reasoningEffort?: string;
};

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

export function configFromEnv(env = process.env): LlmConfig {
  const provider = env.LLM_PROVIDER === 'openai_compatible' ? 'openai_compatible' : env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'mock';
  const shared = { cache: (env.LLM_CACHE ?? 'on') !== 'off', maxConcurrency: Number(env.LLM_MAX_CONCURRENCY || 4) };
  const effort = (['low', 'medium', 'high', 'xhigh', 'max'] as const).find((e) => e === env.ANTHROPIC_EFFORT) ?? 'low';
  if (provider === 'anthropic') {
    return {
      provider, baseURL: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', apiKey: env.ANTHROPIC_API_KEY || '', effort, ...shared,
      models: {
        smart: env.ANTHROPIC_MODEL_SMART || DEFAULT_CLAUDE_MODEL,
        fast: env.ANTHROPIC_MODEL_FAST || DEFAULT_CLAUDE_MODEL,
        vision: env.ANTHROPIC_MODEL_VISION || env.ANTHROPIC_MODEL_FAST || DEFAULT_CLAUDE_MODEL,
      },
    };
  }
  const baseURL = env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
  return {
    provider, effort, ...shared,
    reasoningEffort: env.LLM_REASONING_EFFORT ?? (/api\.meta\.ai/.test(baseURL) ? 'minimal' : ''),
    baseURL,
    apiKey: env.LLM_API_KEY || '',
    models: {
      smart: env.LLM_MODEL_SMART || '',
      fast: env.LLM_MODEL_FAST || '',
      vision: env.LLM_MODEL_VISION || env.LLM_MODEL_FAST || '',
    },
  };
}

type Turn = { role: 'user' | 'assistant'; text: string };

const PRIORITY: Record<TaskName, number> = { callit: 3, director: 3, beat: 2, storylines: 2, recap: 2, ticker: 1, scorebug: 1 };

/** Pull the first JSON object out of model text (strips code fences). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf('{');
  if (start < 0) throw new Error('no JSON object in response');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in response');
}

class Timeout extends Error {}

/**
 * JSON-only LLM client (BUILD_PROMPT 10.1): OpenAI-compatible provider or a mock that returns the
 * template fallback after a short delay. Every call has a timeout, zod validation, at most one retry
 * on invalid JSON, and a fallback. The caller never waits longer than timeoutMs.
 */
export class LLM {
  readonly config: LlmConfig;
  private client: OpenAI | null = null;
  private anthropic: Anthropic | null = null;
  private cache: LlmCache;
  private limiter: Limiter;
  private backoffUntil = new Map<TaskName, number>();
  private warnedModels = new Set<string>();
  private noResponseFormat = false;
  private mockSeq = 0;
  readonly log: AiLogEntry[] = [];
  onLog: ((log: AiLogEntry[]) => void) | null = null;
  /** Called with every model input (tests use this to check spoilers). */
  onCall: ((rec: LlmCallRecord) => void) | null = null;
  quiet = false;

  constructor(private clock: Clock, config: Partial<LlmConfig> = {}, private track?: (p: Promise<unknown>) => void) {
    this.config = { ...configFromEnv(), ...config };
    this.cache = new LlmCache(this.config.cache && this.config.provider !== 'mock');
    this.limiter = new Limiter(Math.max(1, this.config.maxConcurrency));
    if (this.config.provider === 'openai_compatible') {
      if (!this.config.apiKey) console.warn('[llm] LLM_PROVIDER=openai_compatible but LLM_API_KEY is empty; calls will fall back to templates.');
      this.client = new OpenAI({ baseURL: this.config.baseURL, apiKey: this.config.apiKey || 'missing', maxRetries: 0 });
    }
    if (this.config.provider === 'anthropic') {
      if (!this.config.apiKey) console.warn('[llm] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty; calls will fall back to templates.');
      // maxRetries 0: every job has its own short timeout and a template fallback.
      this.anthropic = new Anthropic({ apiKey: this.config.apiKey || 'missing', baseURL: this.config.baseURL, maxRetries: 0 });
    }
  }

  get isMock() { return this.config.provider === 'mock'; }

  private record(task: TaskName, source: Source, ms: number, note?: string) {
    const entry: AiLogEntry = { at: this.clock.now(), task, source, ms: Math.round(ms), ...(note ? { note } : {}) };
    this.log.push(entry);
    if (this.log.length > 50) this.log.shift();
    if (!this.quiet) console.log(`[llm] ${task} · ${source} · ${Math.round(ms)}ms${note ? ` · ${note}` : ''}`);
    this.onLog?.(this.log);
  }

  async json<T>(opts: JsonOpts<T>): Promise<{ value: T; source: Source; ms: number }> {
    const started = this.clock.now();
    const done = (value: T, source: Source, note?: string) => {
      const ms = this.clock.now() - started;
      this.record(opts.task, source, ms, note);
      return { value, source, ms };
    };
    this.onCall?.({ task: opts.task, model: opts.model, system: opts.system, user: opts.user, at: started });

    if (this.isMock || (!this.client && !this.anthropic)) {
      const delay = 50 + ((this.mockSeq++ * 37) % 101);
      await sleep(this.clock, Math.min(delay, opts.timeoutMs));
      return done(opts.fallback(), 'fallback', this.isMock ? 'mock' : 'no client');
    }
    const until = this.backoffUntil.get(opts.task) ?? 0;
    if (this.clock.now() < until) return done(opts.fallback(), 'fallback', 'rate-limit backoff');

    const model = this.config.models[opts.model];
    const key = this.cache.key({ task: opts.task, model, system: opts.system, user: opts.user, images: opts.images });
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      const parsed = opts.schema.safeParse(cached);
      if (parsed.success) return done(parsed.data, 'cache');
    }

    const deadline = started + opts.timeoutMs;
    const controller = new AbortController();
    let handle: ReturnType<Clock['setTimeout']> | null = null;
    const timer = new Promise<never>((_, rej) => {
      handle = this.clock.setTimeout(() => { controller.abort(); rej(new Timeout('timeout')); }, opts.timeoutMs);
    });
    timer.catch(() => undefined);
    const work = this.limiter.run(PRIORITY[opts.task], () => this.callWithRetry(opts, model, deadline, controller.signal));
    work.catch(() => undefined);
    this.track?.(work.catch(() => undefined));
    try {
      const value = await Promise.race([work, timer]);
      this.cache.set(key, value);
      return done(value, 'llm');
    } catch (err) {
      return done(opts.fallback(), 'fallback', this.describe(err, opts.task, model));
    } finally {
      this.clock.clearTimeout(handle);
    }
  }

  private describe(err: unknown, task: TaskName, model: string): string {
    if (err instanceof Timeout) return 'timeout';
    const e = err as { status?: number; message?: string };
    const msg = e?.message ?? String(err);
    if (e?.status === 429) {
      this.backoffUntil.set(task, this.clock.now() + 10_000);
      return 'HTTP 429: backing off 10 s';
    }
    if (e?.status === 404 || /model.*(not found|does not exist)|not_found/i.test(msg)) {
      if (!this.warnedModels.has(model)) {
        this.warnedModels.add(model);
        console.warn(`[llm] Model "${model}" was not found. Check the provider's model list: GET ${this.config.baseURL}/${this.anthropic ? 'v1/' : ''}models and update the model settings in .env. Continuing with template fallbacks.`);
      }
      return 'model not found';
    }
    if (e?.status === 401) return `HTTP 401: check ${this.anthropic ? 'ANTHROPIC_API_KEY' : 'LLM_API_KEY'}`;
    return msg.slice(0, 120);
  }

  private async callWithRetry<T>(opts: JsonOpts<T>, model: string, deadline: number, signal: AbortSignal): Promise<T> {
    const turns: Turn[] = [{ role: 'user', text: opts.user }];
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        if (this.clock.now() >= deadline - 300) break;
        turns.push({ role: 'user', text: `Your previous reply was not valid: ${lastError}. Return corrected JSON only.` });
      }
      const text = this.anthropic
        ? await this.completeAnthropic(model, opts.system, turns, opts.images, signal)
        : await this.complete(model, this.openAiMessages(opts.system, turns, opts.images), opts.temperature ?? 0.3, signal, !!opts.images?.length);
      if (attempt === 0) turns.push({ role: 'assistant', text });
      let raw: unknown;
      try {
        raw = extractJson(text);
      } catch (e) {
        lastError = (e as Error).message;
        continue;
      }
      const parsed = opts.schema.safeParse(raw);
      if (parsed.success) return parsed.data;
      lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300);
    }
    throw new Error(`invalid JSON after retry: ${lastError}`);
  }

  private openAiMessages(system: string, turns: Turn[], images?: string[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return [
      { role: 'system', content: system },
      ...turns.map((t, i): OpenAI.Chat.Completions.ChatCompletionMessageParam => (t.role === 'assistant'
        ? { role: 'assistant', content: t.text }
        : {
            role: 'user',
            content: i === 0 && images?.length
              ? [{ type: 'text', text: t.text }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
              : t.text,
          })),
    ];
  }

  /**
   * Claude via the official Anthropic SDK. The prompts already demand "JSON only", and zod + one corrective
   * retry validate the reply, same as the OpenAI-compatible path. No temperature (current Claude models reject
   * sampling parameters); effort defaults to low for these short, latency-bound jobs. Server-side refusal
   * fallback is on; a refusal that survives it is thrown so the job uses its template.
   */
  private async completeAnthropic(model: string, system: string, turns: Turn[], images: string[] | undefined, signal: AbortSignal): Promise<string> {
    const imageBlocks = (images ?? []).map((url) => {
      const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(url);
      if (!m) throw new Error('images must be base64 data URLs');
      return { type: 'image' as const, source: { type: 'base64' as const, media_type: m[1] as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: m[2] } };
    });
    const res = await this.anthropic!.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        system,
        messages: turns.map((t, i) => (i === 0 && imageBlocks.length
          ? { role: t.role, content: [...imageBlocks, { type: 'text' as const, text: t.text }] }
          : { role: t.role, content: t.text })),
        output_config: { effort: this.config.effort },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );
    if (res.stop_reason === 'refusal') throw new Error(`refusal${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}`);
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }

  private async complete(model: string, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], temperature: number, signal: AbortSignal, hasImages: boolean): Promise<string> {
    const client = this.client!;
    const useFormat = !this.noResponseFormat && !hasImages;
    const reasoning = this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {};
    try {
      const res = await client.chat.completions.create(
        { model, messages, temperature, ...reasoning, ...(useFormat ? { response_format: { type: 'json_object' as const } } : {}) } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal },
      );
      const choice = res.choices[0];
      // A reasoning model that spends its whole budget thinking returns no content; say so instead of "invalid JSON".
      if (!choice?.message?.content && choice?.finish_reason === 'length') throw new Error('no answer: the model used its whole token budget reasoning (set LLM_REASONING_EFFORT=minimal)');
      return choice?.message?.content ?? '';
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (useFormat && e?.status === 400 && /response_format|json/i.test(e.message ?? '')) {
        this.noResponseFormat = true;
        const res = await client.chat.completions.create({ model, messages, temperature }, { signal });
        return res.choices[0]?.message?.content ?? '';
      }
      throw err;
    }
  }
}

export const imageHash = (images: string[]) => sha1(images.join('|'));
