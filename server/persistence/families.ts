import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeMap } from '../../shared/types';
import { dataPath } from '../paths';

export type FamilyPlayer = { knowledge: KnowledgeMap; lifetimePoints: number; games: number };
export type FamilyFile = { familyName: string; players: Record<string, FamilyPlayer>; games: { gameId: string; date: string }[] };

export const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'family';

/** F8 season memory: one JSON file per family in data/families/. */
export class FamilyStore {
  constructor(private dir = dataPath('families')) {}

  private file(familyName: string) { return path.join(this.dir, `${slug(familyName)}.json`); }

  load(familyName: string): FamilyFile {
    try {
      const f = this.file(familyName);
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) as FamilyFile;
    } catch (e) {
      console.warn(`[families] could not read ${familyName}: ${(e as Error).message}`);
    }
    return { familyName, players: {}, games: [] };
  }

  save(data: FamilyFile) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(data.familyName), JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn(`[families] could not save ${data.familyName}: ${(e as Error).message}`);
    }
  }
}
