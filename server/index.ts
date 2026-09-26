import 'dotenv/config';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServer, ServerToClient } from '../shared/types';
import { createHttpApp } from './http';
import { attachSockets } from './sockets';
import { RoomManager } from './room/RoomManager';
import { RealClock, type Clock } from './room/clock';
import { SocketTransport } from './room/transport';
import { FamilyStore } from './persistence/families';
import { z } from 'zod';
import { LLM, configFromEnv } from './ai/llm';
import { registerP1Routes } from './p1';
import { TtsService } from './ai/tts';

export type StartOptions = { port?: number; prod?: boolean; speed?: number; clock?: Clock; families?: FamilyStore | null; quiet?: boolean };

export async function startServer(opts: StartOptions = {}): Promise<{ http: HttpServer; manager: RoomManager; port: number; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const prod = opts.prod ?? process.env.NODE_ENV === 'production';
  // speed (smoke test) divides pacing and windows inside rooms; the clock itself stays real.
  const clock = opts.clock ?? new RealClock();
  const tts = new TtsService();
  const http = createServer();
  const io = new Server<ClientToServer, ServerToClient>(http, { cors: { origin: true } });
  const manager = new RoomManager({
    clock, transport: new SocketTransport(io),
    families: opts.families === undefined ? new FamilyStore() : opts.families,
    speed: opts.speed,
    logPlays: !opts.quiet,
    tts,
  });
  // AI self-check: one tiny call at startup, so the host (and Render's logs) can see whether the model answers.
  const aiStatus: { provider: string; ok: boolean | null; ms?: number; note?: string } = { provider: configFromEnv().provider, ok: null };
  const app = createHttpApp(manager, { prod, port, clock, extra: (a) => {
    registerP1Routes(a, clock);
    a.get('/api/ai-status', (_req, res) => { res.json(aiStatus); });
    a.get('/api/tts/:lineId', async (req, res) => {
      const audio = await tts.audioFor(req.params.lineId);
      if (!audio) { res.status(404).end(); return; }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.end(audio);
    });
  } });
  http.on('request', app);
  attachSockets(io, manager);
  manager.startSweeper();
  await new Promise<void>((resolve) => http.listen(port, resolve));
  const addr = http.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  if (!opts.quiet) {
    const cfg = configFromEnv();
    console.log(`[huddle] server on :${actual} · LLM provider: ${cfg.provider}${cfg.provider === 'mock' ? ' (no key needed)' : ` · ${cfg.baseURL}`} · voice: ${tts.enabled ? `ElevenLabs (${tts.config.modelId})` : 'browser speech'}`);
    if (cfg.provider !== 'mock') {
      const llm = new LLM(clock, { cache: false });
      llm.quiet = true;
      void llm.json({
        task: 'director', model: 'smart', system: 'Return JSON only.', user: 'Reply with {"ok": true}.',
        schema: z.object({ ok: z.boolean() }), timeoutMs: 8000, fallback: () => ({ ok: false }),
      }).then((r) => {
        aiStatus.ok = r.source === 'llm' && r.value.ok;
        aiStatus.ms = Math.round(r.ms);
        aiStatus.note = llm.log[llm.log.length - 1]?.note;
        console.log(aiStatus.ok
          ? `[llm] self-check ok: ${cfg.models.smart} answered in ${aiStatus.ms} ms${llm.backupUses ? ` (via backup ${cfg.backupModel}: the primary said "model not found")` : ''}`
          : `[llm] self-check FAILED (${aiStatus.note ?? 'no answer'}): every AI job will use its template fallback. Check LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, the model names, and LLM_REASONING_EFFORT.`);
      });
    }
  }
  return {
    http, manager, port: actual,
    close: async () => {
      manager.stop();
      io.close();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

const isMain = process.argv[1] && /server[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
