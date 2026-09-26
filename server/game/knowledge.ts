import type { KnowledgeEntry, KnowledgeLevel, KnowledgeMap } from '../../shared/types';
import { concepts } from '../data/concepts';

export const LEVELS: KnowledgeLevel[] = ['new', 'seen', 'familiar', 'mastered'];
export const levelRank = (l: KnowledgeLevel) => LEVELS.indexOf(l);

const empty = (): KnowledgeEntry => ({ exposures: 0, recalls: 0, explainedToRoom: false });

/** F8 thresholds (BUILD_PROMPT 7.6). */
export function level(e: KnowledgeEntry | undefined): KnowledgeLevel {
  if (!e) return 'new';
  if ((e.exposures >= 3 && e.recalls >= 1) || e.recalls >= 2 || e.explainedToRoom) return 'mastered';
  if (e.exposures >= 2 || e.recalls >= 1) return 'familiar';
  if (e.exposures >= 1) return 'seen';
  return 'new';
}

export const levelOf = (k: KnowledgeMap, conceptId: string) => level(k[conceptId]);

function entry(k: KnowledgeMap, id: string): KnowledgeEntry {
  if (!k[id]) k[id] = empty();
  return k[id];
}

export function addExposure(k: KnowledgeMap, id: string) { entry(k, id).exposures++; }
export function addRecall(k: KnowledgeMap, id: string) { entry(k, id).recalls++; }
export function markExplained(k: KnowledgeMap, id: string) { entry(k, id).explainedToRoom = true; }

/** Room level = the lowest level among connected learners (mastered if there are none). */
export function roomLevel(learners: KnowledgeMap[], conceptId: string): KnowledgeLevel {
  if (!learners.length) return 'mastered';
  return learners.map((k) => levelOf(k, conceptId)).reduce((lo, l) => (levelRank(l) < levelRank(lo) ? l : lo), 'mastered' as KnowledgeLevel);
}

/** Learners at Familiar or Mastered on a concept while another connected learner is below them. */
export function handoffCandidates(learners: { id: string; knowledge: KnowledgeMap }[], conceptId: string): string[] {
  return learners
    .filter((l) => levelRank(levelOf(l.knowledge, conceptId)) >= levelRank('familiar'))
    .filter((l) => learners.some((o) => o.id !== l.id && levelRank(levelOf(o.knowledge, conceptId)) < levelRank(levelOf(l.knowledge, conceptId))))
    .map((l) => l.id);
}

export type Preset = { id: string; label: string; slots: { mastered: string[]; familiar: string[]; seen: string[] }[] };

function expand(ids: string[]): string[] {
  return ids.flatMap((id) => (id === 'basics' ? [...concepts().values()].filter((c) => c.category === 'basics').map((c) => c.id) : [id]));
}

const SEED: Record<'seen' | 'familiar' | 'mastered', KnowledgeEntry> = {
  seen: { exposures: 1, recalls: 0, explainedToRoom: false },
  familiar: { exposures: 2, recalls: 0, explainedToRoom: false },
  mastered: { exposures: 3, recalls: 1, explainedToRoom: false },
};

/** Knowledge for the learner in join-order slot `slot` (0-based). Slots past the end reuse the last. */
export function presetKnowledge(preset: Preset, slot: number): KnowledgeMap {
  const s = preset.slots[Math.min(slot, preset.slots.length - 1)];
  const k: KnowledgeMap = {};
  if (!s) return k;
  for (const lvl of ['seen', 'familiar', 'mastered'] as const) {
    for (const id of expand(s[lvl])) k[id] = { ...SEED[lvl] };
  }
  return k;
}

/** Concepts at Familiar or Mastered now that were below Familiar in `before`. */
export function learnedSince(before: KnowledgeMap, now: KnowledgeMap): string[] {
  return Object.keys(now).filter((id) => levelRank(levelOf(now, id)) >= 2 && levelRank(levelOf(before, id)) < 2);
}

export function countKnown(k: KnowledgeMap): number {
  return Object.keys(k).filter((id) => levelRank(levelOf(k, id)) >= 2).length;
}
