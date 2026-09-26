import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Settings } from '../shared/types';
import { gameIndex } from './data/loadGame';
import type { RoomManager } from './room/RoomManager';
import type { Clock } from './room/clock';
import { EspnSource, LiveGame, ReplaySource, fetchSummary, listLiveGames } from './live/feed';
import { ROOT } from './paths';

export const CreateRoomBody = z.object({
  familyName: z.string().max(40).optional().nullable(),
  gameId: z.string(),
  mode: z.enum(['full', 'condensed', 'demo']).default('condensed'),
  pacing: z.enum(['gameNight', 'demo', 'live']).default('gameNight'),
  /** F14: replay speed for "replay:<eventId>" games (1 = original timing). */
  replaySpeed: z.number().min(0.5).max(60).optional(),
  /** F14: the family's broadcast delay in seconds for "live:<eventId>" games. */
  delaySec: z.number().min(0).max(180).optional(),
  talkativeness: z.enum(['quiet', 'normal', 'chatty']).default('normal'),
  voice: z.boolean().default(true),
  fanHandicap: z.boolean().default(true),
});

const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|vbox|utun|bridge|loopback|tailscale|zerotier/i;

export function lanHost(): string {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  const candidates: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  // Prefer real Wi-Fi/Ethernet adapters and typical home-LAN ranges over virtual adapters (WSL, Hyper-V, Docker).
  const score = (c: { name: string; address: string }) =>
    (VIRTUAL.test(c.name) ? -10 : 0) + (/wi-?fi|wlan|en0|eth|ethernet/i.test(c.name) ? 3 : 0)
    + (/^192\.168\./.test(c.address) ? 2 : /^10\./.test(c.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(c.address) ? -1 : 0);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.address ?? 'localhost';
}

export function createHttpApp(manager: RoomManager, opts: { prod: boolean; port: number; clock: Clock; extra?: (app: express.Express) => void }) {
  const app = express();
  // Behind a hosting proxy (Render), trust X-Forwarded-Proto/Host so links use the public https address.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/games', (_req, res) => { res.json(gameIndex()); });

  // F14: this week's NFL games from ESPN (in progress = live; finished = can be replayed as if live).
  app.get('/api/live/games', async (req, res) => {
    const league = req.query.league === 'cfb' ? 'college' : 'nfl';
    try { res.json(await listLiveGames(league)); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });

  app.post('/api/rooms', async (req, res) => {
    const parsed = CreateRoomBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const b = parsed.data;
    // "live:<id>" / "replay:<id>" (NFL) or "live:cfb:<id>" / "replay:cfb:<id>" (college football)
    const liveMatch = /^(live|replay):(?:(nfl|cfb):)?(\d+)$/.exec(b.gameId);
    if (liveMatch) {
      try {
        const [, kind, leagueKey, eventId] = liveMatch;
        const league = leagueKey === 'cfb' ? 'college' : 'nfl';
        const first = await fetchSummary(eventId, league);
        const source = kind === 'live' ? new EspnSource(eventId, league) : new ReplaySource(first, opts.clock, b.replaySpeed ?? 1);
        const live = new LiveGame(first, source, opts.clock, 4000, league);
        if (kind === 'replay') live.data.timeline.title = live.data.timeline.title.replace('(live)', '(replay)');
        // Replays play 30 s behind the feed by default (like a streaming TV), so Predict and Call It fit before each reveal.
        live.delayMs = (b.delaySec ?? (kind === 'replay' ? 30 : 0)) * 1000;
        const settings: Settings = {
          familyName: b.familyName?.trim() || null, gameId: b.gameId, mode: 'full', pacing: 'live',
          talkativeness: b.talkativeness, voice: b.voice, fanHandicap: b.fanHandicap,
        };
        const room = manager.create(settings, live);
        live.start();
        res.json({ code: room.code, hostToken: room.hostToken });
      } catch (e) {
        res.status(502).json({ error: `Could not load that game from ESPN: ${(e as Error).message}` });
      }
      return;
    }
    if (!gameIndex().some((g) => g.id === b.gameId) && b.gameId !== 'fixture_mini') {
      res.status(404).json({ error: `Unknown game ${b.gameId}` });
      return;
    }
    const settings: Settings = {
      familyName: b.familyName?.trim() || null, gameId: b.gameId, mode: b.mode, pacing: b.pacing,
      talkativeness: b.talkativeness, voice: b.voice, fanHandicap: b.fanHandicap,
    };
    const room = manager.create(settings);
    res.json({ code: room.code, hostToken: room.hostToken });
  });

  app.get('/api/lan', (req, res) => {
    // Hosted (Render etc.): phones use the same public address the TV was opened on. PUBLIC_URL overrides.
    if (process.env.PUBLIC_URL) { res.json({ phoneUrlBase: process.env.PUBLIC_URL.replace(/\/$/, '') }); return; }
    const host = (req.get('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0].trim();
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    if (opts.prod && host && !local) { res.json({ phoneUrlBase: `${req.protocol}://${host}` }); return; }
    // On a laptop: phones reach it over the LAN address.
    const port = opts.prod ? opts.port : 5173;
    // DEV_HTTPS=1 (vite serves HTTPS so phones may use the camera): QR codes must point at https too.
    const proto = !opts.prod && process.env.DEV_HTTPS === '1' ? 'https' : 'http';
    res.json({ phoneUrlBase: `${proto}://${lanHost()}:${port}` });
  });

  opts.extra?.(app);

  if (opts.prod) {
    const dist = path.join(ROOT, 'dist', 'web');
    if (fs.existsSync(dist)) {
      app.use(express.static(dist));
      app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => { res.sendFile(path.join(dist, 'index.html')); });
    } else {
      console.warn('[huddle] dist/web not found; run npm run build');
    }
  }
  return app;
}
