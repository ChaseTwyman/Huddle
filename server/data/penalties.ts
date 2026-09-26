import fs from 'node:fs';
import { dataPath } from '../paths';

type Entry = { match: string; conceptId: string; side: 'offense' | 'defense' | null };

let entries: Entry[] | null = null;

function load(): Entry[] {
  if (!entries) {
    const file = JSON.parse(fs.readFileSync(dataPath('penalties.json'), 'utf8')) as { map: Entry[] };
    // Longest match first so "Defensive Too Many Men on Field" wins over "Too Many Men on Field".
    entries = [...file.map].sort((a, b) => b.match.length - a.match.length);
  }
  return entries;
}

export function normalizePenaltyType(s: string): string {
  return s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export type PenaltyMapping = { conceptId: string; side: 'offense' | 'defense' | null; known: boolean };

export function mapPenaltyType(rawType: string): PenaltyMapping {
  const norm = normalizePenaltyType(rawType);
  const list = load();
  const exact = list.find((e) => normalizePenaltyType(e.match) === norm);
  if (exact) return { conceptId: exact.conceptId, side: exact.side, known: true };
  const partial = list.find((e) => norm.includes(normalizePenaltyType(e.match)));
  if (partial) return { conceptId: partial.conceptId, side: partial.side, known: true };
  return { conceptId: 'penalty_other', side: null, known: false };
}

/** Concepts where only defensive fouls carry an automatic first down. */
export const AUTO_FIRST_DOWN_ON_DEFENSE = new Set(['illegal_use_of_hands', 'unnecessary_roughness', 'face_mask']);
