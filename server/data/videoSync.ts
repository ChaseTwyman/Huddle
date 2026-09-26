import fs from 'node:fs';
import { z } from 'zod';
import { dataPath } from '../paths';

export const VideoSync = z.object({
  gameId: z.string(),
  /** play idx → video seconds at the snap */
  snaps: z.record(z.string().regex(/^\d+$/), z.number().nonnegative()),
  updatedAt: z.string().optional(),
});
export type VideoSync = z.infer<typeof VideoSync>;

export const syncFile = (id: string) => dataPath('games', id, 'video_sync.json');

/** F12: the video time of each play's snap, recorded with the sync tool. */
export function loadVideoSync(gameId: string): VideoSync {
  try {
    if (fs.existsSync(syncFile(gameId))) return VideoSync.parse(JSON.parse(fs.readFileSync(syncFile(gameId), 'utf8')));
  } catch { /* fall through to empty */ }
  return { gameId, snaps: {} };
}
