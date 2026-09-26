import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { TtsService } from '../server/ai/tts';

// Fake ElevenLabs: returns MP3-ish bytes, or an error when the voice id is "bad".
const seen: { url: string; key: string | undefined; body: { text: string; model_id: string } }[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', key: req.headers['xi-api-key'] as string | undefined, body: JSON.parse(data || '{}') });
      if (req.url?.includes('/bad')) { res.writeHead(401); res.end('{"detail":"invalid api key"}'); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('ID3fake-mp3'));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server.close(); });

describe('ElevenLabs voice (server-side TTS)', () => {
  it('is off without a key, so the TV uses browser speech', () => {
    const t = new TtsService({ provider: 'browser' });
    expect(t.enabled).toBe(false);
    expect(t.register('l1', 'hello')).toBeNull();
  });

  it('synthesizes each line on the server with the key, and serves it by line id', async () => {
    const t = new TtsService({ provider: 'elevenlabs', apiKey: 'k', voiceId: 'voice1', modelId: 'eleven_flash_v2_5', baseURL: base, timeoutMs: 2000 });
    const text = `Defensive holding ${Math.random()}`;
    expect(t.register('line-1', text)).toBe('/api/tts/line-1');
    const audio = await t.audioFor('line-1');
    expect(audio?.toString()).toBe('ID3fake-mp3');
    const req = seen[seen.length - 1];
    expect(req.url).toBe('/v1/text-to-speech/voice1?output_format=mp3_44100_128');
    expect(req.key).toBe('k');
    expect(req.body).toEqual({ text, model_id: 'eleven_flash_v2_5' });
    // Same text again: served from the disk cache, no new request.
    const before = seen.length;
    t.register('line-2', text);
    expect((await t.audioFor('line-2'))?.toString()).toBe('ID3fake-mp3');
    expect(seen.length).toBe(before);
  });

  it('returns no audio on an API error so the TV falls back', async () => {
    const t = new TtsService({ provider: 'elevenlabs', apiKey: 'k', voiceId: 'bad', modelId: 'm', baseURL: base, timeoutMs: 2000 });
    t.register('x', `hi ${Math.random()}`);
    expect(await t.audioFor('x')).toBeNull();
    expect(t.audioFor('unknown')).toBeNull();
  });
});
