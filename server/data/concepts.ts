import fs from 'node:fs';
import type { Concept, League } from '../../shared/types';
import { dataPath } from '../paths';

let cache: Map<string, Concept> | null = null;
let college: Map<string, Concept> | null = null;

export function concepts(): Map<string, Concept> {
  if (!cache) {
    const list = JSON.parse(fs.readFileSync(dataPath('concepts.json'), 'utf8')) as Concept[];
    cache = new Map(list.map((c) => [c.id, c]));
  }
  return cache;
}

/** College cards: the base card with data/concepts.college.json overrides merged in. */
function collegeConcepts(): Map<string, Concept> {
  if (!college) {
    const overrides = JSON.parse(fs.readFileSync(dataPath('concepts.college.json'), 'utf8')) as Record<string, Partial<Concept>>;
    college = new Map([...concepts()].map(([id, c]) => [id, { ...c, ...(overrides[id] ?? {}) }]));
  }
  return college;
}

/** The rule card for a concept, as it applies in the given league (default NFL). */
export function concept(id: string, league: League = 'nfl'): Concept {
  const c = (league === 'college' ? collegeConcepts() : concepts()).get(id);
  if (!c) throw new Error(`Unknown concept id: ${id}`);
  return c;
}

export function hasConcept(id: string): boolean {
  return concepts().has(id);
}

/** Does this rule exist in the league? (e.g. illegal contact is NFL-only, targeting college-only.) */
export function inLeague(id: string, league: League = 'nfl'): boolean {
  const c = concepts().get(id);
  return !!c && (!c.leagues || c.leagues.includes(league));
}

export function priority(id: string): number {
  return concepts().get(id)?.priority ?? 0;
}

export function sortByPriority(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  // Stable: ties keep insertion order.
  return unique
    .map((id, i) => ({ id, i, p: priority(id) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.id);
}

export function penaltyConceptIds(): string[] {
  return [...concepts().values()].filter((c) => c.category === 'penalty' && c.priority >= 90).map((c) => c.id);
}
