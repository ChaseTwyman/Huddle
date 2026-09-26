import type { League, TeamInfo, TimelinePlay } from '../../shared/types';
import { teamOf } from '../../shared/teams';
import { concept } from '../data/concepts';
import { ballOn, downDistance } from '../data/timeline';
import type { LLM } from '../ai/llm';
import { DIRECTOR_SYSTEM } from '../ai/prompts';
import { DirectorOut, words } from '../ai/schemas';
import type { IntelFact, SituationIntel } from '../intel/types';
import type { Candidate, Trigger } from './scheduler';
import {
  INSIGHT_MAX_WORDS, INSIGHT_WEIGHT, insightCard, insightFromFact, insightSource, templateDecision, type DirectorDecision,
} from './templates';

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
  home?: string;
  away?: string;
  /**
   * Game intelligence for this play, already filtered by the room (spoiler-safe for the stage, and without
   * facts the room has already said). Absent = rules only, as before.
   */
  intel?: { situation: SituationIntel; facts: IntelFact[] };
};

export function situation(play: TimelinePlay, home: string, away: string, teams?: Record<string, TeamInfo>) {
  const score = `${teamOf(away, teams).city} ${play.scoreAfter.away}, ${teamOf(home, teams).city} ${play.scoreAfter.home}`;
  return {
    quarter: play.qtr, clock: play.clock, score,
    possession: play.posteam ? teamOf(play.posteam, teams).city : null,
    downAndDistance: downDistance(play), ballOn: ballOn(play),
  };
}

/** Every intel fact offered this turn (situation first), one per id. */
export function intelFacts(input: DirectorInput): IntelFact[] {
  if (!input.intel) return [];
  const seen = new Set<string>();
  return [...input.intel.situation.facts, ...input.intel.facts].filter((f) => !seen.has(f.id) && seen.add(f.id));
}

/**
 * Rule candidates the Director may explain. When the decision was routine (situation.obvious), explaining it is
 * the "teams usually punt here" line the family found obvious: decision concepts drop out, and a decision-result
 * turn keeps no rule at all (silent unless an insight exists).
 */
export function ruleCandidates(input: DirectorInput): Candidate[] {
  if (!input.intel?.situation.obvious) return input.candidates;
  if (input.trigger === 'decision') return [];
  return input.candidates.filter((c) => concept(c.conceptId, input.league).category !== 'decision');
}

const inPlay = (f: IntelFact, play: TimelinePlay) => {
  const people = new Set(Object.values(play.players).filter(Boolean));
  return f.about.some((a) => people.has(a));
};

/**
 * Facts interesting enough to say on their own, best first: a situation fact when the numbers are a surprise,
 * then facts about the players in this play, then other strong situation facts. Team-only kb facts are left to
 * the model (the retriever returns them on every play, so saying them verbatim would be filler).
 */
export function insightPool(input: DirectorInput): IntelFact[] {
  const intel = input.intel;
  if (!intel) return [];
  const sitIds = new Set(intel.situation.facts.map((f) => f.id));
  const ok = (f: IntelFact) => f.weight >= INSIGHT_WEIGHT && words(f.text) > 0 && words(f.text) <= INSIGHT_MAX_WORDS
    // Routine decision: its math is not worth saying either.
    && !(intel.situation.obvious && !intel.situation.surprise && f.kind === 'decision');
  const rank = (f: IntelFact) => {
    if (sitIds.has(f.id) && intel.situation.surprise) return 0;
    if (inPlay(f, input.play)) return 1;
    if (sitIds.has(f.id)) return 2;
    return -1;
  };
  return intelFacts(input)
    .filter((f) => ok(f) && rank(f) >= 0)
    .sort((a, b) => rank(a) - rank(b) || b.weight - a.weight);
}

/**
 * Template turn (no model, or the model failed): after a flag the rule comes first (F5: the explanation follows
 * the reveal); otherwise an unused strong fact, said verbatim, beats yet another rule reminder.
 */
export function templateTurn(input: DirectorInput): DirectorDecision {
  const rules = ruleCandidates(input);
  const pool = insightPool(input);
  const rule = () => templateDecision(rules, input.handoffs, input.play.penalty?.conceptId === 'penalty_other' ? input.play.penalty.rawType : undefined, input.league);
  if (input.trigger === 'penalty' && rules.length) return rule();
  // A rule the room has never heard (full depth) comes before color: learning is the point (F8's fade measures
  // it). Insights replace reminders, not first explanations.
  // Exception: a surprise in the numbers (the coach went against the math) is the story of the play.
  if (rules[0]?.depth === 'full' && !input.intel?.situation.surprise) return rule();
  if (pool.length) return insightFromFact(pool[0]);
  return rule();
}

/** The Director's user message. Only spoiler-safe fields: public play text, and the announcement once made. */
export function directorUserMessage(input: DirectorInput, home: string, away: string): string {
  const { play } = input;
  const intel = input.intel;
  const msg = {
    event: input.trigger === 'penalty' ? 'penalty_announced' : input.trigger === 'decision' ? 'decision_result' : 'dead_time',
    situation: situation(play, home, away, input.teams),
    league: input.league === 'college' ? 'college football' : 'NFL',
    play: {
      description: play.publicDesc,
      ...(input.announced && play.penalty ? { refereeAnnouncement: play.penalty.announcement } : {}),
    },
    candidates: ruleCandidates(input).map((c) => {
      const card = concept(c.conceptId, input.league);
      return {
        conceptId: c.conceptId, name: card.name, roomLevel: c.roomLevel,
        ruleCard: { full: card.full, short: card.short, ...(card.detail ? { detail: card.detail } : {}) },
      };
    }),
    handoffCandidates: Object.entries(input.handoffs).flatMap(([conceptId, ids]) => ids.map((playerId) => ({ playerId, name: input.names[playerId], conceptId }))),
    playerFacts: input.playerFacts,
    ...(intel ? {
      intel: {
        obvious: intel.situation.obvious, surprise: intel.situation.surprise,
        facts: intelFacts(input).map((f) => ({ id: f.id, kind: f.kind, text: f.text, weight: Math.round(f.weight * 100) / 100 })),
      },
    } : {}),
    recentLines: input.recentLines.slice(-5),
    budget: input.budget,
  };
  return JSON.stringify(msg, null, 1);
}

// Numbers like 35, 1:54, 62.5, 1,000. Ordinals ("3rd") match on their digits.
const NUMBER = /\d+(?:[.,:]\d+)*/g;
// A capitalized word that doesn't start a sentence: a likely name.
const NAME = /(?<![.!?]\s|^|["“])\b[A-Z][A-Za-z'’.-]*[A-Za-z]/g;

/** Text an insight may draw numbers and names from: the cited facts, the play, the situation, and the room. */
function groundText(input: DirectorInput, cited: IntelFact[]): string {
  const { play } = input;
  const home = input.home ?? '';
  const away = input.away ?? '';
  const teams = [play.posteam, play.defteam, home, away].filter((t): t is string => !!t).map((t) => teamOf(t, input.teams));
  return [
    ...cited.map((f) => f.text),
    play.publicDesc,
    input.announced && play.penalty ? play.penalty.announcement : '',
    JSON.stringify(situation(play, home, away, input.teams)),
    ...teams.flatMap((t) => [t.abbr, t.city, t.name]),
    ...Object.values(input.names),
    'Huddle',
  ].join(' \n ');
}

/** Numbers and names in `spoken` that none of the grounding text contains (empty = grounded). */
export function ungrounded(spoken: string, ground: string): string[] {
  const nums = new Set(ground.match(NUMBER) ?? []);
  const lower = ground.toLowerCase();
  const bad = (spoken.match(NUMBER) ?? []).filter((n) => !nums.has(n));
  for (const w of spoken.match(NAME) ?? []) {
    const name = w.replace(/['’]s$/, '').replace(/\.$/, '');
    if (!lower.includes(name.toLowerCase())) bad.push(name);
  }
  return bad;
}

/** Check an LLM decision against the rules; returns null if it must be replaced by the template. */
export function validateDecision(out: DirectorOut, input: DirectorInput): DirectorDecision | null {
  if (out.action === 'silent') return { action: 'silent', source: 'llm' };
  if (out.fanNote && out.fanNote.length > 200) return null;
  const offered = new Map(intelFacts(input).map((f) => [f.id, f]));
  const cites = out.cites ?? [];
  if (cites.some((id) => !offered.has(id))) return null;
  if (out.card && (out.card.title.length > 40 || out.card.body.length > 280)) return null;

  if (out.action === 'insight') {
    // Uncited = unsourced: an insight must rest on facts we handed the model, and say nothing beyond them.
    const cited = [...new Set(cites)].map((id) => offered.get(id)!);
    if (!cited.length || cited.length > 2 || !out.spoken) return null;
    const n = words(out.spoken);
    if (n === 0 || n > INSIGHT_MAX_WORDS) return null;
    if (ungrounded(out.spoken, groundText(input, cited)).length) return null;
    if (input.recentLines.some((l) => l.trim().toLowerCase() === out.spoken!.trim().toLowerCase())) return null;
    return {
      action: 'insight', spoken: out.spoken, card: out.card ?? insightCard(cited), cites: cited.map((f) => f.id),
      sourceNote: insightSource(cited), ...(out.fanNote ? { fanNote: out.fanNote } : {}), source: 'llm',
    };
  }

  const cand = ruleCandidates(input).find((c) => c.conceptId === out.conceptId);
  if (!cand || !out.spoken || !out.card || !out.cheat) return null;
  const limit = cand.depth === 'full' ? 28 : 12;
  if (words(out.spoken) > limit || words(out.spoken) === 0) return null;
  if (out.cheat.length > 120) return null;
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
    ...(cites.length ? { cites: [...new Set(cites)] } : {}),
    source: 'llm',
  };
}

/** One Director turn (BUILD_PROMPT 8.2). Falls back to the template on timeout, bad JSON, or a rule violation. */
/**
 * `timeoutMs`: 4 s when called at dead time (F6). The room may start the call earlier, at the play's result, with a
 * longer limit (a reasoning model needs ~5-6 s with intel), and still waits at most 4 s at dead time.
 */
export async function directorTurn(llm: LLM, input: DirectorInput, home: string, away: string, timeoutMs = 4000): Promise<DirectorDecision> {
  input = { ...input, home, away };
  // Nothing to explain and nothing worth saying: stay silent without calling the model (BUILD_PROMPT 8.1.5).
  if (!ruleCandidates(input).length && !insightPool(input).length) return { action: 'silent', source: 'fallback' };
  const fallback = templateTurn(input);
  const res = await llm.json({
    task: 'director', model: 'smart', system: DIRECTOR_SYSTEM,
    user: directorUserMessage(input, home, away),
    schema: DirectorOut, timeoutMs, temperature: 0.4,
    fallback: () => ({ action: 'explain' as const, conceptId: '__template__' }),
  });
  if (res.source === 'fallback') return fallback;
  const v = validateDecision(res.value, input);
  if (!v) return fallback;
  // F5: the explanation follows every reveal, so a flag never ends in silence (or in color instead of the rule).
  if (input.trigger === 'penalty' && (v.action === 'silent' || (v.action === 'insight' && ruleCandidates(input).length))) return fallback;
  return { ...v, source: res.source } as DirectorDecision;
}
