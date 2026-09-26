import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Settings } from '../shared/types';
import { gameIndex } from './data/loadGame';
import type { RoomManager } from './room/RoomManager';
import { ROOT } from './paths';

export const CreateRoomBody = z.object({
  familyName: z.string().max(40).optional().nullable(),
  gameId: z.string(),
  mode: z.enum(['full', 'condensed', 'demo']).default('condensed'),
  pacing: z.enum(['gameNight', 'demo']).default('gameNight'),
  talkativeness: z.enum(['quiet', 'normal', 'chatty']).default('normal'),
  voice: z.boolean().default(true),
  fanHandicap: z.boolean().default(true),
});

export function lanHost(): string {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

export function createHttpApp(manager: RoomManager, opts: { prod: boolean; port: number; extra?: (app: express.Express) => void }) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/games', (_req, res) => { res.json(gameIndex()); });

  app.post('/api/rooms', (req, res) => {
    const parsed = CreateRoomBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const b = parsed.data;
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

  app.get('/api/lan', (_req, res) => {
    const port = opts.prod ? opts.port : 5173;
    res.json({ phoneUrlBase: `http://${lanHost()}:${port}` });
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
