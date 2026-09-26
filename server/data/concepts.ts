import fs from 'node:fs';
import type { Concept } from '../../shared/types';
import { dataPath } from '../paths';

let cache: Map<string, Concept> | null = null;

export function concepts(): Map<string, Concept> {
  if (!cache) {
    const list = JSON.parse(fs.readFileSync(dataPath('concepts.json'), 'utf8')) as Concept[];
    cache = new Map(list.map((c) => [c.id, c]));
  }
  return cache;
}

export function concept(id: string): Concept {
  const c = concepts().get(id);
  if (!c) throw new Error(`Unknown concept id: ${id}`);
  return c;
}

export function hasConcept(id: string): boolean {
  return concepts().has(id);
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
