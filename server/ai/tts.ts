import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths';
import { sha1 } from './cache';

export type TtsConfig = {
  provider: 'browser' | 'elevenlabs';
  apiKey: string;
  voiceId: string;
  modelId: string;
  baseURL: string;
  timeoutMs: number;
};

export function ttsConfigFromEnv(env = process.env): TtsConfig {
  const apiKey = env.ELEVENLABS_API_KEY || '';
  return {
    provider: env.TTS_PROVIDER === 'elevenlabs' && apiKey ? 'elevenlabs' : 'browser',
    apiKey,
    voiceId: env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    modelId: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
    baseURL: (env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, ''),
    timeoutMs: Number(env.ELEVENLABS_TIMEOUT_MS || 6000),
  };
}

/**
 * Server-side text-to-speech (ElevenLabs). The API key stays on the server: rooms register each spoken line,
 * synthesis starts immediately, and the TV fetches the MP3 from /api/tts/:lineId. Audio is cached on disk by
 * text + voice + model, so repeated lines (rule cards, announcements) are instant the second time. Any failure
 * returns null and the TV falls back to the browser voice.
 */
export class TtsService {
  readonly config: TtsConfig;
  private lines = new Map<string, { at: number; audio: Promise<Buffer | null> }>();
  private dir = dataPath('cache', 'tts');
  private warned = false;

  constructor(config: Partial<TtsConfig> = {}) {
    this.config = { ...ttsConfigFromEnv(), ...config };
    if (this.config.provider === 'browser' && process.env.TTS_PROVIDER === 'elevenlabs') {
      console.warn('[tts] TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is empty; using the browser voice.');
    }
  }

  get enabled() { return this.config.provider === 'elevenlabs'; }

  /** Register a line and start synthesizing it; returns the URL the TV should play, or null for browser speech. */
  register(lineId: string, text: string): string | null {
    if (!this.enabled) return null;
    this.prune();
    this.lines.set(lineId, { at: Date.now(), audio: this.synth(text) });
    return `/api/tts/${lineId}`;
  }

  audioFor(lineId: string): Promise<Buffer | null> | null {
    return this.lines.get(lineId)?.audio ?? null;
  }

  private prune() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, l] of this.lines) if (l.at < cutoff) this.lines.delete(id);
  }

  async synth(text: string): Promise<Buffer | null> {
    const key = sha1([this.config.voiceId, this.config.modelId, text].join('\u0000'));
    const file = path.join(this.dir, `${key}.mp3`);
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file);
    } catch { /* fall through */ }
    const started = Date.now();
    try {
      const res = await fetch(`${this.config.baseURL}/v1/text-to-speech/${encodeURIComponent(this.config.voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': this.config.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: this.config.modelId }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (!this.warned) {
          this.warned = true;
          console.warn(`[tts] ElevenLabs HTTP ${res.status}: ${body.slice(0, 160)}. Check ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID. Falling back to the browser voice.`);
        }
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`[tts] elevenlabs · ${Date.now() - started}ms · ${text.split(/\s+/).length} words`);
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, buf);
      } catch { /* cache is best effort */ }
      return buf;
    } catch (e) {
      console.warn(`[tts] ElevenLabs failed after ${Date.now() - started}ms: ${(e as Error).message}`);
      return null;
    }
  }
}
