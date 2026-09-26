import type { Concept, League } from '../../shared/types';
import { concept } from '../data/concepts';
import type { IntelFact, IntelKind } from '../intel/types';
import type { Candidate } from './scheduler';

export type DirectorDecision =
  | { action: 'silent'; source: 'llm' | 'cache' | 'fallback' }
  | {
      /** A grounded line from game intelligence (not a rule), e.g. a surprising number or a player's backstory. */
      action: 'insight';
      spoken: string;
      card: { title: string; body: string };
      /** Intel fact ids used; the room never says a cited fact again. */
      cites: string[];
      /** Card source line, from the cited facts. */
      sourceNote: string;
      fanNote?: string;
      source: 'llm' | 'cache' | 'fallback';
    }
  | {
      action: 'explain' | 'handoff';
      conceptId: string;
      depth: 'full' | 'short';
      spoken: string;
      /** Huddle's short version, used after "Still confused" or a declined handoff. */
      shortSpoken: string;
      card: { title: string; body: string };
      cheat: string;
      handoffTo?: string;
      fanNote?: string;
      cites?: string[];
      source: 'llm' | 'cache' | 'fallback';
    };

export type InsightDecision = Extract<DirectorDecision, { action: 'insight' }>;

/** Weight at which a fact is interesting enough to say on its own (template insight). */
export const INSIGHT_WEIGHT = 0.6;
export const INSIGHT_MAX_WORDS = 25;

const INSIGHT_TITLES: Record<IntelKind, string> = {
  win_prob: 'By the numbers', decision: 'By the numbers', drive: 'This drive', game_stat: 'Tonight so far',
  tendency: 'Tonight so far', bio: 'Backstory', career: 'Backstory', matchup: 'Matchup', rivalry: 'Matchup', team: 'Team history',
};

export function insightSource(facts: IntelFact[]): string {
  const srcs = [...new Set(facts.map((f) => f.source ?? 'play-by-play'))];
  return ['Huddle intel', ...srcs.map((s) => s.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])].join(' · ');
}

export function insightCard(facts: IntelFact[]): { title: string; body: string } {
  return { title: INSIGHT_TITLES[facts[0].kind], body: facts.map((f) => f.text).join(' ').slice(0, 280) };
}

/** A fact said verbatim: it is already one grounded sentence, safe to say aloud. */
export function insightFromFact(f: IntelFact, source: InsightDecision['source'] = 'fallback'): InsightDecision {
  return { action: 'insight', spoken: f.text, card: insightCard([f]), cites: [f.id], sourceNote: insightSource([f]), source };
}

export function sourceLine(c: Concept, extra?: string): string {
  const parts = ['Rule card', c.name];
  if (c.category === 'penalty' && c.detail) parts.push(c.detail.replace(/\.$/, ''));
  else if (extra) parts.push(extra);
  return parts.join(' · ');
}

export function cardFor(c: Concept, penaltyName?: string): { title: string; body: string } {
  const title = (penaltyName ?? c.name).slice(0, 40);
  // The card's `detail` restates `full` in fewer words; showing both reads as a repeat.
  const body = c.full.slice(0, 280);
  return { title, body };
}

/**
 * Template fallback (BUILD_PROMPT 8.2): explain the top candidate with `full` or `short` from its card,
 * cheat = short. Prefer a handoff when one exists for that concept.
 */
export function templateDecision(candidates: Candidate[], handoffs: Record<string, string[]>, rawPenaltyName?: string, league: League = 'nfl'): Exclude<DirectorDecision, InsightDecision> {
  const top = candidates[0];
  if (!top) return { action: 'silent', source: 'fallback' };
  const c = concept(top.conceptId, league);
  const name = top.conceptId === 'penalty_other' && rawPenaltyName ? rawPenaltyName : undefined;
  const spokenFull = name ? `That was ${name}. ${c.full}` : c.full;
  const spoken = top.depth === 'full' ? spokenFull : c.short;
  const who = handoffs[top.conceptId]?.[0];
  return {
    action: who ? 'handoff' : 'explain',
    conceptId: top.conceptId,
    depth: top.depth,
    spoken: who ? c.short : spoken,
    shortSpoken: c.short,
    card: cardFor(c, name),
    cheat: c.short,
    ...(who ? { handoffTo: who } : {}),
    source: 'fallback',
  };
}
