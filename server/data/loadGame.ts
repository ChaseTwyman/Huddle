import fs from 'node:fs';
import type { GameIndexEntry, MomentsFile, StorylinesFile, Timeline } from '../../shared/types';
import { dataPath } from '../paths';
import { buildTimeline, type Row } from './timeline';

export type GameData = { timeline: Timeline; moments: MomentsFile; storylines: StorylinesFile };

const cache = new Map<string, GameData>();

export function gameIndex(): GameIndexEntry[] {
  const p = dataPath('games', 'index.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

export function loadGame(gameId: string): GameData {
  if (gameId === 'fixture_mini') return loadFixture();
  const hit = cache.get(gameId);
  if (hit) return hit;
  if (!/^[\w-]+$/.test(gameId)) throw new Error(`Bad game id: ${gameId}`);
  const dir = dataPath('games', gameId);
  const read = <T>(f: string, fallback?: T): T => {
    const p = `${dir}/${f}`;
    if (!fs.existsSync(p)) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing ${p}. Run: npm run fetch-game`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  };
  const data: GameData = {
    timeline: read<Timeline>('timeline.json'),
    moments: read<MomentsFile>('moments.json'),
    storylines: read<StorylinesFile>('storylines.json', { gameFacts: [], storylines: [] }),
  };
  cache.set(gameId, data);
  return data;
}

/** The hand-written test fixture, built through the real pipeline. */
export function loadFixture(): GameData {
  const hit = cache.get('fixture_mini');
  if (hit) return hit;
  const raw = JSON.parse(fs.readFileSync(dataPath('fixtures', 'mini_game.json'), 'utf8')) as {
    meta: { gameId: string; title: string; date: string }; defaults: Row; rows: Row[];
  };
  const rows = raw.rows.map((r) => ({ ...raw.defaults, ...r }));
  const storylines: StorylinesFile = {
    gameFacts: [{ text: 'This is a test game.', revealAfter: null, verified: true }],
    storylines: [
      {
        id: 'lamb', title: 'CeeDee Lamb', assignable: true, tags: ['star', 'favorite'],
        players: [{ name: 'CeeDee Lamb', team: 'DAL', position: 'wide receiver', pbpNames: ['C.Lamb'] }],
        facts: [{ text: 'Lamb is Dallas\'s top receiver.', revealAfter: null, verified: true }],
      },
      {
        id: 'barkley', title: 'Saquon Barkley', assignable: true, tags: ['underdog', 'drama'],
        players: [{ name: 'Saquon Barkley', team: 'NYG', position: 'running back', pbpNames: ['S.Barkley'] }],
        facts: [{ text: 'Barkley is New York\'s running back.', revealAfter: null, verified: true }],
      },
    ],
  };
  const { timeline, moments } = buildTimeline(rows, raw.meta, storylines.storylines);
  // The fixture has no required keys; give it one demo segment covering the whole game.
  moments.segments = [{ id: 'A', label: 'A · Whole fixture', startIdx: 0, endIdx: timeline.plays.length - 1 }];
  const data = { timeline, moments, storylines };
  cache.set('fixture_mini', data);
  return data;
}
