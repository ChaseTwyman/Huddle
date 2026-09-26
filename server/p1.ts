import type express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Clock } from './room/clock';
import { LLM } from './ai/llm';
import { readScorebug, scorebugChip } from './ai/vision';
import { dataPath } from './paths';
import { gameIndex } from './data/loadGame';

export const VideoSync = z.object({
  gameId: z.string(),
  /** play idx → video seconds at the snap */
  snaps: z.record(z.string().regex(/^\d+$/), z.number().nonnegative()),
  updatedAt: z.string().optional(),
});
export type VideoSync = z.infer<typeof VideoSync>;

const validGame = (id: string) => /^[\w-]+$/.test(id) && gameIndex().some((g) => g.id === id);
const syncFile = (id: string) => dataPath('games', id, 'video_sync.json');

export function loadVideoSync(gameId: string): VideoSync {
  try {
    if (fs.existsSync(syncFile(gameId))) return VideoSync.parse(JSON.parse(fs.readFileSync(syncFile(gameId), 'utf8')));
  } catch { /* fall through to empty */ }
  return { gameId, snaps: {} };
}

/** P1 routes: vision lab (F13) and video sync (F12). */
export function registerP1Routes(app: express.Express, clock: Clock) {
  const llm = new LLM(clock);

  app.post('/api/vision/scorebug', async (req, res) => {
    const image = String(req.body?.image ?? '');
    try {
      const r = await readScorebug(llm, image, typeof req.body?.hint === 'string' ? req.body.hint.slice(0, 200) : undefined);
      res.json({ ...r, chip: scorebugChip(r.value), provider: llm.config.provider });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get('/api/games/:id/video-sync', (req, res) => {
    if (!validGame(req.params.id)) { res.status(404).json({ error: 'unknown game' }); return; }
    res.json(loadVideoSync(req.params.id));
  });

  app.put('/api/games/:id/video-sync', (req, res) => {
    if (!validGame(req.params.id)) { res.status(404).json({ error: 'unknown game' }); return; }
    const parsed = VideoSync.safeParse({ ...req.body, gameId: req.params.id });
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' }); return; }
    const data = { ...parsed.data, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(syncFile(req.params.id)), { recursive: true });
    fs.writeFileSync(syncFile(req.params.id), JSON.stringify(data, null, 1));
    res.json({ ok: true, count: Object.keys(data.snaps).length });
  });
}
