import type { Concept } from '../../shared/types';
import { concept } from '../data/concepts';
import type { Candidate } from './scheduler';

export type DirectorDecision =
  | { action: 'silent'; source: 'llm' | 'cache' | 'fallback' }
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
      source: 'llm' | 'cache' | 'fallback';
    };

export function sourceLine(c: Concept, extra?: string): string {
  const parts = ['Rule card', c.name];
  if (c.category === 'penalty' && c.detail) parts.push(c.detail.replace(/\.$/, ''));
  else if (extra) parts.push(extra);
  return parts.join(' · ');
}

export function cardFor(c: Concept, penaltyName?: string): { title: string; body: string } {
  const title = (penaltyName ?? c.name).slice(0, 40);
  const body = [c.full, c.detail && c.category !== 'penalty' ? c.detail : null].filter(Boolean).join(' ').slice(0, 280);
  return { title, body };
}

/**
 * Template fallback (BUILD_PROMPT 8.2): explain the top candidate with `full` or `short` from its card,
 * cheat = short. Prefer a handoff when one exists for that concept.
 */
export function templateDecision(candidates: Candidate[], handoffs: Record<string, string[]>, rawPenaltyName?: string): DirectorDecision {
  const top = candidates[0];
  if (!top) return { action: 'silent', source: 'fallback' };
  const c = concept(top.conceptId);
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
