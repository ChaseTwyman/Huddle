import { z } from 'zod';

export const StorylinesOut = z.object({
  assignments: z.array(z.object({
    playerId: z.string(), storylineId: z.string(), hook: z.string(), watchFor: z.string(),
  })),
});
export type StorylinesOut = z.infer<typeof StorylinesOut>;

export const CallItOut = z.object({ distractors: z.array(z.string()), why: z.string().optional() });
export type CallItOut = z.infer<typeof CallItOut>;

export const DirectorOut = z.object({
  action: z.enum(['silent', 'explain', 'handoff']),
  conceptId: z.string().optional(),
  spoken: z.string().optional(),
  card: z.object({ title: z.string(), body: z.string() }).optional(),
  cheat: z.string().optional(),
  handoffTo: z.string().optional(),
  fanNote: z.string().optional(),
});
export type DirectorOut = z.infer<typeof DirectorOut>;

export const BeatOut = z.object({ line: z.string() });
export type BeatOut = z.infer<typeof BeatOut>;

export const RecapOut = z.object({
  people: z.array(z.object({ playerId: z.string(), headline: z.string(), bestMoment: z.string() })),
  family: z.object({ title: z.string(), momentOfTheNight: z.string(), nextTime: z.string() }),
});
export type RecapOut = z.infer<typeof RecapOut>;

export const TickerOut = z.object({ text: z.string() });
export type TickerOut = z.infer<typeof TickerOut>;

const n = z.number().nullable();
const s = z.string().nullable();
export const ScorebugOut = z.object({
  visible: z.boolean(),
  awayTeam: s, homeTeam: s, awayScore: n, homeScore: n,
  quarter: z.union([z.number(), z.string()]).nullable(), clock: s,
  down: z.union([z.number(), z.string()]).nullable(), distance: z.union([z.number(), z.string()]).nullable(),
  flag: z.boolean(), replayReview: z.boolean(), confidence: z.number(),
});
export type ScorebugOut = z.infer<typeof ScorebugOut>;

export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
