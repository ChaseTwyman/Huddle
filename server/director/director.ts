import type { League, TeamInfo, TimelinePlay } from '../../shared/types';
import { teamOf } from '../../shared/teams';
import { concept } from '../data/concepts';
import { ballOn, downDistance } from '../data/timeline';
import type { LLM } from '../ai/llm';
import { DIRECTOR_SYSTEM } from '../ai/prompts';
import { DirectorOut, words } from '../ai/schemas';
import type { Candidate, Trigger } from './scheduler';
import { templateDecision, type DirectorDecision } from './templates';

export type DirectorInput = {
  play: TimelinePlay;
  trigger: Trigger;
  candidates: Candidate[];
  /** conceptId → player ids who could explain it. */
  handoffs: Record<string, string[]>;
  names: Record<string, string>;
  playerFacts: string[];
  recentLines: string[];
  budget: { remainingThisQuarter: number; exempt: boolean };
  announced: boolean;
  league?: League;
  teams?: Record<string, TeamInfo>;
};

export function situation(play: TimelinePlay, home: string, away: string, teams?: Record<string, TeamInfo>) {
  const score = `${teamOf(away, teams).city} ${play.scoreAfter.away}, ${teamOf(home, teams).city} ${play.scoreAfter.home}`;
  return {
    quarter: play.qtr, clock: play.clock, score,
    possession: play.posteam ? teamOf(play.posteam, teams).city : null,
    downAndDistance: downDistance(play), ballOn: ballOn(play),
  };
}

/** The Director's user message. Only spoiler-safe fields: public play text, and the announcement once made. */
export function directorUserMessage(input: DirectorInput, home: string, away: string): string {
  const { play } = input;
  const msg = {
    event: input.trigger === 'penalty' ? 'penalty_announced' : input.trigger === 'decision' ? 'decision_result' : 'dead_time',
    situation: situation(play, home, away, input.teams),
    league: input.league === 'college' ? 'college football' : 'NFL',
    play: {
      description: play.publicDesc,
      ...(input.announced && play.penalty ? { refereeAnnouncement: play.penalty.announcement } : {}),
    },
    candidates: input.candidates.map((c) => {
      const card = concept(c.conceptId, input.league);
      return {
        conceptId: c.conceptId, name: card.name, roomLevel: c.roomLevel,
        ruleCard: { full: card.full, short: card.short, ...(card.detail ? { detail: card.detail } : {}) },
      };
    }),
    handoffCandidates: Object.entries(input.handoffs).flatMap(([conceptId, ids]) => ids.map((playerId) => ({ playerId, name: input.names[playerId], conceptId }))),
    playerFacts: input.playerFacts,
    recentLines: input.recentLines.slice(-5),
    budget: input.budget,
  };
  return JSON.stringify(msg, null, 1);
}

/** Check an LLM decision against the rules; returns null if it must be replaced by the template. */
export function validateDecision(out: DirectorOut, input: DirectorInput): DirectorDecision | null {
  if (out.action === 'silent') return { action: 'silent', source: 'llm' };
  const cand = input.candidates.find((c) => c.conceptId === out.conceptId);
  if (!cand || !out.spoken || !out.card || !out.cheat) return null;
  const limit = cand.depth === 'full' ? 28 : 12;
  if (words(out.spoken) > limit || words(out.spoken) === 0) return null;
  if (out.card.title.length > 40 || out.card.body.length > 280 || out.cheat.length > 120) return null;
  if (out.fanNote && out.fanNote.length > 200) return null;
  if (out.action === 'handoff' && (!out.handoffTo || !input.handoffs[cand.conceptId]?.includes(out.handoffTo))) return null;
  const c = concept(cand.conceptId, input.league);
  return {
    action: out.action,
    conceptId: cand.conceptId,
    depth: cand.depth,
    spoken: out.spoken,
    shortSpoken: c.short,
    card: out.card,
    cheat: out.cheat,
    ...(out.action === 'handoff' ? { handoffTo: out.handoffTo } : {}),
    ...(out.fanNote ? { fanNote: out.fanNote } : {}),
    source: 'llm',
  };
}

/** One Director turn (BUILD_PROMPT 8.2). Falls back to the template on timeout, bad JSON, or a rule violation. */
export async function directorTurn(llm: LLM, input: DirectorInput, home: string, away: string): Promise<DirectorDecision> {
  const fallback = templateDecision(input.candidates, input.handoffs, input.play.penalty?.conceptId === 'penalty_other' ? input.play.penalty.rawType : undefined, input.league);
  if (!input.candidates.length) return { action: 'silent', source: 'fallback' };
  const res = await llm.json({
    task: 'director', model: 'smart', system: DIRECTOR_SYSTEM,
    user: directorUserMessage(input, home, away),
    schema: DirectorOut, timeoutMs: 4000, temperature: 0.4,
    fallback: () => ({ action: 'explain' as const, conceptId: '__template__' }),
  });
  if (res.source === 'fallback') return fallback;
  const v = validateDecision(res.value, input);
  if (!v) return fallback;
  // F5: the explanation follows every reveal, so a flag never ends in silence.
  if (v.action === 'silent' && input.trigger === 'penalty') return fallback;
  return { ...v, source: res.source } as DirectorDecision;
}
