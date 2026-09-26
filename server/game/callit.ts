import type { PromptOption, TimelinePlay } from '../../shared/types';
import { concept, concepts } from '../data/concepts';
import { shuffle } from './rng';

export type PlayCategory = 'preSnap' | 'pass' | 'run' | 'kick' | 'other';

export const FALLBACK: Record<PlayCategory, string[]> = {
  preSnap: ['false_start', 'offside', 'neutral_zone_infraction', 'encroachment', 'delay_of_game', 'illegal_formation', 'illegal_shift'],
  pass: ['pass_interference_defensive', 'holding_defensive', 'illegal_contact', 'pass_interference_offensive', 'holding_offensive', 'roughing_the_passer', 'intentional_grounding'],
  run: ['holding_offensive', 'face_mask', 'unnecessary_roughness', 'illegal_block_in_the_back', 'holding_defensive', 'tripping'],
  kick: ['illegal_block_in_the_back', 'holding_offensive', 'roughing_the_kicker', 'running_into_the_kicker', 'fair_catch_interference', 'face_mask'],
  other: ['holding_offensive', 'unnecessary_roughness', 'unsportsmanlike_conduct', 'face_mask'],
};

export function playCategory(play: TimelinePlay): PlayCategory {
  if (play.kind === 'penalty_only' || play.penalty?.preSnap) return 'preSnap';
  if (play.kind === 'pass') return 'pass';
  if (play.kind === 'two_point') return /\bpass\b/i.test(play.publicDesc) ? 'pass' : 'run';
  if (play.kind === 'run' || play.kind === 'kneel') return 'run';
  if (play.kind === 'punt' || play.kind === 'field_goal' || play.kind === 'extra_point' || play.kind === 'kickoff') return 'kick';
  return 'other';
}

/** Every specific penalty concept (the catalog distractors must come from). */
export function penaltyCatalog(): string[] {
  return [...concepts().values()].filter((c) => c.category === 'penalty' && c.priority === 100).map((c) => c.id);
}

/** Catalog shown to the LLM: the play-type list first, then the rest. */
export function catalogFor(play: TimelinePlay): string[] {
  const cat = FALLBACK[playCategory(play)];
  return [...cat, ...penaltyCatalog().filter((id) => !cat.includes(id))];
}

/** Validate LLM distractors: exactly 3, distinct, in the catalog, none equal to the correct concept. */
export function validDistractors(list: unknown, correct: string): list is string[] {
  if (!Array.isArray(list) || list.length !== 3) return false;
  const catalog = new Set(penaltyCatalog());
  const set = new Set(list);
  if (set.size !== 3) return false;
  return list.every((id) => typeof id === 'string' && catalog.has(id) && id !== correct);
}

export function fallbackDistractors(play: TimelinePlay, correct: string): string[] {
  const pool = FALLBACK[playCategory(play)].filter((id) => id !== correct);
  const extra = FALLBACK.other.filter((id) => id !== correct && !pool.includes(id));
  return shuffle([...pool], play.idx * 7919 + 1).concat(extra).slice(0, 3);
}

export type CallItRound = {
  options: PromptOption[];
  correctOptionId: string;
  distractors: string[];
  source: 'llm' | 'cache' | 'fallback';
};

/**
 * F5: four options (correct + 3 distractors), shuffled with a seeded RNG (seed = play idx).
 * Option ids are opaque letters so nothing but the four labels reaches clients.
 */
export function buildCallIt(play: TimelinePlay, llmDistractors: unknown, source: 'llm' | 'cache' | 'fallback' = 'llm'): CallItRound {
  const pen = play.penalty;
  if (!pen) throw new Error('buildCallIt on a play without a flag');
  const correct = pen.conceptId;
  let distractors: string[];
  let src = source;
  if (validDistractors(llmDistractors, correct)) distractors = llmDistractors;
  else { distractors = fallbackDistractors(play, correct); src = 'fallback'; }
  const label = (id: string) => (id === correct && id === 'penalty_other' ? pen.rawType : concept(id).name);
  const ids = shuffle([correct, ...distractors], play.idx);
  const letters = ['a', 'b', 'c', 'd'];
  const options = ids.map((id, i) => ({ id: letters[i], label: label(id) }));
  const correctOptionId = letters[ids.indexOf(correct)];
  return { options, correctOptionId, distractors, source: src };
}
