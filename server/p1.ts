import type express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './room/clock';
import { LLM } from './ai/llm';
import { readScorebug, scorebugChip } from './ai/vision';
import { gameIndex, loadGame } from './data/loadGame';
import { VideoSync, loadVideoSync, syncFile } from './data/videoSync';

const validGame = (id: string) => /^[\w-]+$/.test(id) && gameIndex().some((g) => g.id === id);

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

  // Team authoring tool only (the sync page): lists plays with their public text so snaps can be matched to video.
  app.get('/api/games/:id/sync-plays', (req, res) => {
    if (!validGame(req.params.id)) { res.status(404).json({ error: 'unknown game' }); return; }
    const plays = loadGame(req.params.id).timeline.plays
      .filter((p) => p.kind !== 'end_of_period' && p.kind !== 'timeout')
      .map((p) => ({ idx: p.idx, qtr: p.qtr, clock: p.clock, posteam: p.posteam, situation: p.down ? `${p.down} & ${p.goalToGo ? 'Goal' : p.ydstogo}` : p.kind, text: p.publicDesc }));
    res.json(plays);
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
